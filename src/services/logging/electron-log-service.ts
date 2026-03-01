/**
 * ElectronLogService - Main process logging implementation using electron-log.
 *
 * Features:
 * - Session-based log files: `<datetime>-<uuid>.log`
 * - Deferred configuration: construct without config, call configure() later
 * - Buffered logging: entries before configure() are queued and flushed
 * - Named logger scopes for component identification
 * - Context serialization as key=value pairs
 */

import log from "electron-log/main";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { PathProvider } from "../platform/path-provider";
import type {
  Logger,
  LoggerName,
  LogFormat,
  LoggingConfigureOptions,
  LoggingService,
  LogContext,
  LogLevel,
  LogOutput,
} from "./types";
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
 * Parse and validate a log level string.
 *
 * @param envValue - Raw string value (e.g., from an environment variable)
 * @returns Valid log level or undefined if invalid
 */
export function parseLogLevel(envValue: string | undefined): LogLevel | undefined {
  if (!envValue) return undefined;
  const normalized = envValue.toLowerCase().trim();
  if (normalized in LogLevelValues) {
    return normalized as LogLevel;
  }
  return undefined;
}

/**
 * Validate a combined log level spec string: `<level>` or `<level>:<filter>`.
 *
 * The level part must be a valid log level. The filter part (after `:`) is
 * freeform comma-separated logger names or `*` for all loggers.
 *
 * @param raw - Raw string value (e.g., "debug", "debug:git,process", "debug:*")
 * @returns The validated spec string (trimmed), or undefined if invalid
 */
export function parseLogLevelSpec(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;

  const colonIndex = trimmed.indexOf(":");
  const levelPart = colonIndex === -1 ? trimmed : trimmed.slice(0, colonIndex);

  if (parseLogLevel(levelPart) === undefined) return undefined;

  if (colonIndex !== -1) {
    const filterPart = trimmed.slice(colonIndex + 1);
    if (filterPart.length === 0) return undefined;
  }

  return trimmed;
}

/**
 * Split a validated log level spec into its level and filter components.
 *
 * @param spec - A validated spec string from `parseLogLevelSpec`
 * @returns Parsed level and optional filter set (undefined means all loggers)
 */
export function splitLogLevelSpec(spec: string): {
  level: LogLevel;
  filter: Set<LoggerName> | undefined;
} {
  const colonIndex = spec.indexOf(":");
  const levelPart = colonIndex === -1 ? spec : spec.slice(0, colonIndex);
  const level = parseLogLevel(levelPart)!;

  if (colonIndex === -1) return { level, filter: undefined };

  const filterPart = spec.slice(colonIndex + 1);
  if (filterPart === "*") return { level, filter: undefined };

  return { level, filter: parseLoggerFilter(filterPart) };
}

/**
 * Validate and normalize a log output destination string.
 *
 * @param raw - Raw string value (e.g., "file", "console", "file,console")
 * @returns Normalized output string, or undefined if invalid
 */
export function parseLogOutput(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const tokens = raw
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return undefined;

  const valid: LogOutput[] = ["file", "console"];
  for (const token of tokens) {
    if (!valid.includes(token as LogOutput)) return undefined;
  }

  // Deduplicate and sort for canonical form
  const unique = [...new Set(tokens)].sort() as LogOutput[];
  return unique.join(",");
}

/**
 * Validate and normalize a log format string.
 *
 * @param raw - Raw string value (e.g., "text", "json")
 * @returns Normalized format string, or undefined if invalid
 */
export function parseLogFormat(raw: string | undefined): LogFormat | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "text" || normalized === "json") {
    return normalized;
  }
  return undefined;
}

/**
 * Text format template for electron-log transports.
 */
const TEXT_FORMAT = "[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {scope} {text}";

