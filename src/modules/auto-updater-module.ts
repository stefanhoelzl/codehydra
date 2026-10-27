/**
 * AutoUpdaterModule - Notification-driven update checking, download, and install.
 *
 * Hooks:
 * - app:start -> "start": register update-detected callback, run a background
 *                check and schedule periodic ones.
 * - app:resume -> "resume": run a check (same logic as periodic tick).
 * - app:shutdown -> "stop": clear timer, dispose auto-updater.
 * - app:shutdown -> "quit": quitAndInstall if installUpdate flag is set.
 *
 * Behavior (`update`, read by every check — a change applies at the next one):
 * - off: no checks; a check that finds the mode off closes an open
 *   "available"/"error" card (a running download and "ready" stay).
 * - notify: the flow below.
 * - auto: the flow below with the Install click done for the user — a detected
 *   version downloads straight away (progress card, then "Update ready"). A
 *   failed download shows the error card and the next check retries it, until
 *   the user dismisses that card. Earlier dismissals do not hold back a download.
 *
 * - All update flow happens via one sidebar card (`notification:show`) that
 *   always reflects the latest pending version (electron-updater only ever
 *   reports feed-latest, so any detected version that differs from the one we
 *   are currently showing is treated as newer).
 * - First detected version surfaces "Update available" notification.
 * - User clicks "Install" (or "Always download", which also switches
 *   `update` to auto) → the card is replaced by a progress bar while the
 *   download runs → on completion by "Update ready / Restart Now". A click
 *   closes a card, so each stage that asks something is a fresh question.
 *   Without the click, a clean quit installs the download too (the
 *   AutoUpdater's autoInstallOnAppQuit), so a manual restart lands on it.
 * - Download failures swap to an error notification with a Retry action.
 * - Re-checks (periodic timer, app:resume, immediately after a download
 *   completes) keep running. When a newer version is detected, the single
 *   notification refreshes to "Update available" for that version — including
 *   reverting a "ready" notification so one "Restart Now" always lands on
 *   newest (a plain quit meanwhile still installs the older download).
 * - Dismiss = silent for that version, persisted via `update.dismissed-version`
 *   so it stays silent across restarts. A genuinely newer version re-surfaces.
 * - A check is skipped while a download is in progress; the check fired right
 *   after the download completes catches anything released mid-download.
 */

import type { IntentModule } from "../intents/lib/module";
import { APP_START_OPERATION_ID } from "../intents/app-start";
import { APP_SHUTDOWN_OPERATION_ID } from "../intents/app-shutdown";
import { APP_RESUME_OPERATION_ID, APP_RESUME_HOOK_RESUME } from "../intents/app-resume";
import { INTENT_APP_SHUTDOWN } from "../intents/app-shutdown";
import { storeEnum, storeString } from "../boundaries/platform/store-definition";
import type { Config } from "../boundaries/platform/config";
import type { StateService } from "../boundaries/platform/state-service";
import type { AutoUpdater } from "./auto-updater";
import type { Dispatcher } from "../intents/lib/dispatcher";
import { NotificationCard } from "./presentation/notification-card";
import type { NotificationConfig } from "../shared/notification-types";
import { defineHooks } from "../intents/declarations";

/** How often to re-check for updates while the app is running. */
const PERIODIC_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

interface AutoUpdaterModuleDeps {
  readonly autoUpdater: AutoUpdater;
  readonly dispatcher: Dispatcher;
  readonly configService: Config;
  /** Persisted app state (state.json) — owns the dismissed-version bookkeeping. */
  readonly stateService: StateService;
}

const UPDATE_MODES = ["off", "notify", "auto"] as const;
type UpdateMode = (typeof UPDATE_MODES)[number];

/** `update.notification` (boolean) in config.json became `update`. */
function modeFromNotification(value: unknown): UpdateMode | undefined {
  if (value === true) return "notify";
  if (value === false) return "off";
  return undefined;
}

function availableConfig(version: string): NotificationConfig {
  return {
    type: "info",
    title: "Update available",
    message: `Version ${version} is ready to download.`,
    dismissible: true,
    actions: [
      { id: "install", label: "Install" },
      { id: "always", label: "Always download" },
    ],
  };
}

