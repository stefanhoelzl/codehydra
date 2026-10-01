/**
 * Mock utilities for logging tests.
 *
 * Provides mock logger and logging service factories for unit testing
 * services that depend on the Logger interface.
 */

import { vi, type Mock } from "vitest";
import type {
  Logger,
  LoggerName,
  LoggingConfigureOptions,
  Logging,
  LogContext,
  LogScopeHint,
} from "./logging-types";
import { AsyncLogScopeStore } from "./log-scope";

/**
 * A test logger's `scoped`: a logger writing to the same `target`, with the
 * hint folded into each line's context as `scope.path` / `scope.workspace` /
 * `scope.origin` — so a
 * test asserts what a line was scoped to the way it asserts its context:
 * `expect(logger.warn).toHaveBeenCalledWith("…", expect.objectContaining({ "scope.path": ws }))`.
 */
function scopedTestLogger(target: Logger, hint: LogScopeHint): Logger {
  const fold = (context: LogContext | undefined): LogContext =>
    ({
      ...(hint.path !== undefined && hint.path !== null && { "scope.path": hint.path }),
      ...(hint.workspace !== undefined && { "scope.workspace": hint.workspace }),
      ...(hint.origin !== undefined && { "scope.origin": hint.origin }),
      ...context,
    }) as LogContext;
  return {
    silly: (message, context) => target.silly(message, fold(context)),
    debug: (message, context) => target.debug(message, fold(context)),
    info: (message, context) => target.info(message, fold(context)),
    warn: (message, context) => target.warn(message, fold(context)),
    error: (message, context, error) => target.error(message, fold(context), error),
    scoped: (more) => scopedTestLogger(target, { ...hint, ...more }),
  };
}

/**
 * Mock logger with vitest spy methods.
 * All method calls are recorded for assertion; see `scopedTestLogger` for `scoped`.
 */
export interface MockLogger extends Logger {
  silly: Mock<(message: string, context?: LogContext) => void>;
  debug: Mock<(message: string, context?: LogContext) => void>;
  info: Mock<(message: string, context?: LogContext) => void>;
  warn: Mock<(message: string, context?: LogContext) => void>;
  error: Mock<(message: string, context?: LogContext, error?: Error) => void>;
}

/**
 * Mock logging service with vitest spy methods.
 * Tracks all loggers created via `getCreatedLoggers()`.
 */
export interface MockLogging extends Logging {
  createLogger: Mock<(name: LoggerName) => Logger>;
  configure: Mock<(options: LoggingConfigureOptions) => void>;
  initialize: Mock<() => void>;

  /**
   * Get all logger names that were requested via createLogger().
   */
  getCreatedLoggerNames(): LoggerName[];

  /**
   * Get the mock logger instance for a specific name.
   * Returns undefined if that logger was never created.
   */
  getLogger(name: LoggerName): MockLogger | undefined;
}

/**
 * Create a mock logger with vitest spy methods.
 *
 * @returns Mock logger that records all calls
 *
 * @example
 * ```typescript
 * const logger = createMockLogger();
 * const service = new MyService(logger);
 *
 * await service.doWork();
 *
 * expect(logger.info).toHaveBeenCalledWith('Work complete', { result: 'success' });
 * ```
 */
export function createMockLogger(): MockLogger {
  const logger: MockLogger = {
    silly: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    scoped: (hint) => scopedTestLogger(logger, hint),
  };
  return logger;
}

/**
 * Create a mock logging service with vitest spy methods.
 *
 * @returns Mock logging service that tracks created loggers
 *
 * @example
 * ```typescript
 * const loggingService = createMockLogging();
 * const gitLogger = loggingService.createLogger('git');
 *
 * // After running code that uses the logger:
 * expect(loggingService.getCreatedLoggerNames()).toContain('git');
 * expect(loggingService.getLogger('git')?.info).toHaveBeenCalled();
 * ```
 */
export function createMockLogging(): MockLogging {
  const loggers = new Map<LoggerName, MockLogger>();

  const service: MockLogging = {
    createLogger: vi.fn((name: LoggerName): Logger => {
      const existing = loggers.get(name);
      if (existing) {
        return existing;
      }
      const logger = createMockLogger();
      loggers.set(name, logger);
      return logger;
    }),

    configure: vi.fn(),
    initialize: vi.fn(),
    scope: new AsyncLogScopeStore(),
    onLine: vi.fn(() => () => {}),
    getLogFilePath: vi.fn().mockReturnValue("/mock/logs/test-session.log"),

    getCreatedLoggerNames(): LoggerName[] {
      return Array.from(loggers.keys());
    },

    getLogger(name: LoggerName): MockLogger | undefined {
      return loggers.get(name);
    },
  };

  return service;
}

/**
 * Silent no-op logger instance.
 * Use this when you need a logger that does nothing (e.g., as a default when no logger is provided).
 * This is a shared singleton - safe because the logger has no state.
 */
export const SILENT_LOGGER: Logger = {
  silly: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  scoped: () => SILENT_LOGGER,
};

// ============================================================================
// Behavioral Logger Mock
// ============================================================================

/**
 * Logged message type for behavioral testing.
 */
export interface LoggedMessage {
  readonly level: "silly" | "debug" | "info" | "warn" | "error";
  readonly message: string;
  readonly context?: LogContext | undefined;
}

/**
 * Behavioral logger that stores messages for verification.
 * Use this to verify logged output in integration tests.
 */
export interface BehavioralLogger extends Logger {
  /**
   * Get all logged messages.
   */
  getMessages(): readonly LoggedMessage[];

  /**
   * Get messages filtered by level.
   */
  getMessagesByLevel(level: LoggedMessage["level"]): readonly LoggedMessage[];

  /**
   * Clear all logged messages.
   */
  clear(): void;
}

/**
 * Create a behavioral logger that stores messages for verification.
 *
 * Unlike mock loggers that track calls, this logger stores actual messages
 * for behavioral testing - verifying what was logged rather than how many
 * times a method was called.
 *
 * @returns Behavioral logger with message storage
 *
 * @example
 * ```typescript
 * const logger = createBehavioralLogger();
 * const service = new MyService(logger);
 *
 * await service.doWork();
 *
 * const messages = logger.getMessages();
 * expect(messages).toContainEqual({
 *   level: 'info',
 *   message: 'Work complete',
 *   context: { result: 'success' },
 * });
 * ```
 */
export function createBehavioralLogger(): BehavioralLogger {
  const messages: LoggedMessage[] = [];

  const logger: BehavioralLogger = {
    silly: (message: string, context?: LogContext) => {
      messages.push({ level: "silly", message, context });
    },
    debug: (message: string, context?: LogContext) => {
      messages.push({ level: "debug", message, context });
    },
    info: (message: string, context?: LogContext) => {
      messages.push({ level: "info", message, context });
    },
    warn: (message: string, context?: LogContext) => {
      messages.push({ level: "warn", message, context });
    },
    error: (message: string, context?: LogContext) => {
      messages.push({ level: "error", message, context });
    },
    getMessages: () => [...messages],
    getMessagesByLevel: (level) => messages.filter((m) => m.level === level),
    clear: () => {
      messages.length = 0;
    },
    scoped: (hint) => scopedTestLogger(logger, hint),
  };
  return logger;
}