/**
 * Create a format function for JSON log output.
 *
 * The returned function receives electron-log's FormatParams and produces
 * a single JSONL line with structured fields:
 * - timestamp, level, scope, message
 * - context: first non-Error object in data[1:]
 * - error: first Error instance in data[1:] (message + stack)
 *
 * electron-log Format signature: (params: FormatParams) => any[]
 * FormatParams: { data, level, logger, message, transport }
 * message: LogMessage { data, date, level, scope?, ... }
 */
function createJsonFormatFn(): (params: {
  message: { date: Date; level: string; scope?: string; data: unknown[] };
}) => string[] {
  return ({ message }) => {
    const entry: Record<string, unknown> = {
      timestamp: message.date.toISOString(),
      level: message.level,
    };

    if (message.scope) {
      entry.scope = message.scope;
    }

    entry.message = typeof message.data[0] === "string" ? message.data[0] : String(message.data[0]);

    // Find context and error in remaining data arguments
    for (let i = 1; i < message.data.length; i++) {
      const arg = message.data[i];
      if (arg instanceof Error) {
        entry.error = { message: arg.message, stack: arg.stack };
      } else if (arg !== null && typeof arg === "object" && !Array.isArray(arg)) {
        entry.context = arg;
      }
    }

    return [JSON.stringify(entry)];
  };
}

/**
 * JSON-mode logger that passes message and context as separate arguments
 * to the electron-log scope, so the format function can include context
 * as a structured JSON field.
 */
class JsonLogLogger implements Logger {
  private readonly scope: ElectronLogScope;

  constructor(scope: ElectronLogScope) {
    this.scope = scope;
  }

  silly(message: string, context?: LogContext): void {
    if (context) {
      this.scope.silly(message, context);
    } else {
      this.scope.silly(message);
    }
  }

  debug(message: string, context?: LogContext): void {
    if (context) {
      this.scope.debug(message, context);
    } else {
      this.scope.debug(message);
    }
  }

  info(message: string, context?: LogContext): void {
    if (context) {
      this.scope.info(message, context);
    } else {
      this.scope.info(message);
    }
  }

  warn(message: string, context?: LogContext): void {
    if (context) {
      this.scope.warn(message, context);
    } else {
      this.scope.warn(message);
    }
  }

