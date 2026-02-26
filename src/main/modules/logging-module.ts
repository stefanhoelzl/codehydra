/**
 * LoggingModule - Initializes the logging service and logs startup/config info.
 *
 * Hooks:
 * - app:start → "before-ready": logs build and platform info
 * - app:start → "init": initializes logging service, registers IPC log handlers
 *
 * Events:
 * - config:updated: logs all changed values, reconfigures logging when
 *   log.level or log.output values change
 */

import type { IntentModule } from "../intents/infrastructure/module";
import type { DomainEvent } from "../intents/infrastructure/types";
import type { LoggingService } from "../../services/logging";
import type { Logger } from "../../services/logging/types";
import type { BuildInfo } from "../../services/platform/build-info";
import type { PlatformInfo } from "../../services/platform/platform-info";
import type { ConfigUpdatedEvent } from "../operations/config-set-values";
import { splitLogLevelSpec } from "../../services/logging/electron-log-service";
import { APP_START_OPERATION_ID } from "../operations/app-start";
import { EVENT_CONFIG_UPDATED } from "../operations/config-set-values";

// =============================================================================
// Dependency Interface
// =============================================================================

export interface LoggingModuleDeps {
  readonly loggingService: Pick<LoggingService, "initialize" | "configure">;
  /** Called after initialize() to register IPC log handlers. */
  readonly registerLogHandlers: () => void;
  readonly buildInfo: Pick<BuildInfo, "version" | "isDevelopment" | "isPackaged">;
  readonly platformInfo: Pick<PlatformInfo, "platform" | "arch">;
  readonly logger: Logger;
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
        "before-ready": {
          handler: async (): Promise<void> => {
            deps.logger.info("App starting", {
              version: deps.buildInfo.version,
              isDev: deps.buildInfo.isDevelopment,
              isPackaged: deps.buildInfo.isPackaged,
              platform: deps.platformInfo.platform,
              arch: deps.platformInfo.arch,
            });
          },
        },
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

        // Log all config changes
        const context: Record<string, string | number | boolean | null> = {};
        for (const [key, value] of Object.entries(values)) {
          context[key] = value ?? null;
        }
        deps.logger.info("Config updated", context);

        // Reconfigure logging when any log-related value changes
        if (values["log.level"] !== undefined || values["log.output"] !== undefined) {
          const levelSpec = (values["log.level"] as string | undefined) ?? "warn";
          const { level, filter } = splitLogLevelSpec(levelSpec);
          const output = (values["log.output"] as string | undefined) ?? "file";
          deps.loggingService.configure({
            logLevel: level,
            logFile: output.includes("file"),
            logConsole: output.includes("console"),
            allowedLoggers: filter,
          });
        }
      },
    },
  };
}
