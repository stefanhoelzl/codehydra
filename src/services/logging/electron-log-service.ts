/**
 * ElectronLogService - Main process logging implementation using electron-log.
 *
 * Features:
 * - Session-based log files: `<datetime>-<uuid>.log`
 * - Environment variable configuration for level and console output
 * - Named logger scopes for component identification
 * - Context serialization as key=value pairs
 */

import log from "electron-log/main";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { BuildInfo } from "../platform/build-info";
import type { PathProvider } from "../platform/path-provider";
import type { Logger, LoggerName, LoggingService, LogContext, LogLevel } from "./types";
import { LogLevel as LogLevelValues } from "./types";

/**
 * Type for electron-log scope (log functions).
 */
type ElectronLogScope = ReturnType<typeof log.scope>;

/**
 * Format context object as key=value pairs for log message.
 *
 * @param context - Context object to format
 * @returns Formatted string like "key1=value1 key2=value2"
 */
function formatContext(context: LogContext | undefined): string {
  if (!context) return "";
  return Object.entries(context)
    .map(([key, value]) => {
      // Handle null explicitly
      if (value === null) return `${key}=null`;
      // Booleans, numbers, and strings formatted directly
      return `${key}=${String(value)}`;
    })
    .join(" ");
}

/**
 * Parse and validate CODEHYDRA_LOGLEVEL environment variable.
 *
 * @param envValue - Raw environment variable value
 * @returns Valid log level or undefined if invalid
 */
function parseLogLevel(envValue: string | undefined): LogLevel | undefined {
  if (!envValue) return undefined;
  const normalized = envValue.toLowerCase().trim();
  if (normalized in LogLevelValues) {
    return normalized as LogLevel;
  }
  return undefined;
}

/**
 * Generate session-based log filename.
 * Format: YYYY-MM-DDTHH-MM-SS-<uuid>.log
 *
 * @returns Filename for this session's log file
 */
function generateSessionFilename(): string {
  const now = new Date();
  const timestamp = now
    .toISOString()
    .replace(/[:.]/g, "-") // Replace : and . with -
    .slice(0, 19); // YYYY-MM-DDTHH-MM-SS
  const uuid = randomUUID().slice(0, 8);
  return `${timestamp}-${uuid}.log`;
}

/**
 * Logger implementation wrapping an electron-log scope.
 */
class ElectronLogLogger implements Logger {
  private readonly scope: ElectronLogScope;

  constructor(scope: ElectronLogScope) {
    this.scope = scope;
  }

  silly(message: string, context?: LogContext): void {
    const contextStr = formatContext(context);
    const fullMessage = contextStr ? `${message} ${contextStr}` : message;
    this.scope.silly(fullMessage);
  }

  debug(message: string, context?: LogContext): void {
    const contextStr = formatContext(context);
    const fullMessage = contextStr ? `${message} ${contextStr}` : message;
    this.scope.debug(fullMessage);
  }

  info(message: string, context?: LogContext): void {
    const contextStr = formatContext(context);
    const fullMessage = contextStr ? `${message} ${contextStr}` : message;
    this.scope.info(fullMessage);
  }

  warn(message: string, context?: LogContext): void {
    const contextStr = formatContext(context);
    const fullMessage = contextStr ? `${message} ${contextStr}` : message;
    this.scope.warn(fullMessage);
  }

  error(message: string, context?: LogContext, error?: Error): void {
    const contextStr = formatContext(context);
    const fullMessage = contextStr ? `${message} ${contextStr}` : message;
    if (error) {
      // Include error message and stack
      this.scope.error(fullMessage, error);
    } else {
      this.scope.error(fullMessage);
    }
  }
}

/**
 * Parse CODEHYDRA_LOGGER env var to get set of allowed logger names.
 *
 * @param envValue - Raw environment variable value (comma-separated logger names)
 * @returns Set of allowed logger names, or undefined if not set (allow all)
 */
function parseLoggerFilter(envValue: string | undefined): Set<LoggerName> | undefined {
  if (!envValue) return undefined;
  const names = envValue
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (names.length === 0) return undefined;
  return new Set(names as LoggerName[]);
}

/**
 * Logger that filters based on allowed logger names.
 * If the logger is not in the allowed set, all log methods are no-ops.
 */
