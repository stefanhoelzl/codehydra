/**
 * AutoUpdaterModule - Lifecycle module for auto-update checking, download, and install.
 *
 * Hooks:
 * - app:start -> "check-deps": check for updates, store detectedVersion, return updateNeedsChoice
 * - app:start -> "start": start auto-updater
 * - update-apply -> "show-choice": emit show-choice UI event (no-op when no update detected)
 * - update-apply -> "download": download update, report progress, handle cancel (no-op when no update detected)
 * - update-apply -> "install": dispatch app:shutdown with installUpdate (no-op when no update detected)
 * - app:resume -> "resume": re-check for updates; ask=notify, always=silent-download+notify
 * - app:shutdown -> "stop": dispose auto-updater
 * - app:shutdown -> "quit": quitAndInstall if installUpdate flag is set
 *
 * Interceptor:
 * - Rejects app:update if config="never"
 */

import type { IntentModule } from "../intents/lib/module";
import type { IntentInterceptor } from "../intents/lib/dispatcher";
import type { Intent } from "../intents/lib/types";
import type { HookContext } from "../intents/lib/operation";
import { APP_START_OPERATION_ID, type CheckDepsResult } from "../intents/app-start";
import { APP_SHUTDOWN_OPERATION_ID, type AppShutdownIntent } from "../intents/app-shutdown";
import { APP_RESUME_OPERATION_ID, APP_RESUME_HOOK_RESUME } from "../intents/app-resume";
import { INTENT_UPDATE_AVAILABLE, type UpdateAvailableIntent } from "../intents/update-available";
import {
  UPDATE_APPLY_OPERATION_ID,
  INTENT_UPDATE_APPLY,
  type UpdateApplyHookContext,
  type UpdateDownloadResult,
  type UpdateChoiceResult,
} from "../intents/update-apply";
import { INTENT_APP_SHUTDOWN } from "../intents/app-shutdown";
import { configEnum } from "../boundaries/platform/config-definition";
import type { AutoUpdatePreference } from "../boundaries/platform/config-values";
import type { Config } from "../boundaries/platform/config";
import type { AutoUpdater } from "./auto-updater";
import type { Dispatcher } from "../intents/lib/dispatcher";
import type { DialogManager } from "./dialog-manager";
import type { NotificationManager } from "./notification-manager";
import type { DialogConfig, DialogSection, DialogAction } from "../shared/dialog-types";

/** Timeout for update check during startup (ms). */
const UPDATE_CHECK_TIMEOUT_MS = 15_000;

/**
 * Build dialog config for update choice.
 */
function buildChoiceConfig(version: string): DialogConfig {
  const sections: DialogSection[] = [
    { type: "text", content: "Update Available", style: "heading" },
    { type: "text", content: `Version ${version} is ready to install.` },
  ];
  const actions: DialogAction[] = [
    { id: "always", label: "Always", variant: "secondary" },
    { id: "yes", label: "Yes" },
    { id: "skip", label: "Skip", variant: "secondary" },
    { id: "never", label: "Never", variant: "secondary" },
  ];
  return { sections, actions, modal: true };
}

/**
 * Build dialog config for download progress.
 */
function buildDownloadConfig(version: string, percent: number): DialogConfig {
  const sections: DialogSection[] = [
    { type: "text", content: "Downloading Update", style: "heading" },
    {
      type: "progress",
      items: [
        {
          id: "download",
          label: `Version ${version}`,
          status: "running",
          progress: percent,
          message: `${Math.round(percent)}%`,
        },
      ],
    },
  ];
  const actions: DialogAction[] = [{ id: "cancel", label: "Cancel", variant: "secondary" }];
  return { sections, actions, modal: true };
}

interface AutoUpdaterModuleDeps {
  readonly autoUpdater: AutoUpdater;
  readonly dispatcher: Dispatcher;
  readonly dialogManager: DialogManager;
  readonly configService: Config;
  readonly notificationManager: NotificationManager;
}

