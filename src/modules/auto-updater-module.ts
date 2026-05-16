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
 * - All update flow happens via a single mutating sidebar notification.
 * - First detected version surfaces "Update available" notification.
 * - User clicks "Install" → notification mutates into a progress bar while
 *   download runs → on completion mutates into "Update ready / Restart Now".
 * - Download failures swap to an error notification with a Retry action.
 * - Once a version was detected and surfaced, no further checks/notifications
 *   happen until the app is restarted (dismiss = silent for this session).
 */

import type { IntentModule } from "../intents/lib/module";
import type { HookContext } from "../intents/lib/operation";
import { APP_START_OPERATION_ID } from "../intents/app-start";
import { APP_SHUTDOWN_OPERATION_ID, type AppShutdownIntent } from "../intents/app-shutdown";
import { APP_RESUME_OPERATION_ID, APP_RESUME_HOOK_RESUME } from "../intents/app-resume";
import { INTENT_APP_SHUTDOWN } from "../intents/app-shutdown";
import { configBoolean } from "../boundaries/platform/config-definition";
import type { Config } from "../boundaries/platform/config";
import type { AutoUpdater } from "./auto-updater";
import type { Dispatcher } from "../intents/lib/dispatcher";
import type { NotificationManager, NotificationHandle } from "./notification-manager";
import type { NotificationConfig } from "../shared/notification-types";

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

export function createAutoUpdaterModule(deps: AutoUpdaterModuleDeps): IntentModule {
  let detectedVersion: string | null = null;
  let surfaced = false;
  let checkInProgress = false;
  let downloadInProgress = false;
  let periodicTimer: NodeJS.Timeout | null = null;
  let notification: NotificationHandle | null = null;

  // Register config key
  deps.configService.register("update.notification", {
    name: "update.notification",
    default: true,
    description: "Show a sidebar notification when an update is available",
    ...configBoolean(),
  });

  function isEnabled(): boolean {
    return deps.configService.get("update.notification") === true;
  }

  function startDownload(version: string): void {
    if (downloadInProgress) return;
    downloadInProgress = true;

    if (notification === null) {
      notification = deps.notificationManager.open(downloadingConfig(version, 0));
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
        handle.update(readyConfig(version));
      },
      () => {
        unsubProgress();
        downloadInProgress = false;
        handle.update(errorConfig(version));
      }
    );
  }

  function showAvailableNotification(version: string): void {
    if (notification !== null) return;

    notification = deps.notificationManager.open(availableConfig(version));
    notification.onEvent((event) => {
      if (event.actionId === "install") {
        startDownload(version);
        return;
      }
      if (event.actionId === "restart") {
        notification?.close();
        notification = null;
        void deps.dispatcher.dispatch({
          type: INTENT_APP_SHUTDOWN,
          payload: { installUpdate: true },
        });
        return;
      }
      if (event.actionId === "retry") {
        startDownload(version);
        return;
      }
      if (event.actionId === "dismiss") {
        notification = null;
      }
    });
  }

  async function runCheck(): Promise<void> {
    if (!isEnabled()) return;
    if (checkInProgress || downloadInProgress) return;
    if (surfaced) return;

    checkInProgress = true;
    try {
      await deps.autoUpdater.checkForUpdates();
    } finally {
      checkInProgress = false;
    }

    if (detectedVersion !== null && !surfaced) {
      surfaced = true;
      showAvailableNotification(detectedVersion);
    }
  }

  return {
    name: "auto-updater",
    hooks: {
      [APP_START_OPERATION_ID]: {
        start: {
          handler: async (): Promise<void> => {
            // Persistent callback captures the version whenever electron-updater
            // fires `update-available`. checkForUpdates() also returns the
            // boolean result; the callback simply ensures we always have the
            // version string.
            deps.autoUpdater.onUpdateDetected((version: string) => {
              detectedVersion = version;
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