class FilteredLogger implements Logger {
  private readonly inner: Logger;
  private readonly enabled: boolean;

  constructor(inner: Logger, allowedLoggers: Set<LoggerName> | undefined, name: LoggerName) {
    this.inner = inner;
    // If no filter set, all loggers are enabled. Otherwise, check the set.
    this.enabled = allowedLoggers === undefined || allowedLoggers.has(name);
  }

  silly(message: string, context?: LogContext): void {
    if (this.enabled) this.inner.silly(message, context);
  }

  debug(message: string, context?: LogContext): void {
    if (this.enabled) this.inner.debug(message, context);
  }

  info(message: string, context?: LogContext): void {
    if (this.enabled) this.inner.info(message, context);
  }

  warn(message: string, context?: LogContext): void {
    if (this.enabled) this.inner.warn(message, context);
  }

  error(message: string, context?: LogContext, error?: Error): void {
    if (this.enabled) this.inner.error(message, context, error);
  }
}

/**
 * Main process logging service using electron-log.
 *
 * Configuration:
 * - Default level: DEBUG (dev) / WARN (prod)
 * - Override via CODEHYDRA_LOGLEVEL environment variable
 * - Console output via CODEHYDRA_PRINT_LOGS (any truthy value)
 * - Logger filtering via CODEHYDRA_LOGGER (comma-separated logger names)
 *
 * @example
 * ```typescript
 * const loggingService = new ElectronLogService(buildInfo, pathProvider);
 * loggingService.initialize();
 *
 * const logger = loggingService.createLogger('git');
 * logger.info('Clone complete', { repo: 'myrepo', branch: 'main' });
 * // Output: [2025-12-16 10:30:00.123] [info] [git] Clone complete repo=myrepo branch=main
 * ```
 */

export class ElectronLogService implements LoggingService {
  private readonly loggers = new Map<LoggerName, Logger>();
  private readonly logLevel: LogLevel;
  private readonly enableConsole: boolean;
  private readonly allowedLoggers: Set<LoggerName> | undefined;

  constructor(buildInfo: BuildInfo, pathProvider: PathProvider) {
    // Determine log level: env var > default based on build mode
    const envLevel = parseLogLevel(process.env.CODEHYDRA_LOGLEVEL);
    const defaultLevel: LogLevel = buildInfo.isDevelopment ? "debug" : "warn";
    this.logLevel = envLevel ?? defaultLevel;

    // Console output: enabled if env var is set to any truthy value
    this.enableConsole = !!process.env.CODEHYDRA_PRINT_LOGS;

    // Logger filter: only log from specified loggers (if set)
    this.allowedLoggers = parseLoggerFilter(process.env.CODEHYDRA_LOGGER);

    // Configure file transport
    const logsDir = join(pathProvider.dataRootDir, "logs");
    const filename = generateSessionFilename();
    log.transports.file.resolvePathFn = (): string => join(logsDir, filename);
    log.transports.file.level = this.logLevel;

    // Configure console transport
    log.transports.console.level = this.enableConsole ? this.logLevel : false;

    // Format: [timestamp] [level] [scope] message
    log.transports.file.format = "[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {scope} {text}";
    log.transports.console.format = "[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {scope} {text}";
  }

  /**
   * Create a logger with the specified name (scope).
   * If CODEHYDRA_LOGGER is set, only loggers in the list will actually log.
   */
  createLogger(name: LoggerName): Logger {
    // Return cached logger if already created
    const existing = this.loggers.get(name);
    if (existing) {
      return existing;
    }

    // Create a new scope with the logger name in brackets
    const scope = log.scope(`[${name}]`);
    const innerLogger = new ElectronLogLogger(scope);

    // Wrap with filter if CODEHYDRA_LOGGER is set
    const logger = new FilteredLogger(innerLogger, this.allowedLoggers, name);
    this.loggers.set(name, logger);
    return logger;
  }

  /**
   * Initialize the logging service.
   * This enables renderer logging via IPC by calling electron-log's initialize().
   */
  initialize(): void {
    log.initialize();
  }

  /**
   * Dispose of the logging service.
   * Currently a no-op as electron-log doesn't require cleanup.
   */
  dispose(): void {
    this.loggers.clear();
  }
}
