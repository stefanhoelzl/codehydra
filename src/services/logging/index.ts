/**
 * Public API exports for the logging service.
 */

export type {
  Logger,
  LoggingService,
  LoggingConfigureOptions,
  LogContext,
  LogFormat,
  LoggerName,
  LogLevel,
  LogOutput,
} from "./types";
export { LogLevel as LogLevelValues, logAtLevel } from "./types";
export {
  ElectronLogService,
  parseLogFormat,
  parseLogLevel,
  parseLogLevelSpec,
  splitLogLevelSpec,
  parseLogOutput,
} from "./electron-log-service";
export { createMockLogger, createMockLoggingService, SILENT_LOGGER } from "./logging.test-utils";
export type { MockLogger, MockLoggingService } from "./logging.test-utils";
