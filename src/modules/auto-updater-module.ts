/**
 * AutoUpdaterModule - Notification-driven update checking, download, and install.
 *
 * Hooks:
 * - app:start -> "start": register update-detected callback, schedule background +
 *                periodic checks (if update.notification enabled).
 * - app:resume -> "resume": run a check (same logic as periodic tick).
 * - app:shutdown -> "stop": clear timer, dispose auto-updater.
 * - app:shutdown -> "quit": quitAndInstall if installUpdate flag is set.
 *
 * Behavior:
 * - All update flow happens via a single mutating sidebar notification that
 *   always reflects the latest pending version (electron-updater only ever
 *   reports feed-latest, so any detected version that differs from the one we
 *   are currently showing is treated as newer).
 * - First detected version surfaces "Update available" notification.
 * - User clicks "Install" → notification mutates into a progress bar while
 *   download runs → on completion mutates into "Update ready / Restart Now".
 * - Download failures swap to an error notification with a Retry action.
 * - Re-checks (periodic timer, app:resume, immediately after a download
 *   completes) keep running. When a newer version is detected, the single
 *   notification refreshes to "Update available" for that version — including
 *   reverting a "ready" notification so one restart always lands on newest.
 * - Dismiss = silent for that version, persisted via `update.dismissed-version`
 *   so it stays silent across restarts. A genuinely newer version re-surfaces.
 * - A check is skipped while a download is in progress; the check fired right
 *   after the download completes catches anything released mid-download.
 */

import type { IntentModule } from "../intents/lib/module";
import type { HookContext } from "../intents/lib/operation";
import { APP_START_OPERATION_ID } from "../intents/app-start";
import { APP_SHUTDOWN_OPERATION_ID, type AppShutdownIntent } from "../intents/app-shutdown";
import { APP_RESUME_OPERATION_ID, APP_RESUME_HOOK_RESUME } from "../intents/app-resume";
import { INTENT_APP_SHUTDOWN } from "../intents/app-shutdown";
import { configBoolean, configString } from "../boundaries/platform/config-definition";
import type { Config } from "../boundaries/platform/config";
import type { AutoUpdater } from "./auto-updater";
import type { Dispatcher } from "../intents/lib/dispatcher";
import type { NotificationManager, NotificationHandle } from "./notification-manager";
import type { NotificationConfig, NotificationUserEvent } from "../shared/notification-types";

/** How often to re-check for updates while the app is running. */
const PERIODIC_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

interface AutoUpdaterModuleDeps {
  readonly autoUpdater: AutoUpdater;
  readonly dispatcher: Dispatcher;
  readonly configService: Config;
  readonly notificationManager: NotificationManager;
}

function availableConfig(version: string): NotificationConfig {
  return {
    type: "info",
    title: "Update available",
    message: `Version ${version} is ready to download.`,
    dismissible: true,
    actions: [{ id: "install", label: "Install" }],
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
    message: `Version ${version} is ready to install.`,
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
  let notificationState: NotificationState = "none";
  let checkInProgress = false;
  let downloadInProgress = false;
  let periodicTimer: NodeJS.Timeout | null = null;
  let notification: NotificationHandle | null = null;

  // Register config keys
  const updateNotificationConfig = deps.configService.register("update.notification", {
    default: true,
    description: "Show a sidebar notification when an update is available",
    ...configBoolean(),
  });
  // Persisted so a dismissed update stays silent across restarts; a genuinely
  // newer version still re-surfaces (reconcile compares against this value).
  const dismissedVersionConfig = deps.configService.register("update.dismissed-version", {
    default: null,
    description:
      "Internal: the update version the user last dismissed (silences re-notification across restarts)",
    ...configString({ nullable: true }),
  });

  function isEnabled(): boolean {
    return updateNotificationConfig.get();
  }

  function handleNotificationEvent(event: NotificationUserEvent): void {
    if (event.actionId === "install" || event.actionId === "retry") {
      if (targetVersion !== null) startDownload(targetVersion);
      return;
    }
    if (event.actionId === "restart") {
      notification?.close();
      notification = null;
      notificationState = "none";
      void deps.dispatcher.dispatch({
        type: INTENT_APP_SHUTDOWN,
        payload: { installUpdate: true },
      });
      return;
    }
    if (event.actionId === "dismiss") {
      notification?.close();
      notification = null;
      notificationState = "none";
      dismissedVersion = targetVersion;
      void dismissedVersionConfig.set(targetVersion);
    }
  }

  function startDownload(version: string): void {
    if (downloadInProgress) return;
    downloadInProgress = true;
    notificationState = "downloading";

    if (notification === null) {
      notification = deps.notificationManager.open(downloadingConfig(version, 0));
      notification.onEvent(handleNotificationEvent);
    } else {
      notification.update(downloadingConfig(version, 0));
    }

    const handle = notification;

    const unsubProgress = deps.autoUpdater.onDownloadProgress((info) => {
      handle.update(downloadingConfig(version, info.percent));
    });

    deps.autoUpdater.downloadUpdate().then(
      () => {
        unsubProgress();
        downloadInProgress = false;
        notificationState = "ready";
        handle.update(readyConfig(version));
        // Catch a version released while this download was running.
        void runCheck();
      },
      () => {
        unsubProgress();
        downloadInProgress = false;
        notificationState = "error";
        handle.update(errorConfig(version));
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
    if (notification === null) {
      notification = deps.notificationManager.open(availableConfig(version));
      notification.onEvent(handleNotificationEvent);
    } else {
      notification.update(availableConfig(version));
    }
  }

  /**
   * Reconcile a freshly detected version against what we are currently showing.
   * electron-updater only reports feed-latest, so a version that differs from
   * the one on screen (or the one the user dismissed) is necessarily newer.
   */
  function reconcile(version: string): void {
    // Already showing this exact version — nothing changed.
    if (notificationState !== "none" && version === targetVersion) return;
    // User dismissed this exact version and nothing newer has appeared.
    if (notificationState === "none" && version === dismissedVersion) return;
    // A download is running; the post-download check will reconcile.
    if (notificationState === "downloading") return;

    targetVersion = version;
    showAvailableNotification(version);
  }

  async function runCheck(): Promise<void> {
    if (!isEnabled()) return;
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
    hooks: {
      [APP_START_OPERATION_ID]: {
        start: {
          handler: async (): Promise<void> => {
            // Restore the last dismissed version so an update the user already
            // dismissed stays silent across restarts.
            dismissedVersion = dismissedVersionConfig.get();

            // Persistent callback captures the version whenever electron-updater
            // fires `update-available`. checkForUpdates() also returns the
            // boolean result; the callback simply ensures we always have the
            // version string.
            deps.autoUpdater.onUpdateDetected((version: string) => {
              lastDetectedVersion = version;
            });

            deps.autoUpdater.start();

            if (!isEnabled()) return;

            // Fire-and-forget background check at startup. Notification appears
            // later if an update is found; startup is never blocked.
            void runCheck();

            // Periodic re-check while the app runs. Cleared on shutdown.
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
        quit: {
          handler: async (ctx: HookContext) => {
            const intent = ctx.intent as AppShutdownIntent;
            if (intent.payload.installUpdate) {
              deps.autoUpdater.quitAndInstall();
            }
          },
        },
      },
    },
  };
}