  error(message: string, context?: LogContext, error?: Error): void {
    if (context && error) {
      this.scope.error(message, context, error);
    } else if (error) {
      this.scope.error(message, error);
    } else if (context) {
      this.scope.error(message, context);
    } else {
      this.scope.error(message);
    }
  }
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
 * Parse a comma-separated string to get a set of allowed logger names.
 *
 * @param envValue - Raw string value (e.g., from an environment variable)
 * @returns Set of allowed logger names, or undefined if not set (allow all)
 */
export function parseLoggerFilter(envValue: string | undefined): Set<LoggerName> | undefined {
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
 * Entry buffered by QueuedLogger before configure() is called.
 */
interface QueueEntry {
  readonly level: LogLevel;
  readonly message: string;
  readonly context: LogContext | undefined;
  readonly error: Error | undefined;
}

/**
 * Logger that buffers entries until activated with a real inner logger.
 * After activation, all methods delegate directly to the inner logger.
 * Consumers hold a reference to this object, so replacing the inner
 * via `activate()` transparently upgrades all call sites.
 */
class QueuedLogger implements Logger {
  private queue: QueueEntry[] | undefined = [];
  private inner: Logger | undefined;

  activate(inner: Logger): void {
    const pending = this.queue;
    this.inner = inner;
    this.queue = undefined;
    if (pending) {
      for (const entry of pending) {
        if (entry.level === "error") {
          inner.error(entry.message, entry.context, entry.error);
        } else {
          inner[entry.level](entry.message, entry.context);
        }
      }
    }
  }

  silly(message: string, context?: LogContext): void {
    if (this.inner) {
      this.inner.silly(message, context);
    } else {
      this.queue!.push({ level: "silly", message, context, error: undefined });
    }
  }

  debug(message: string, context?: LogContext): void {
    if (this.inner) {
      this.inner.debug(message, context);
    } else {
      this.queue!.push({ level: "debug", message, context, error: undefined });
    }
  }

  info(message: string, context?: LogContext): void {
    if (this.inner) {
      this.inner.info(message, context);
    } else {
      this.queue!.push({ level: "info", message, context, error: undefined });
    }
  }

  warn(message: string, context?: LogContext): void {
    if (this.inner) {
      this.inner.warn(message, context);
    } else {
      this.queue!.push({ level: "warn", message, context, error: undefined });
    }
  }

  error(message: string, context?: LogContext, error?: Error): void {
    if (this.inner) {
      this.inner.error(message, context, error);
    } else {
      this.queue!.push({ level: "error", message, context, error });
    }
  }
}

/**
 * Main process logging service using electron-log.
 *
 * Construction configures file path and format (known at startup).
 * Transport levels start silent until `configure()` is called.
 * Loggers created before `configure()` buffer entries and flush them
 * when configuration arrives.
 *
 * @example
 * ```typescript
 * const loggingService = new ElectronLogService(pathProvider);
 * loggingService.configure({ logLevel: 'debug', logFile: true, logConsole: false, allowedLoggers: undefined });
 * loggingService.initialize();
 *
 * const logger = loggingService.createLogger('git');
 * logger.info('Clone complete', { repo: 'myrepo', branch: 'main' });
 * // Output: [2025-12-16 10:30:00.123] [info] [git] Clone complete repo=myrepo branch=main
 * ```
 */

export class ElectronLogService implements LoggingService {
  private readonly loggers = new Map<LoggerName, QueuedLogger>();
  private configured = false;
  private logLevel: LogLevel = "warn";
  private logFormat: LogFormat = "text";
  private allowedLoggers: Set<LoggerName> | undefined;

  constructor(pathProvider: PathProvider) {
    // Transports start silent — configure() enables them
    log.transports.file.level = false;
    log.transports.console.level = false;

    // Configure file path (known at construction)
    const logsDir = pathProvider.dataPath("logs").toNative();
    const filename = generateSessionFilename();
    log.transports.file.resolvePathFn = (): string => join(logsDir, filename);

    // Format: [timestamp] [level] [scope] message
    log.transports.file.format = TEXT_FORMAT;
    log.transports.console.format = TEXT_FORMAT;
  }

  configure(options: LoggingConfigureOptions): void {
    this.logLevel = options.logLevel;
    this.logFormat = options.logFormat;
    this.allowedLoggers = options.allowedLoggers;

    // Enable transports with the configured level
    log.transports.file.level = options.logFile ? this.logLevel : false;
    log.transports.console.level = options.logConsole ? this.logLevel : false;

    // Set transport format based on log format
    const format = this.logFormat === "json" ? createJsonFormatFn() : TEXT_FORMAT;
    log.transports.file.format = format;
    log.transports.console.format = format;

    // Activate all existing queued loggers
    for (const [name, queued] of this.loggers) {
      const scope = log.scope(name);
      const inner =
        this.logFormat === "json" ? new JsonLogLogger(scope) : new ElectronLogLogger(scope);
      const filtered = new FilteredLogger(inner, this.allowedLoggers, name);
      queued.activate(filtered);
    }

    this.configured = true;
  }

  /**
   * Create a logger with the specified name (scope).
   * If not yet configured, the logger buffers entries until configure() is called.
   */
  createLogger(name: LoggerName): Logger {
    // Return cached logger if already created
    const existing = this.loggers.get(name);
    if (existing) {
      return existing;
    }

    const queued = new QueuedLogger();

    // If already configured, activate immediately
    if (this.configured) {
      const scope = log.scope(name);
      const inner =
        this.logFormat === "json" ? new JsonLogLogger(scope) : new ElectronLogLogger(scope);
      const filtered = new FilteredLogger(inner, this.allowedLoggers, name);
      queued.activate(filtered);
    }

    this.loggers.set(name, queued);
    return queued;
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
