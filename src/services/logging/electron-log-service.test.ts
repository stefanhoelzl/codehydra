/**
 * Unit tests for ElectronLogService.
 *
 * Note: These tests mock electron-log to verify configuration logic.
 * Boundary tests verify actual file writing behavior.
 */

import { join, sep } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockBuildInfo } from "../platform/build-info.test-utils";
import { createMockPathProvider } from "../platform/path-provider.test-utils";

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
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    process.env = { ...originalEnv };
    delete process.env.CODEHYDRA_LOGLEVEL;
    delete process.env.CODEHYDRA_PRINT_LOGS;
    delete process.env.CODEHYDRA_LOGGER;

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

  afterEach(() => {
    process.env = originalEnv;
  });

  async function createService(options?: { isDevelopment?: boolean; dataRootDir?: string }) {
    const { ElectronLogService } = await import("./electron-log-service");
    const buildInfo = createMockBuildInfo({
      isDevelopment: options?.isDevelopment ?? true,
    });
    const pathProvider = createMockPathProvider({
      dataRootDir: options?.dataRootDir ?? "/test/app-data",
    });
    return new ElectronLogService(buildInfo, pathProvider);
  }

  describe("log level configuration", () => {
    it("uses DEBUG level in dev mode", async () => {
      await createService({ isDevelopment: true });
      expect(mockTransports.file.level).toBe("debug");
    });

    it("uses WARN level in packaged mode", async () => {
      await createService({ isDevelopment: false });
      expect(mockTransports.file.level).toBe("warn");
    });

    it("respects CODEHYDRA_LOGLEVEL env var", async () => {
      process.env.CODEHYDRA_LOGLEVEL = "info";
      await createService({ isDevelopment: true });
      expect(mockTransports.file.level).toBe("info");
    });

    it("handles uppercase CODEHYDRA_LOGLEVEL", async () => {
      process.env.CODEHYDRA_LOGLEVEL = "ERROR";
      await createService({ isDevelopment: true });
      expect(mockTransports.file.level).toBe("error");
    });

    it("handles invalid CODEHYDRA_LOGLEVEL by falling back to default", async () => {
      process.env.CODEHYDRA_LOGLEVEL = "invalid";
      await createService({ isDevelopment: true });
      // Falls back to debug (dev mode default)
      expect(mockTransports.file.level).toBe("debug");
    });

    it("handles empty CODEHYDRA_LOGLEVEL by falling back to default", async () => {
      process.env.CODEHYDRA_LOGLEVEL = "";
      await createService({ isDevelopment: false });
      // Falls back to warn (prod mode default)
      expect(mockTransports.file.level).toBe("warn");
    });

    it("respects CODEHYDRA_LOGLEVEL=silly", async () => {
      process.env.CODEHYDRA_LOGLEVEL = "silly";
      await createService({ isDevelopment: true });
      expect(mockTransports.file.level).toBe("silly");
    });
  });

  describe("console transport configuration", () => {
    it("disables console by default", async () => {
      await createService();
      expect(mockTransports.console.level).toBe(false);
    });

    it("enables console when PRINT_LOGS=true", async () => {
      process.env.CODEHYDRA_PRINT_LOGS = "true";
      await createService({ isDevelopment: true });
      expect(mockTransports.console.level).toBe("debug");
    });

    it("enables console with uppercase TRUE", async () => {
      process.env.CODEHYDRA_PRINT_LOGS = "TRUE";
      await createService({ isDevelopment: true });
      expect(mockTransports.console.level).toBe("debug");
    });

    it("enables console for PRINT_LOGS=1", async () => {
      process.env.CODEHYDRA_PRINT_LOGS = "1";
      await createService({ isDevelopment: true });
      expect(mockTransports.console.level).toBe("debug");
    });

    it("enables console for PRINT_LOGS=yes", async () => {
      process.env.CODEHYDRA_PRINT_LOGS = "yes";
      await createService({ isDevelopment: true });
      expect(mockTransports.console.level).toBe("debug");
    });

    it("enables console for any non-empty string", async () => {
      process.env.CODEHYDRA_PRINT_LOGS = "anything";
      await createService({ isDevelopment: true });
      expect(mockTransports.console.level).toBe("debug");
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
      // e.g., 2025-12-16T10-30-00-abc12345.log
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

  describe("CODEHYDRA_LOGGER filtering", () => {
    it("logs from all loggers when CODEHYDRA_LOGGER is not set", async () => {
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

      logger.info("Test message");

      expect(scopeLogger.info).toHaveBeenCalledWith("Test message");
    });

    it("filters loggers based on CODEHYDRA_LOGGER env var", async () => {
      process.env.CODEHYDRA_LOGGER = "process,network";
      const scopeLogger = {
        silly: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      mockScope.mockReturnValue(scopeLogger);

      const service = await createService();
      const gitLogger = service.createLogger("git");
      const processLogger = service.createLogger("process");

      gitLogger.info("Git message");
      processLogger.info("Process message");

      // git is not in the allowed list, so it should not log
      expect(scopeLogger.info).toHaveBeenCalledTimes(1);
      expect(scopeLogger.info).toHaveBeenCalledWith("Process message");
    });

    it("allows specified loggers in filter", async () => {
      process.env.CODEHYDRA_LOGGER = "git,fs";
      const scopeLogger = {
        silly: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      mockScope.mockReturnValue(scopeLogger);

      const service = await createService();
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

    it("handles whitespace in CODEHYDRA_LOGGER", async () => {
      process.env.CODEHYDRA_LOGGER = "  git , process  ";
      const scopeLogger = {
        silly: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      mockScope.mockReturnValue(scopeLogger);

      const service = await createService();
      const gitLogger = service.createLogger("git");

      gitLogger.info("Test");

      expect(scopeLogger.info).toHaveBeenCalled();
    });

    it("handles empty CODEHYDRA_LOGGER by allowing all loggers", async () => {
      process.env.CODEHYDRA_LOGGER = "";
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

      logger.info("Test message");

      expect(scopeLogger.info).toHaveBeenCalledWith("Test message");
    });

    it("suppresses all log levels for filtered-out loggers", async () => {
      process.env.CODEHYDRA_LOGGER = "network";
      const scopeLogger = {
        silly: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      mockScope.mockReturnValue(scopeLogger);

      const service = await createService();
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
});
