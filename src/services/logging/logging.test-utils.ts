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
