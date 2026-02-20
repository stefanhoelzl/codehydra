/**
 * LoggingModule - Initializes the logging service.
 *
 * Provides the "init" hook on app-start to initialize the logging service
 * (enabling renderer logging via IPC) and register log handlers.
 */

import type { IntentModule } from "../intents/infrastructure/module";
import type { LoggingService } from "../../services/logging";
import { APP_START_OPERATION_ID } from "../operations/app-start";

// =============================================================================
// Dependency Interface
// =============================================================================

export interface LoggingModuleDeps {
  readonly loggingService: Pick<LoggingService, "initialize">;
  /** Called after initialize() to register IPC log handlers. */
  readonly registerLogHandlers: () => void;
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a LoggingModule that initializes logging in the "init" hook.
 */
export function createLoggingModule(deps: LoggingModuleDeps): IntentModule {
  return {
    hooks: {
      [APP_START_OPERATION_ID]: {
        init: {
          handler: async (): Promise<void> => {
            deps.loggingService.initialize();
            deps.registerLogHandlers();
          },
        },
      },
    },
  };
}
