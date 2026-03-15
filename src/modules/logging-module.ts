/**
 * LoggingModule - Initializes the logging service and logs startup info.
 *
 * Hooks:
 * - app:start → "before-ready": configures logging from Config, logs build info
 * - app:start → "init": initializes logging service, registers IPC log handlers
 */

import type { IntentModule } from "../intents/lib/module";
import type { Logging } from "../boundaries/platform/logging";
import type { Logger, LogFormat } from "../boundaries/platform/logging/types";
import type { BuildInfo } from "../boundaries/platform/env/build-info";
import type { PlatformInfo } from "../boundaries/platform/env/platform-info";
import type { Config } from "../boundaries/platform/config/config";
import { parseLogLevelSpec, splitLogLevelSpec } from "../boundaries/platform/logging/electron-log";
import {
  configCustom,
  configEnum,
  configEnumList,
} from "../boundaries/platform/config/config-definition";
import { APP_START_OPERATION_ID } from "../intents/operations/app-start";

// =============================================================================
// Dependency Interface
// =============================================================================

export interface LoggingModuleDeps {
  readonly loggingService: Pick<Logging, "initialize" | "configure">;
  /** Called after initialize() to register IPC log handlers. */
  readonly registerLogHandlers: () => void;
  readonly buildInfo: Pick<BuildInfo, "version" | "isDevelopment" | "isPackaged">;
  readonly platformInfo: Pick<PlatformInfo, "platform" | "arch">;
  readonly logger: Logger;
  readonly configService: Config;
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a LoggingModule that configures and initializes logging during startup.
 */
export function createLoggingModule(deps: LoggingModuleDeps): IntentModule {
  // Register config keys
  deps.configService.register("log.level", {
    name: "log.level",
    default: "warn",
    description: "Level spec: <level> or <level>:<filter>",
    ...configCustom({
      parse: parseLogLevelSpec,
      validate: (v: unknown) => (typeof v === "string" ? parseLogLevelSpec(v) : undefined),
      validValues: "silly|debug|info|warn|error[:filter]",
    }),
    computedDefault: (ctx) => (ctx.isDevelopment ? "debug" : undefined),
  });
  deps.configService.register("log.output", {
    name: "log.output",
    default: "file",
    description: "Output destinations (comma-separated)",
    ...configEnumList(["file", "console"]),
  });
  deps.configService.register("log.format", {
    name: "log.format",
    default: "text",
    description: "Log output format",
    ...configEnum(["text", "json"]),
  });

  return {
    name: "logging",
    hooks: {
      [APP_START_OPERATION_ID]: {
        "before-ready": {
          handler: async (): Promise<void> => {
            // Configure logging from loaded config
            const levelSpec = deps.configService.get("log.level") as string;
            const { level, filter } = splitLogLevelSpec(levelSpec);
            const output = deps.configService.get("log.output") as string;
            const logFormat = deps.configService.get("log.format") as LogFormat;
            deps.loggingService.configure({
              logLevel: level,
              logFile: output.includes("file"),
              logConsole: output.includes("console"),
              allowedLoggers: filter,
              logFormat,
            });

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
          requires: { "app-ready": true },
          handler: async (): Promise<void> => {
            deps.loggingService.initialize();
            deps.registerLogHandlers();
          },
        },
      },
    },
  };
}
