/**
 * ElectronReadyModule - Waits for Electron app ready event.
 *
 * Provides the "await-ready" hook on app-start, decoupling the
 * AppStartOperation from the Electron app lifecycle.
 */

import type { IntentModule } from "../intents/infrastructure/module";
import { APP_START_OPERATION_ID } from "../operations/app-start";

// =============================================================================
// Dependency Interface
// =============================================================================

export interface ElectronReadyModuleDeps {
  /** Electron app.whenReady() or equivalent promise-returning function. */
  readonly whenReady: () => Promise<void>;
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create an ElectronReadyModule that provides the "await-ready" hook.
 */
export function createElectronReadyModule(deps: ElectronReadyModuleDeps): IntentModule {
  return {
    hooks: {
      [APP_START_OPERATION_ID]: {
        "await-ready": {
          handler: async (): Promise<void> => {
            await deps.whenReady();
          },
        },
      },
    },
  };
}
