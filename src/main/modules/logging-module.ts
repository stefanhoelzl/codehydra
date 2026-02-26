/**
 * LoggingModule - Initializes the logging service.
 *
 * Provides the "init" hook on app-start to initialize the logging service
 * (enabling renderer logging via IPC) and register log handlers.
 *
 * Subscribes to config:updated events to reconfigure logging when
 * log.level, log.console, or log.filter values change.
 */

import type { IntentModule } from "../intents/infrastructure/module";
import type { DomainEvent } from "../intents/infrastructure/types";
import type { LoggingService } from "../../services/logging";
import type { ConfigUpdatedEvent } from "../operations/config-set-values";
import { parseLoggerFilter } from "../../services/logging/electron-log-service";
import { APP_START_OPERATION_ID } from "../operations/app-start";
import { EVENT_CONFIG_UPDATED } from "../operations/config-set-values";

// =============================================================================
// Dependency Interface
// =============================================================================

export interface LoggingModuleDeps {
  readonly loggingService: Pick<LoggingService, "initialize" | "configure">;
  /** Called after initialize() to register IPC log handlers. */
  readonly registerLogHandlers: () => void;
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a LoggingModule that initializes logging in the "init" hook
 * and reconfigures it via config:updated events.
 */
export function createLoggingModule(deps: LoggingModuleDeps): IntentModule {
  return {
    name: "logging",
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
    events: {
      [EVENT_CONFIG_UPDATED]: (event: DomainEvent) => {
        const { values } = (event as ConfigUpdatedEvent).payload;
        // Reconfigure logging when any log-related value changes
        if (
          values["log.level"] !== undefined ||
          values["log.console"] !== undefined ||
          values["log.filter"] !== undefined
        ) {
          deps.loggingService.configure({
            logLevel: values["log.level"] ?? "warn",
            enableConsole: values["log.console"] ?? false,
            allowedLoggers:
              values["log.filter"] !== undefined
                ? parseLoggerFilter(values["log.filter"])
                : undefined,
          });
        }
      },
    },
  };
}
