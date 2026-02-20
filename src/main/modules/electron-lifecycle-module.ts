/**
 * ElectronLifecycleModule - Electron app lifecycle hooks.
 *
 * Provides:
 * - "await-ready" hook on app:start (waits for Electron app ready)
 * - "quit" hook on app:shutdown (calls app.quit())
 */

import type { IntentModule } from "../intents/infrastructure/module";
import { APP_START_OPERATION_ID } from "../operations/app-start";
import { APP_SHUTDOWN_OPERATION_ID } from "../operations/app-shutdown";

// =============================================================================
// Dependency Interface
// =============================================================================

export interface ElectronLifecycleModuleDeps {
  readonly app: { whenReady(): Promise<void>; quit(): void };
}

// =============================================================================
// Factory
// =============================================================================

export function createElectronLifecycleModule(deps: ElectronLifecycleModuleDeps): IntentModule {
  return {
    hooks: {
      [APP_START_OPERATION_ID]: {
        "await-ready": {
          handler: async (): Promise<void> => {
            await deps.app.whenReady();
          },
        },
      },
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
