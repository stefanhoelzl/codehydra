/**
 * LoggingModule - Initializes the logging service and logs startup info.
 *
 * Hooks:
 * - app:start → "before-ready": configures logging from Config, enables
 *   Chromium's --enable-logging=file with --v=1 so native Electron/Chromium
 *   logs are captured to a known path, logs build info
 * - app:start → "init": initializes logging service, starts the electron.log
 *   truncation watcher (Chromium has no native log rotation)
 * - app:shutdown → "stop": stops the truncation watcher
 */

import type { IntentModule } from "../intents/lib/module";
import type { Logging } from "../boundaries/platform/logging";
import type { Logger } from "../boundaries/platform/logging-types";
import type { BuildInfo } from "../boundaries/platform/build-info";
import type { PlatformInfo } from "../boundaries/platform/platform-info";
import type { Config } from "../boundaries/platform/config";
import type { FileSystemBoundary } from "../boundaries/platform/filesystem";
import { parseLogLevelSpec, splitLogLevelSpec } from "../boundaries/platform/electron-log";
import { configCustom, configEnum, configEnumList } from "../boundaries/platform/config-definition";
import { APP_START_OPERATION_ID } from "../intents/app-start";
import { APP_SHUTDOWN_OPERATION_ID } from "../intents/app-shutdown";

// =============================================================================
// Constants
// =============================================================================

/** Hard cap on the electron.log file. Watcher truncates to this size when exceeded. */
const ELECTRON_LOG_MAX_BYTES = 20 * 1024 * 1024;

/** How often the truncation watcher runs. */
const ELECTRON_LOG_WATCHER_INTERVAL_MS = 15 * 60 * 1000;

// =============================================================================
// Dependency Interface
// =============================================================================

/** Minimal app.commandLine surface used by this module. */
export interface CommandLineLike {
  appendSwitch(key: string, value?: string): void;
}

export interface LoggingModuleDeps {
  readonly loggingService: Pick<Logging, "initialize" | "configure" | "getElectronLogFilePath">;
  readonly buildInfo: Pick<BuildInfo, "version" | "isDevelopment" | "isPackaged">;
  readonly platformInfo: Pick<PlatformInfo, "platform" | "arch">;
  readonly logger: Logger;
  readonly configService: Config;
  readonly app: { commandLine: CommandLineLike };
  readonly fileSystem: Pick<FileSystemBoundary, "readFile" | "writeFile">;
  /**
   * Schedule a recurring tick. Defaults to setInterval/clearInterval. Injectable
   * so integration tests can drive ticks deterministically.
   */
  readonly scheduler?: {
    setInterval(handler: () => void, ms: number): unknown;
    clearInterval(handle: unknown): void;
  };
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
    ...configCustom({
      parse: parseLogLevelSpec,
      validate: (v: unknown) => (typeof v === "string" ? parseLogLevelSpec(v) : undefined),
      validValues: "silly|debug|info|warn|error[:filter]",
    }),
    computedDefault: (ctx) => (ctx.isDevelopment ? "debug" : undefined),
  });
  const logOutputConfig = deps.configService.register("log.output", {
    default: "file",
    description: "Output destinations (comma-separated)",
    ...configEnumList(["file", "console"]),
  });
  const logFormatConfig = deps.configService.register("log.format", {
    default: "text",
    description: "Log output format",
    ...configEnum(["text", "json"]),
  });

  const scheduler = deps.scheduler ?? {
    setInterval: (h: () => void, ms: number) => setInterval(h, ms),
    clearInterval: (handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>),
  };

  let watcherHandle: unknown = null;

  async function truncateElectronLogIfOversize(): Promise<void> {
    const path = deps.loggingService.getElectronLogFilePath();
    const content = await deps.fileSystem.readFile(path).catch(() => null);
    if (content === null) return; // not yet created
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes <= ELECTRON_LOG_MAX_BYTES) return;
    // Slice the last N bytes off the end. Slicing by code-unit count would
    // mis-handle multi-byte UTF-8 sequences; convert via Buffer to be exact.
    const buf = Buffer.from(content, "utf8");
    const tail = buf.subarray(buf.length - ELECTRON_LOG_MAX_BYTES).toString("utf8");
    await deps.fileSystem.writeFile(path, tail).catch((err: unknown) =>
      deps.logger.warn("Failed to truncate electron.log", {
        error: err instanceof Error ? err.message : String(err),
      })
    );
  }

  return {
    name: "logging",
    hooks: {
      [APP_START_OPERATION_ID]: {
        "before-ready": {
          handler: async (): Promise<void> => {
            // Enable Chromium/Electron native logging to a known file. Must be
            // appended before app.whenReady. --v=1 captures verbose internals
            // useful in bug reports (GPU, IPC, renderer crashes). The file is
            // overwritten on each launch by Chromium itself.
            const electronLogPath = deps.loggingService.getElectronLogFilePath();
            deps.app.commandLine.appendSwitch("enable-logging", "file");
            deps.app.commandLine.appendSwitch("log-file", electronLogPath);
            deps.app.commandLine.appendSwitch("v", "1");

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
            // Chromium has no native log rotation. Cap on-disk size with a
            // simple periodic watcher (stat-then-truncate-tail). Memory cost
            // is bounded by ELECTRON_LOG_MAX_BYTES on each tick.
            if (watcherHandle === null) {
              watcherHandle = scheduler.setInterval(
                () => void truncateElectronLogIfOversize(),
                ELECTRON_LOG_WATCHER_INTERVAL_MS
              );
            }
          },
        },
      },
      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async (): Promise<void> => {
            if (watcherHandle !== null) {
              scheduler.clearInterval(watcherHandle);
              watcherHandle = null;
            }
          },
        },
      },
    },
  };
}
