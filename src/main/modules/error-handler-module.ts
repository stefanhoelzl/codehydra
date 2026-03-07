/**
 * ErrorHandlerModule - Logs uncaught exceptions and unhandled rejections.
 *
 * Hook handlers:
 * - app:start / before-ready: registers process.on('uncaughtException') handler
 *
 * The handler logs the error and re-throws to ensure the process crashes
 * (adding a listener suppresses the default crash behavior).
 *
 * Node v15+ converts unhandled rejections to uncaught exceptions by default,
 * so no separate 'unhandledRejection' listener is needed. The handler uses
 * the `origin` parameter to distinguish the source.
 */

import type { IntentModule } from "../intents/infrastructure/module";
import type { Logger } from "../../services/logging/types";
import { APP_START_OPERATION_ID } from "../operations/app-start";

// =============================================================================
// Dependencies
// =============================================================================

export interface ErrorHandlerModuleDeps {
  readonly logger: Logger;
}

// =============================================================================
// Module Factory
// =============================================================================

export function createErrorHandlerModule(deps: ErrorHandlerModuleDeps): IntentModule {
  return {
    name: "error-handler",
    hooks: {
      [APP_START_OPERATION_ID]: {
        "before-ready": {
          handler: async (): Promise<Record<string, never>> => {
            process.on("uncaughtException", (error: Error, origin: string) => {
              if (origin === "unhandledRejection") {
                deps.logger.error("Unhandled promise rejection", {}, error);
              } else {
                deps.logger.error("Uncaught exception", {}, error);
              }
              throw error;
            });
            return {};
          },
        },
      },
    },
  };
}
