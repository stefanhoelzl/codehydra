/**
 * Unit tests for ElectronLogService.
 *
 * Note: These tests mock electron-log to verify configuration logic.
 * Boundary tests verify actual file writing behavior.
 */

import { join, sep } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockPathProvider } from "../platform/path-provider.test-utils";
import type { LoggingConfigureOptions } from "./types";

// Mock electron-log/main
const mockScope = vi.fn();
const mockInitialize = vi.fn();
const mockTransports = {
  file: {
    resolvePathFn: undefined as ((variables: unknown) => string) | undefined,
    level: undefined as string | false | undefined,
    format: undefined as string | undefined,
  },
  console: {
    level: undefined as string | false | undefined,
    format: undefined as string | undefined,
  },
};

vi.mock("electron-log/main", () => ({
  default: {
    scope: mockScope,
    initialize: mockInitialize,
    transports: mockTransports,
  },
}));

describe("ElectronLogService", () => {
  beforeEach(() => {
    vi.resetAllMocks();

    // Reset transport config
    mockTransports.file.resolvePathFn = undefined;
    mockTransports.file.level = undefined;
    mockTransports.file.format = undefined;
    mockTransports.console.level = undefined;
    mockTransports.console.format = undefined;

    // Mock scope to return a mock logger
    mockScope.mockReturnValue({
      silly: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    });
  });

  const DEFAULT_OPTIONS: LoggingConfigureOptions = {
    logLevel: "debug",
    enableConsole: false,
    allowedLoggers: undefined,
  };

  async function createService(options?: {
    configureOptions?: LoggingConfigureOptions;
    dataRootDir?: string;
    skipConfigure?: boolean;
  }) {
    const { ElectronLogService } = await import("./electron-log-service");
    const pathProvider = createMockPathProvider({
      dataRootDir: options?.dataRootDir ?? "/test/app-data",
    });
    const service = new ElectronLogService(pathProvider);
    if (!options?.skipConfigure) {
      service.configure(options?.configureOptions ?? DEFAULT_OPTIONS);
    }
    return service;
  }

  describe("log level configuration", () => {
    it("uses configured log level for file transport", async () => {
      await createService({ configureOptions: { ...DEFAULT_OPTIONS, logLevel: "debug" } });
      expect(mockTransports.file.level).toBe("debug");
    });

    it("uses warn level when configured", async () => {
      await createService({ configureOptions: { ...DEFAULT_OPTIONS, logLevel: "warn" } });
      expect(mockTransports.file.level).toBe("warn");
    });

    it("uses info level when configured", async () => {
      await createService({ configureOptions: { ...DEFAULT_OPTIONS, logLevel: "info" } });
      expect(mockTransports.file.level).toBe("info");
    });

    it("uses error level when configured", async () => {
      await createService({ configureOptions: { ...DEFAULT_OPTIONS, logLevel: "error" } });
      expect(mockTransports.file.level).toBe("error");
    });

    it("uses silly level when configured", async () => {
      await createService({ configureOptions: { ...DEFAULT_OPTIONS, logLevel: "silly" } });
      expect(mockTransports.file.level).toBe("silly");
    });
  });

  describe("console transport configuration", () => {
    it("disables console when enableConsole is false", async () => {
      await createService({
        configureOptions: { ...DEFAULT_OPTIONS, enableConsole: false },
      });
      expect(mockTransports.console.level).toBe(false);
    });

    it("enables console at log level when enableConsole is true", async () => {
      await createService({
        configureOptions: { ...DEFAULT_OPTIONS, logLevel: "debug", enableConsole: true },
      });
      expect(mockTransports.console.level).toBe("debug");
    });

    it("console level matches file level when enabled", async () => {
      await createService({
        configureOptions: { ...DEFAULT_OPTIONS, logLevel: "warn", enableConsole: true },
      });
      expect(mockTransports.console.level).toBe("warn");
    });
  });

  describe("file path configuration", () => {
    it("configures log file path in logs directory", async () => {
      await createService({ dataRootDir: "/test/app-data" });
      expect(mockTransports.file.resolvePathFn).toBeDefined();

      const pathFn = mockTransports.file.resolvePathFn!;
      const logPath = pathFn({});

      // Uses join() internally so paths have platform-specific separators
      const expectedPrefix = join("/test/app-data", "logs") + sep;
      expect(logPath.startsWith(expectedPrefix)).toBe(true);
      expect(logPath).toMatch(/\.log$/);
    });

    it("uses session-based filename format", async () => {
      await createService();
      const pathFn = mockTransports.file.resolvePathFn!;
      const logPath = pathFn({});

      // Should match: YYYY-MM-DDTHH-MM-SS-<uuid>.log
      // Use path.sep to split cross-platform
      const filename = logPath.split(sep).pop();
      expect(filename).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[a-f0-9]{8}\.log$/);
    });
  });

  describe("log format configuration", () => {
    it("configures file format with timestamp, level, scope, and message", async () => {
      await createService();
      expect(mockTransports.file.format).toBe(
        "[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {scope} {text}"
      );
    });

    it("configures console format matching file format", async () => {
      await createService();
      expect(mockTransports.console.format).toBe(
        "[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {scope} {text}"
      );
    });
  });

  describe("createLogger", () => {
    it("creates logger with scope", async () => {
      const service = await createService();
      service.createLogger("git");

      expect(mockScope).toHaveBeenCalledWith("[git]");
    });

    it("caches loggers for same name", async () => {
      const service = await createService();
      const logger1 = service.createLogger("git");
      const logger2 = service.createLogger("git");

      expect(logger1).toBe(logger2);
      expect(mockScope).toHaveBeenCalledTimes(1);
    });

    it("creates separate loggers for different names", async () => {
      const service = await createService();
      service.createLogger("git");
      service.createLogger("process");

      expect(mockScope).toHaveBeenCalledTimes(2);
      expect(mockScope).toHaveBeenCalledWith("[git]");
      expect(mockScope).toHaveBeenCalledWith("[process]");
    });
  });

  describe("initialize", () => {
    it("calls electron-log initialize", async () => {
      const service = await createService();
      service.initialize();

      expect(mockInitialize).toHaveBeenCalled();
    });
  });

  describe("dispose", () => {
    it("clears logger cache", async () => {
      const service = await createService();
      service.createLogger("git");
      service.createLogger("process");

      service.dispose();

      // Creating logger again should call scope again
      mockScope.mockClear();
      service.createLogger("git");
      expect(mockScope).toHaveBeenCalledWith("[git]");
    });
  });

  describe("Logger methods", () => {
    it("calls scope.silly for silly level messages", async () => {
      const scopeLogger = {
        silly: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      mockScope.mockReturnValue(scopeLogger);

      const service = await createService();
      const logger = service.createLogger("network");

      logger.silly("Scan details", { count: 5 });

      expect(scopeLogger.silly).toHaveBeenCalledWith("Scan details count=5");
    });

    it("formats context as key=value pairs", async () => {
      const scopeLogger = {
        silly: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      mockScope.mockReturnValue(scopeLogger);

      const service = await createService();
      const logger = service.createLogger("git");

      logger.info("Clone complete", { repo: "myrepo", branch: "main" });

      expect(scopeLogger.info).toHaveBeenCalledWith("Clone complete repo=myrepo branch=main");
    });

    it("handles null values in context", async () => {
      const scopeLogger = {
        silly: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      mockScope.mockReturnValue(scopeLogger);

      const service = await createService();
      const logger = service.createLogger("git");

      logger.debug("Operation", { value: null });

      expect(scopeLogger.debug).toHaveBeenCalledWith("Operation value=null");
    });

    it("handles boolean values in context", async () => {
      const scopeLogger = {
        silly: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      mockScope.mockReturnValue(scopeLogger);

      const service = await createService();
      const logger = service.createLogger("git");

      logger.info("Status", { dirty: true, clean: false });

      expect(scopeLogger.info).toHaveBeenCalledWith("Status dirty=true clean=false");
    });

    it("handles numeric values in context", async () => {
      const scopeLogger = {
        silly: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      mockScope.mockReturnValue(scopeLogger);

      const service = await createService();
      const logger = service.createLogger("api");

      logger.debug("Request", { duration: 123, count: 5 });

      expect(scopeLogger.debug).toHaveBeenCalledWith("Request duration=123 count=5");
    });

    it("handles message without context", async () => {
      const scopeLogger = {
        silly: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      mockScope.mockReturnValue(scopeLogger);

      const service = await createService();
      const logger = service.createLogger("app");

      logger.info("Services started");

      expect(scopeLogger.info).toHaveBeenCalledWith("Services started");
    });

    it("includes Error stack in error logs", async () => {
      const scopeLogger = {
        silly: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      mockScope.mockReturnValue(scopeLogger);

      const service = await createService();
      const logger = service.createLogger("app");
      const testError = new Error("Test error");

      logger.error("Operation failed", { op: "test" }, testError);

      expect(scopeLogger.error).toHaveBeenCalledWith("Operation failed op=test", testError);
    });

    it("logs error without Error object", async () => {
      const scopeLogger = {
        silly: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      mockScope.mockReturnValue(scopeLogger);

      const service = await createService();
      const logger = service.createLogger("app");

      logger.error("Something wrong", { code: "ERR123" });

      expect(scopeLogger.error).toHaveBeenCalledWith("Something wrong code=ERR123");
    });
  });

  describe("logger filtering", () => {
    it("logs from all loggers when allowedLoggers is undefined", async () => {
      const scopeLogger = {
        silly: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      mockScope.mockReturnValue(scopeLogger);

      const service = await createService({
        configureOptions: { ...DEFAULT_OPTIONS, allowedLoggers: undefined },
      });
      const logger = service.createLogger("git");

      logger.info("Test message");

      expect(scopeLogger.info).toHaveBeenCalledWith("Test message");
    });

    it("filters loggers based on allowedLoggers set", async () => {
      const scopeLogger = {
        silly: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      mockScope.mockReturnValue(scopeLogger);

      const service = await createService({
        configureOptions: {
          ...DEFAULT_OPTIONS,
          allowedLoggers: new Set(["process", "network"] as const),
        },
      });
      const gitLogger = service.createLogger("git");
      const processLogger = service.createLogger("process");

      gitLogger.info("Git message");
      processLogger.info("Process message");

      // git is not in the allowed list, so it should not log
      expect(scopeLogger.info).toHaveBeenCalledTimes(1);
      expect(scopeLogger.info).toHaveBeenCalledWith("Process message");
    });

    it("allows specified loggers in filter", async () => {
      const scopeLogger = {
        silly: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      mockScope.mockReturnValue(scopeLogger);

      const service = await createService({
        configureOptions: {
          ...DEFAULT_OPTIONS,
          allowedLoggers: new Set(["git", "fs"] as const),
        },
      });
      const gitLogger = service.createLogger("git");

      gitLogger.debug("Debug message");
      gitLogger.info("Info message");
      gitLogger.warn("Warn message");
      gitLogger.error("Error message");

      expect(scopeLogger.debug).toHaveBeenCalledWith("Debug message");
      expect(scopeLogger.info).toHaveBeenCalledWith("Info message");
      expect(scopeLogger.warn).toHaveBeenCalledWith("Warn message");
      expect(scopeLogger.error).toHaveBeenCalledWith("Error message");
    });

    it("suppresses all log levels for filtered-out loggers", async () => {
      const scopeLogger = {
        silly: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      mockScope.mockReturnValue(scopeLogger);

      const service = await createService({
        configureOptions: {
          ...DEFAULT_OPTIONS,
          allowedLoggers: new Set(["network"] as const),
        },
      });
      const gitLogger = service.createLogger("git");
      const testError = new Error("Test");

      gitLogger.silly("Silly");
      gitLogger.debug("Debug");
      gitLogger.info("Info");
      gitLogger.warn("Warn");
      gitLogger.error("Error", {}, testError);

      expect(scopeLogger.silly).not.toHaveBeenCalled();
      expect(scopeLogger.debug).not.toHaveBeenCalled();
      expect(scopeLogger.info).not.toHaveBeenCalled();
      expect(scopeLogger.warn).not.toHaveBeenCalled();
      expect(scopeLogger.error).not.toHaveBeenCalled();
    });
  });

  describe("QueuedLogger buffering", () => {
    it("transports start silent before configure()", async () => {
      await createService({ skipConfigure: true });
      expect(mockTransports.file.level).toBe(false);
      expect(mockTransports.console.level).toBe(false);
    });

    it("buffers entries before configure() and flushes after", async () => {
      const scopeLogger = {
        silly: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      mockScope.mockReturnValue(scopeLogger);

      const { ElectronLogService } = await import("./electron-log-service");
      const pathProvider = createMockPathProvider({ dataRootDir: "/test/app-data" });
      const service = new ElectronLogService(pathProvider);

      const logger = service.createLogger("git");
      logger.info("Before configure");
      logger.debug("Also before");

      // Not flushed yet
      expect(scopeLogger.info).not.toHaveBeenCalled();
      expect(scopeLogger.debug).not.toHaveBeenCalled();

      service.configure(DEFAULT_OPTIONS);

      // Now flushed
      expect(scopeLogger.info).toHaveBeenCalledWith("Before configure");
      expect(scopeLogger.debug).toHaveBeenCalledWith("Also before");
    });

    it("flushes entries in order", async () => {
      const calls: string[] = [];
      const scopeLogger = {
        silly: vi.fn(),
        debug: vi.fn((msg: string) => calls.push(`debug:${msg}`)),
        info: vi.fn((msg: string) => calls.push(`info:${msg}`)),
        warn: vi.fn((msg: string) => calls.push(`warn:${msg}`)),
        error: vi.fn(),
      };
      mockScope.mockReturnValue(scopeLogger);

      const { ElectronLogService } = await import("./electron-log-service");
      const pathProvider = createMockPathProvider({ dataRootDir: "/test/app-data" });
      const service = new ElectronLogService(pathProvider);

      const logger = service.createLogger("app");
      logger.info("First");
      logger.debug("Second");
      logger.warn("Third");

      service.configure(DEFAULT_OPTIONS);

      expect(calls).toEqual(["info:First", "debug:Second", "warn:Third"]);
    });

    it("logger created after configure() delegates immediately", async () => {
      const scopeLogger = {
        silly: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      mockScope.mockReturnValue(scopeLogger);

      const service = await createService();
      const logger = service.createLogger("git");

      logger.info("Immediate");

      expect(scopeLogger.info).toHaveBeenCalledWith("Immediate");
    });

    it("consumer reference stays valid across configure()", async () => {
      const scopeLogger = {
        silly: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      mockScope.mockReturnValue(scopeLogger);

      const { ElectronLogService } = await import("./electron-log-service");
      const pathProvider = createMockPathProvider({ dataRootDir: "/test/app-data" });
      const service = new ElectronLogService(pathProvider);

      // Get reference before configure
      const logger = service.createLogger("git");

      service.configure(DEFAULT_OPTIONS);

      // Same reference works after configure
      logger.info("After configure");
      expect(scopeLogger.info).toHaveBeenCalledWith("After configure");
    });

    it("configure() can be called multiple times (reconfigures)", async () => {
      const { ElectronLogService } = await import("./electron-log-service");
      const pathProvider = createMockPathProvider({ dataRootDir: "/test/app-data" });
      const service = new ElectronLogService(pathProvider);

      service.configure({ logLevel: "debug", enableConsole: false, allowedLoggers: undefined });
      expect(mockTransports.file.level).toBe("debug");

      service.configure({ logLevel: "warn", enableConsole: true, allowedLoggers: undefined });
      expect(mockTransports.file.level).toBe("warn");
      expect(mockTransports.console.level).toBe("warn");
    });

    it("error entries flush with error object intact", async () => {
      const scopeLogger = {
        silly: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      mockScope.mockReturnValue(scopeLogger);

      const { ElectronLogService } = await import("./electron-log-service");
      const pathProvider = createMockPathProvider({ dataRootDir: "/test/app-data" });
      const service = new ElectronLogService(pathProvider);

      const logger = service.createLogger("app");
      const testError = new Error("Test error");
      logger.error("Failed", { op: "test" }, testError);

      service.configure(DEFAULT_OPTIONS);

      expect(scopeLogger.error).toHaveBeenCalledWith("Failed op=test", testError);
    });
  });

  describe("parseLogLevel", () => {
    it("parses valid log levels", async () => {
      const { parseLogLevel } = await import("./electron-log-service");
      expect(parseLogLevel("debug")).toBe("debug");
      expect(parseLogLevel("info")).toBe("info");
      expect(parseLogLevel("warn")).toBe("warn");
      expect(parseLogLevel("error")).toBe("error");
      expect(parseLogLevel("silly")).toBe("silly");
    });

    it("handles uppercase input", async () => {
      const { parseLogLevel } = await import("./electron-log-service");
      expect(parseLogLevel("ERROR")).toBe("error");
      expect(parseLogLevel("DEBUG")).toBe("debug");
    });

    it("handles whitespace", async () => {
      const { parseLogLevel } = await import("./electron-log-service");
      expect(parseLogLevel("  info  ")).toBe("info");
    });

    it("returns undefined for invalid input", async () => {
      const { parseLogLevel } = await import("./electron-log-service");
      expect(parseLogLevel("invalid")).toBeUndefined();
      expect(parseLogLevel("")).toBeUndefined();
      expect(parseLogLevel(undefined)).toBeUndefined();
    });
  });

  describe("parseLoggerFilter", () => {
    it("parses comma-separated logger names", async () => {
      const { parseLoggerFilter } = await import("./electron-log-service");
      const result = parseLoggerFilter("git,process,fs");
      expect(result).toEqual(new Set(["git", "process", "fs"]));
    });

    it("handles whitespace in names", async () => {
      const { parseLoggerFilter } = await import("./electron-log-service");
      const result = parseLoggerFilter("  git , process  ");
      expect(result).toEqual(new Set(["git", "process"]));
    });

    it("returns undefined for empty or undefined input", async () => {
      const { parseLoggerFilter } = await import("./electron-log-service");
      expect(parseLoggerFilter(undefined)).toBeUndefined();
      expect(parseLoggerFilter("")).toBeUndefined();
    });

    it("returns undefined for whitespace-only input", async () => {
      const { parseLoggerFilter } = await import("./electron-log-service");
      expect(parseLoggerFilter("  ,  ,  ")).toBeUndefined();
    });
  });
});
