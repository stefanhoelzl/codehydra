/**
 * QuitModule - Calls app.quit() after all shutdown hooks complete.
 */

import type { IntentModule } from "../intents/infrastructure/module";
import { APP_SHUTDOWN_OPERATION_ID } from "../operations/app-shutdown";

export interface QuitModuleDeps {
  readonly app: { quit(): void };
}

export function createQuitModule(deps: QuitModuleDeps): IntentModule {
  return {
    hooks: {
      [APP_SHUTDOWN_OPERATION_ID]: {
        quit: {
          handler: async () => {
            deps.app.quit();
          },
        },
      },
    },
  };
}