export function createAutoUpdaterModule(deps: AutoUpdaterModuleDeps): IntentModule {
  let detectedVersion: string | null = null;
  let checkInProgress = false;

  // Register config key
  deps.configService.register("auto-update", {
    name: "auto-update",
    default: "ask" as AutoUpdatePreference,
    description: "Auto-update preference",
    ...configEnum(["always", "ask", "never"]),
  });

  // Interceptor: reject app:update if config="never"
  const interceptor: IntentInterceptor = {
    id: "auto-updater-gate",
    async before(intent: Intent): Promise<Intent | null> {
      if (intent.type !== INTENT_UPDATE_APPLY) return intent;
      const autoUpdate = deps.configService.get("auto-update") as AutoUpdatePreference;
      if (autoUpdate === "never") return null;
      return intent;
    },
  };

  return {
    name: "auto-updater",
    interceptors: [interceptor],
    hooks: {
      [APP_START_OPERATION_ID]: {
        "check-deps": {
          handler: async (): Promise<CheckDepsResult> => {
            // Register detected callback BEFORE checking, to avoid race condition
            // (update-available event fires during checkForUpdates)
            const versionPromise = new Promise<string | null>((resolve) => {
              const timeout = setTimeout(() => resolve(null), UPDATE_CHECK_TIMEOUT_MS);
              const unsub = deps.autoUpdater.onUpdateDetected((version) => {
                clearTimeout(timeout);
                unsub();
                resolve(version);
              });

              // Start the check — fires onUpdateDetected if update found
              deps.autoUpdater.checkForUpdates().then(
                (found) => {
                  if (!found) {
                    clearTimeout(timeout);
                    unsub();
                    resolve(null);
                  }
                },
                () => {
                  clearTimeout(timeout);
                  unsub();
                  resolve(null);
                }
              );
            });

            detectedVersion = await versionPromise;
            const autoUpdate = deps.configService.get("auto-update") as AutoUpdatePreference;

            return {
              updateNeedsChoice: autoUpdate === "ask" && detectedVersion !== null,
            };
          },
        },
        start: {
          handler: async (): Promise<void> => {
            deps.autoUpdater.start();

            // Wire auto-updater to dispatch update:available intent (for window title backup)
            deps.autoUpdater.onUpdateDownloaded((version: string) => {
              void deps.dispatcher.dispatch({
                type: INTENT_UPDATE_AVAILABLE,
                payload: { version },
              } as UpdateAvailableIntent);
            });

            // Capture detected version from update-available events (for late detection)
            deps.autoUpdater.onUpdateDetected((version: string) => {
              detectedVersion = version;
            });
          },
        },
      },
      [UPDATE_APPLY_OPERATION_ID]: {
        "show-choice": {
          handler: async (ctx: HookContext): Promise<void> => {
            if (detectedVersion === null) return;
            const { report } = ctx as UpdateApplyHookContext;
            report("show-choice", 0, detectedVersion);
          },
        },
        "await-choice": {
          handler: async (): Promise<UpdateChoiceResult> => {
            if (detectedVersion === null) return {};
            const config = buildChoiceConfig(detectedVersion);
            const handle = deps.dialogManager.open(config);
            const event = await handle.nextEvent(5 * 60_000);
            handle.close();

            // Map action IDs to update choice values
            const choiceMap: Record<string, "always" | "yes" | "skip" | "never"> = {
              always: "always",
              yes: "yes",
              skip: "skip",
              never: "never",
            };
            const choice = choiceMap[event.actionId];
            return choice ? { choice } : {};
          },
        },
        download: {
          handler: async (ctx: HookContext): Promise<UpdateDownloadResult> => {
            if (detectedVersion === null) return {};
            const { report } = ctx as UpdateApplyHookContext;
            const version = detectedVersion;
            report("downloading", 0, version);

            // Open download dialog
            const config = buildDownloadConfig(version, 0);
            const handle = deps.dialogManager.open(config);

            // Wire progress reporting
            const unsubProgress = deps.autoUpdater.onDownloadProgress((info) => {
              report("progress", info.percent, version);
              handle.update(buildDownloadConfig(version, info.percent));
            });

            // Listen for cancel via dialog events
            let cancelled = false;
            const unsubEvent = handle.onEvent((evt) => {
              if (evt.actionId === "cancel") {
                cancelled = true;
                deps.autoUpdater.cancelDownload();
              }
            });

            checkInProgress = true;
            try {
              await deps.autoUpdater.downloadUpdate();
            } catch {
              // Download failed or was cancelled
              handle.close();
              if (cancelled) {
                report("downloading", 0, version, true);
                return { cancelled: true };
              }
              // Non-cancel failure — hide UI and continue startup
              report("downloading", 0, version, true);
              return { cancelled: true };
            } finally {
              checkInProgress = false;
              unsubProgress();
              unsubEvent();
            }

            handle.close();

            if (cancelled) {
              report("downloading", 0, version, true);
              return { cancelled: true };
            }

            return {};
          },
        },
        install: {
          handler: async (): Promise<void> => {
            if (detectedVersion === null) return;
            await deps.dispatcher.dispatch({
              type: INTENT_APP_SHUTDOWN,
              payload: { installUpdate: true },
            });
          },
        },
      },
      [APP_RESUME_OPERATION_ID]: {
        [APP_RESUME_HOOK_RESUME]: {
          handler: async (): Promise<void> => {
            const autoUpdate = deps.configService.get("auto-update") as AutoUpdatePreference;
            if (autoUpdate === "never") return;
            if (checkInProgress) return;
            // Already detected (dialog shown at startup, or prior resume notified).
            // "Never re-show until restart" — fresh session resets state.
            if (detectedVersion !== null) return;

            checkInProgress = true;
            try {
              await deps.autoUpdater.checkForUpdates();
            } finally {
              checkInProgress = false;
            }

            const version = detectedVersion;
            if (version === null) return;

            if (autoUpdate === "always") {
              checkInProgress = true;
              try {
                await deps.autoUpdater.downloadUpdate();
              } catch {
                return;
              } finally {
                checkInProgress = false;
              }
              deps.notificationManager.open({
                type: "info",
                title: "Update ready",
                message: `Version ${version} will be installed on next restart.`,
                dismissible: true,
              });
            } else {
              deps.notificationManager.open({
                type: "info",
                title: "Update available",
                message: `Version ${version} will be offered at next startup.`,
                dismissible: true,
              });
            }
          },
        },
      },
      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async () => {
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
