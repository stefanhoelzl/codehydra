/**
 * AutoUpdaterModule - Lifecycle module for auto-update checking, download, and install.
 *
 * Hooks:
 * - app:start -> "register-config": register auto-update config with default "ask"
 * - app:start -> "check-deps": check for updates, store detectedVersion, return updateNeedsChoice
 * - app:start -> "start": start auto-updater
 * - update-apply -> "show-choice": emit show-choice UI event
 * - update-apply -> "download": download update, report progress, handle cancel
 * - update-apply -> "install": dispatch app:shutdown with installUpdate
 * - app:shutdown -> "stop": dispose auto-updater
 * - app:shutdown -> "quit": quitAndInstall if installUpdate flag is set
 *
 * Interceptor:
 * - Rejects app:update if config="never" or no update detected
 *
 * Events:
 * - config:updated: tracks auto-update preference
 */

import type { IntentModule } from "../intents/infrastructure/module";
import type { IntentInterceptor } from "../intents/infrastructure/dispatcher";
import type { Intent, DomainEvent } from "../intents/infrastructure/types";
import type { HookContext } from "../intents/infrastructure/operation";
import type { IpcEventHandler, IpcLayer } from "../../services/platform/ipc";
import {
  APP_START_OPERATION_ID,
  type RegisterConfigResult,
  type CheckDepsResult,
} from "../operations/app-start";
import { APP_SHUTDOWN_OPERATION_ID, type AppShutdownIntent } from "../operations/app-shutdown";
import {
  INTENT_UPDATE_AVAILABLE,
  type UpdateAvailableIntent,
} from "../operations/update-available";
import {
  UPDATE_APPLY_OPERATION_ID,
  INTENT_UPDATE_APPLY,
  type UpdateApplyHookContext,
  type UpdateDownloadResult,
} from "../operations/update-apply";
import { INTENT_APP_SHUTDOWN } from "../operations/app-shutdown";
import { EVENT_CONFIG_UPDATED, type ConfigUpdatedPayload } from "../operations/config-set-values";
import { configEnum } from "../../services/config/config-definition";
import type { AutoUpdatePreference } from "../../services/config/config-values";
import type { AutoUpdater } from "../../services/auto-updater";
import type { Dispatcher } from "../intents/infrastructure/dispatcher";
import { ApiIpcChannels } from "../../shared/ipc";

/** Timeout for update check during startup (ms). */
const UPDATE_CHECK_TIMEOUT_MS = 15_000;

interface AutoUpdaterModuleDeps {
  readonly autoUpdater: AutoUpdater;
  readonly dispatcher: Dispatcher;
  readonly ipcLayer: Pick<IpcLayer, "on" | "removeListener">;
}

export function createAutoUpdaterModule(deps: AutoUpdaterModuleDeps): IntentModule {
  let autoUpdate: AutoUpdatePreference = "ask";
  let detectedVersion: string | null = null;

  // Interceptor: reject app:update if config="never" or no update detected
  const interceptor: IntentInterceptor = {
    id: "auto-updater-gate",
    async before(intent: Intent): Promise<Intent | null> {
      if (intent.type !== INTENT_UPDATE_APPLY) return intent;
      if (autoUpdate === "never" || detectedVersion === null) return null;
      return intent;
    },
  };

  return {
    name: "auto-updater",
    interceptors: [interceptor],
    hooks: {
      [APP_START_OPERATION_ID]: {
        "register-config": {
          handler: async (): Promise<RegisterConfigResult> => ({
            definitions: [
              {
                name: "auto-update",
                default: "ask" as AutoUpdatePreference,
                description: "Auto-update preference",
                ...configEnum(["always", "ask", "never"]),
              },
            ],
          }),
        },
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
            const { report } = ctx as UpdateApplyHookContext;
            report("show-choice", 0, detectedVersion ?? "");
          },
        },
        download: {
          handler: async (ctx: HookContext): Promise<UpdateDownloadResult> => {
            const { report } = ctx as UpdateApplyHookContext;
            const version = detectedVersion ?? "";
            report("downloading", 0, version);

            // Wire progress reporting
            const unsubProgress = deps.autoUpdater.onDownloadProgress((info) => {
              report("progress", info.percent, version);
            });

            // Listen for cancel IPC
            let cancelled = false;
            const cancelHandler: IpcEventHandler = () => {
              cancelled = true;
              deps.autoUpdater.cancelDownload();
            };
            deps.ipcLayer.on(ApiIpcChannels.UPDATE_CANCEL, cancelHandler);

            try {
              await deps.autoUpdater.downloadUpdate();
            } catch {
              // Download failed or was cancelled
              if (cancelled) {
                report("downloading", 0, version, true);
                return { cancelled: true };
              }
              // Non-cancel failure — hide UI and continue startup
              report("downloading", 0, version, true);
              return { cancelled: true };
            } finally {
              unsubProgress();
              deps.ipcLayer.removeListener(ApiIpcChannels.UPDATE_CANCEL, cancelHandler);
            }

            if (cancelled) {
              report("downloading", 0, version, true);
              return { cancelled: true };
            }

            return {};
          },
        },
        install: {
          handler: async (): Promise<void> => {
            await deps.dispatcher.dispatch({
              type: INTENT_APP_SHUTDOWN,
              payload: { installUpdate: true },
            });
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
    events: {
      [EVENT_CONFIG_UPDATED]: (event: DomainEvent) => {
        const { values } = event.payload as ConfigUpdatedPayload;
        if (values["auto-update"] !== undefined) {
          autoUpdate = values["auto-update"] as AutoUpdatePreference;
        }
      },
    },
  };
}
