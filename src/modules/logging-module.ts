/**
 * LoggingModule - Initializes the logging service and logs startup info.
 *
 * Hooks:
 * - app:start → "before-ready": configures logging from Config, logs build info
 * - app:start → "init": initializes logging service (enables renderer IPC
 *   logging) once Electron is ready
 */

import type { IntentModule } from "../intents/lib/module";
import type { Logging } from "../boundaries/platform/logging";
import type { Logger } from "../boundaries/platform/logging-types";
import type { BuildInfo } from "../boundaries/platform/build-info";
import type { PlatformInfo } from "../boundaries/platform/platform-info";
import type { Config } from "../boundaries/platform/config";
import { parseLogLevelSpec, splitLogLevelSpec } from "../boundaries/platform/electron-log";
import { storeCustom, storeEnum, storeEnumList } from "../boundaries/platform/store-definition";
import { APP_START_OPERATION_ID } from "../intents/app-start";

// =============================================================================
// Dependency Interface
// =============================================================================

export interface LoggingModuleDeps {
  readonly loggingService: Pick<Logging, "initialize" | "configure">;
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
  const logLevelConfig = deps.configService.register("log.level", {
    default: "warn",
    description: "Level spec: <level> or <level>:<filter>",
    ...storeCustom({
      parse: parseLogLevelSpec,
      validate: (v: unknown) => (typeof v === "string" ? parseLogLevelSpec(v) : undefined),
      validValues: "silly|debug|info|warn|error[:filter]",
      settingsControl: { kind: "string" },
    }),
    computedDefault: (ctx) => (ctx.isDevelopment ? "debug" : undefined),
  });
  const logOutputConfig = deps.configService.register("log.output", {
    default: "file",
    description: "Output destinations (comma-separated)",
    ...storeEnumList(["file", "console"]),
  });
  const logFormatConfig = deps.configService.register("log.format", {
    default: "text",
    description: "Log output format",
    ...storeEnum(["text", "json"]),
  });

  return {
    name: "logging",
    hooks: {
      [APP_START_OPERATION_ID]: {
        "before-ready": {
          handler: async (): Promise<void> => {
            // Configure logging from loaded config
            const levelSpec = logLevelConfig.get();
            const { level, filter } = splitLogLevelSpec(levelSpec);
            const output = logOutputConfig.get();
            const logFormat = logFormatConfig.get();
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
          },
        },
      },
    },
  };
}
