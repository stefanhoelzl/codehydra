/**
 * Mock utilities for logging tests.
 *
 * Provides mock logger and logging service factories for unit testing
 * services that depend on the Logger interface.
 */

import { vi, type Mock } from "vitest";
import type { Logger, LoggerName, LoggingService, LogContext } from "./types";

/**
 * Mock logger with vitest spy methods.
 * All method calls are recorded for assertion.
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
export interface MockLoggingService extends LoggingService {
  createLogger: Mock<(name: LoggerName) => Logger>;
  initialize: Mock<() => void>;
  dispose: Mock<() => void>;

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
  return {
    silly: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

/**
 * Create a mock logging service with vitest spy methods.
 *
 * @returns Mock logging service that tracks created loggers
 *
 * @example
 * ```typescript
 * const loggingService = createMockLoggingService();
 * const gitLogger = loggingService.createLogger('git');
 *
 * // After running code that uses the logger:
 * expect(loggingService.getCreatedLoggerNames()).toContain('git');
 * expect(loggingService.getLogger('git')?.info).toHaveBeenCalled();
 * ```
 */
export function createMockLoggingService(): MockLoggingService {
  const loggers = new Map<LoggerName, MockLogger>();

  const service: MockLoggingService = {
    createLogger: vi.fn((name: LoggerName): Logger => {
      const existing = loggers.get(name);
      if (existing) {
        return existing;
      }
      const logger = createMockLogger();
      loggers.set(name, logger);
      return logger;
    }),

    initialize: vi.fn(),
    dispose: vi.fn(),

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
 * Create a silent no-op logger.
 * Useful when you don't want to assert on log calls.
 *
 * @returns Logger that does nothing
 */
export function createSilentLogger(): Logger {
  return {
    silly: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

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

  return {
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
  };
}
