/**
 * AutoUpdaterModule - Lifecycle module for auto-update checking and cleanup.
 *
 * Hooks:
 * - app:start -> "start": starts auto-updater (unless auto-update=never),
 *   wires onUpdateAvailable to dispatch update:available
 * - app:shutdown -> "stop": disposes auto-updater (best-effort)
 *
 * Events:
 * - config:updated: tracks auto-update preference
 */

import type { IntentModule } from "../intents/infrastructure/module";
import type { DomainEvent } from "../intents/infrastructure/types";
import { APP_START_OPERATION_ID, type StartHookResult } from "../operations/app-start";
import { APP_SHUTDOWN_OPERATION_ID } from "../operations/app-shutdown";
import {
  INTENT_UPDATE_AVAILABLE,
  type UpdateAvailableIntent,
} from "../operations/update-available";
import { EVENT_CONFIG_UPDATED, type ConfigUpdatedPayload } from "../operations/config-set-values";
import type { AutoUpdatePreference } from "../../services/config/config-values";
import type { AutoUpdater } from "../../services/auto-updater";
import type { Dispatcher } from "../intents/infrastructure/dispatcher";

interface AutoUpdaterModuleDeps {
  readonly autoUpdater: AutoUpdater;
  readonly dispatcher: Dispatcher;
}

export function createAutoUpdaterModule(deps: AutoUpdaterModuleDeps): IntentModule {
  let autoUpdate: AutoUpdatePreference = "always";

  return {
    name: "auto-updater",
    hooks: {
      [APP_START_OPERATION_ID]: {
        start: {
          handler: async (): Promise<StartHookResult> => {
            if (autoUpdate === "never") {
              return {};
            }

            deps.autoUpdater.start();

            // Wire auto-updater to dispatch update:available intent
            deps.autoUpdater.onUpdateAvailable((version: string) => {
              void deps.dispatcher.dispatch({
                type: INTENT_UPDATE_AVAILABLE,
                payload: { version },
              } as UpdateAvailableIntent);
            });
            return {};
          },
        },
      },
      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async () => {
            deps.autoUpdater.dispose();
          },
        },
      },
    },
    events: {
      [EVENT_CONFIG_UPDATED]: (event: DomainEvent) => {
        const { values } = event.payload as ConfigUpdatedPayload;
        if (values["auto-update"] !== undefined) {
          autoUpdate = values["auto-update"];
        }
      },
    },
  };
}
