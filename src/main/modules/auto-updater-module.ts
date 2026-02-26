/**
 * AutoUpdaterModule - Lifecycle module for auto-update checking and cleanup.
 *
 * Hooks:
 * - app:start -> "start": starts auto-updater, wires onUpdateAvailable to dispatch update:available
 * - app:shutdown -> "stop": disposes auto-updater (best-effort)
 */

import type { IntentModule } from "../intents/infrastructure/module";
import { APP_START_OPERATION_ID, type StartHookResult } from "../operations/app-start";
import { APP_SHUTDOWN_OPERATION_ID } from "../operations/app-shutdown";
import {
  INTENT_UPDATE_AVAILABLE,
  type UpdateAvailableIntent,
} from "../operations/update-available";
import type { AutoUpdater } from "../../services/auto-updater";
import type { Dispatcher } from "../intents/infrastructure/dispatcher";

interface AutoUpdaterModuleDeps {
  readonly autoUpdater: AutoUpdater;
  readonly dispatcher: Dispatcher;
}

export function createAutoUpdaterModule(deps: AutoUpdaterModuleDeps): IntentModule {
  return {
    name: "auto-updater",
    hooks: {
      [APP_START_OPERATION_ID]: {
        start: {
          handler: async (): Promise<StartHookResult> => {
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
  };
}