function downloadingConfig(version: string, percent: number): NotificationConfig {
  return {
    type: "spinner",
    title: "Downloading update",
    message: `Version ${version}`,
    progress: Math.max(0, Math.min(1, percent / 100)),
    dismissible: false,
  };
}

function readyConfig(version: string): NotificationConfig {
  return {
    type: "info",
    title: "Update ready",
    message: `Version ${version} will be installed when CodeHydra quits.`,
    dismissible: false,
    actions: [{ id: "restart", label: "Restart Now" }],
  };
}

function errorConfig(version: string): NotificationConfig {
  return {
    type: "error",
    title: "Update failed",
    message: `Could not download version ${version}.`,
    dismissible: true,
    actions: [{ id: "retry", label: "Retry" }],
  };
}

type NotificationState = "none" | "available" | "downloading" | "ready" | "error";

export function createAutoUpdaterModule(deps: AutoUpdaterModuleDeps): IntentModule {
  // Latest version reported by electron-updater's update-detected callback.
  let lastDetectedVersion: string | null = null;
  // The version the current notification represents (read by action handlers).
  let targetVersion: string | null = null;
  // The version the user last dismissed; same-version re-checks stay silent.
  let dismissedVersion: string | null = null;
  // The version whose failed download the user dismissed in auto mode: auto
  // stops retrying it (until restart); a newer version downloads again.
  let abandonedVersion: string | null = null;
  let notificationState: NotificationState = "none";
  let checkInProgress = false;
  let downloadInProgress = false;
  let periodicTimer: NodeJS.Timeout | null = null;
  // The one sidebar card the whole flow runs through. A button click closes it,
  // so each stage that asks something (available, ready, error) is a fresh
  // question on it; the download stage between them is a plain progress card.
  const card = new NotificationCard(deps.dispatcher);
  // Bumped on every question, so an answer to a question the card has since
  // replaced (a newer version arrived while it was up) is ignored. The
  // replaced question's waiter is answered by the same click as the new one.
  let questionSeq = 0;

  // Register config keys
  const updateModeConfig = deps.configService.register("update", {
    default: "notify",
    description:
      "Updates: off = never check, notify = ask before downloading, auto = download without asking (installs on quit)",
    applies: "live",
    ...storeEnum(UPDATE_MODES),
    legacyNames: { "update.notification": modeFromNotification },
  });
  // App-written bookkeeping (not user config): persisted in state.json so a
  // dismissed update stays silent across restarts; a genuinely newer version
  // still re-surfaces (reconcile compares against this value).
  const dismissedVersionState = deps.stateService.register("update.dismissed-version", {
    default: null,
    description:
      "The update version the user last dismissed (silences re-notification across restarts)",
    ...storeString({ nullable: true }),
  });

  function mode(): UpdateMode {
    return updateModeConfig.get();
  }

  /** Put a question on the card and act on the answer (unless it is superseded). */
  function ask(config: NotificationConfig): void {
    const seq = ++questionSeq;
    void card.ask(config).then((choice) => {
      if (seq === questionSeq) handleChoice(choice);
    });
  }

  /**
   * The user answered the card. `null` is the dismiss: nothing else closes this
   * card without an answer — it is not attached to a workspace, has no timeout,
   * and every replaced question is filtered out above.
   */
  function handleChoice(choice: string | null): void {
    if (choice === "always") {
      void updateModeConfig.set("auto");
    }
    if (choice === "install" || choice === "retry" || choice === "always") {
      if (targetVersion !== null) startDownload(targetVersion);
      return;
    }
    if (choice === "restart") {
      notificationState = "none";
      void deps.dispatcher.dispatch({
        type: INTENT_APP_SHUTDOWN,
        payload: { installUpdate: true },
      });
      return;
    }
    if (choice === null) {
      if (notificationState === "error" && mode() === "auto") abandonedVersion = targetVersion;
      notificationState = "none";
      dismissedVersion = targetVersion;
      void dismissedVersionState.set(targetVersion);
    }
  }

  function startDownload(version: string): void {
    if (downloadInProgress) return;
    downloadInProgress = true;
    notificationState = "downloading";

    // A plain card: nothing to answer while the download runs.
    questionSeq++;
    card.show(downloadingConfig(version, 0));

    const unsubProgress = deps.autoUpdater.onDownloadProgress((info) => {
      card.show(downloadingConfig(version, info.percent));
    });

    deps.autoUpdater.downloadUpdate().then(
      () => {
        unsubProgress();
        downloadInProgress = false;
        notificationState = "ready";
        ask(readyConfig(version));
        // Catch a version released while this download was running.
        void runCheck();
      },
      () => {
        unsubProgress();
        downloadInProgress = false;
        notificationState = "error";
        ask(errorConfig(version));
      }
    );
  }

  /**
   * Open or update the single notification to surface `version` as available.
   * Reverts a "ready"/"error" notification and refreshes an existing
   * "available" one so the notification always reflects the latest version.
   */
  function showAvailableNotification(version: string): void {
    notificationState = "available";
    ask(availableConfig(version));
  }

  /**
   * Reconcile a freshly detected version against what we are currently showing.
   * electron-updater only reports feed-latest, so a version that differs from
   * the one on screen (or the one the user dismissed) is necessarily newer.
   */
  function reconcile(version: string): void {
    // A download is running; the post-download check will reconcile.
    if (notificationState === "downloading") return;

    if (mode() === "auto") {
      // Downloaded already, or its failure was dismissed: nothing to do.
      if (notificationState === "ready" && version === targetVersion) return;
      if (version === abandonedVersion) return;
      targetVersion = version;
      startDownload(version);
      return;
    }

    // Already showing this exact version — nothing changed.
    if (notificationState !== "none" && version === targetVersion) return;
    // User dismissed this exact version and nothing newer has appeared.
    if (notificationState === "none" && version === dismissedVersion) return;

    targetVersion = version;
    showAvailableNotification(version);
  }

  /** Mode is off: take down a card that still asks about an update. */
  function closeQuestion(): void {
    if (notificationState !== "available" && notificationState !== "error") return;
    notificationState = "none";
    // Not an answer: the closed question's waiter must not count as a dismiss.
    questionSeq++;
    card.close();
  }

  async function runCheck(): Promise<void> {
    if (mode() === "off") {
      closeQuestion();
      return;
    }
    if (checkInProgress || downloadInProgress) return;

    checkInProgress = true;
    let found: boolean;
    try {
      found = await deps.autoUpdater.checkForUpdates();
    } finally {
      checkInProgress = false;
    }

    if (found && lastDetectedVersion !== null) {
      reconcile(lastDetectedVersion);
    }
  }

  return {
    name: "auto-updater",
    hooks: defineHooks({
      [APP_START_OPERATION_ID]: {
        start: {
          handler: async (): Promise<void> => {
            // Restore the last dismissed version so an update the user already
            // dismissed stays silent across restarts.
            dismissedVersion = dismissedVersionState.get();

            // Persistent callback captures the version whenever electron-updater
            // fires `update-available`. checkForUpdates() also returns the
            // boolean result; the callback simply ensures we always have the
            // version string.
            deps.autoUpdater.onUpdateDetected((version: string) => {
              lastDetectedVersion = version;
            });

            // Fire-and-forget background check at startup. Notification appears
            // later if an update is found; startup is never blocked.
            void runCheck();

            // Periodic re-check while the app runs, whatever the mode: each
            // tick reads it, so a mode changed meanwhile applies there.
            // Cleared on shutdown.
            periodicTimer = setInterval(() => {
              void runCheck();
            }, PERIODIC_CHECK_INTERVAL_MS);
          },
        },
      },
      [APP_RESUME_OPERATION_ID]: {
        [APP_RESUME_HOOK_RESUME]: {
          handler: async (): Promise<void> => {
            await runCheck();
          },
        },
      },
      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async () => {
            if (periodicTimer !== null) {
              clearInterval(periodicTimer);
              periodicTimer = null;
            }
            deps.autoUpdater.dispose();
          },
        },
        // After every "stop" handler, so the installer (or the relaunched
        // AppImage) never races our teardown; before "quit", whose own
        // app.quit() would otherwise install without the restart.
        handoff: {
          handler: async (ctx) => {
            const { intent } = ctx;
            if (intent.payload.installUpdate) {
              deps.autoUpdater.quitAndInstall();
            }
          },
        },
      },
    }),
  };
}
