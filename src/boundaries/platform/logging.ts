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
} from "./logging-types";
export { LogLevel as LogLevelValues, logAtLevel } from "./logging-types";
export { ElectronLog, parseLogLevel, parseLogLevelSpec, splitLogLevelSpec } from "./electron-log";
export { createMockLogger, createMockLogging, SILENT_LOGGER } from "./logging.test-utils";
export type { MockLogger, MockLogging } from "./logging.test-utils";
