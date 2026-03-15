/**
 * ErrorHandlerModule - Logs uncaught exceptions and unhandled rejections.
 *
 * Hook handlers:
 * - app:start / before-ready: registers process error handlers
 *
 * Two handlers are registered:
 *
 * 1. `process.on('unhandledRejection')` — Electron overrides Node.js's default
 *    `--unhandled-rejections=throw` mode and uses `warn` mode instead (this is
 *    an intentional Electron design decision, see electron/electron#36528).
 *    Without this handler, unhandled rejections only print a warning to stderr
 *    and are never logged or reported to telemetry. The handler logs the error
 *    but does not crash — matching Electron's intended non-fatal behavior.
 *
 * 2. `process.on('uncaughtException')` — Logs the error and re-throws to ensure
 *    the process crashes (adding a listener suppresses the default crash behavior).
 *    Uses the `origin` parameter to distinguish the source.
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
            process.on("unhandledRejection", (reason: unknown) => {
              const error =
                reason instanceof Error ? reason : new Error(String(reason), { cause: reason });
              deps.logger.error("Unhandled promise rejection", {}, error);
            });
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
