/**
 * Public API exports for the logging service.
 */

export type {
  Logger,
  Logging,
  LoggingConfigureOptions,
  LogContext,
  LogFormat,
  LoggerName,
  LogLevel,
  LogOutput,
} from "./types";
export { LogLevel as LogLevelValues, logAtLevel } from "./types";
export { ElectronLog, parseLogLevel, parseLogLevelSpec, splitLogLevelSpec } from "./electron-log";
export { createMockLogger, createMockLogging, SILENT_LOGGER } from "./logging.test-utils";
export type { MockLogger, MockLogging } from "./logging.test-utils";
