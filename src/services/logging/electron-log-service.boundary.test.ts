/**
 * Boundary tests for ElectronLogService.
 *
 * These tests verify actual file writing behavior with electron-log.
 * They create real log files in a temporary directory.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockPathProvider } from "../platform/path-provider.test-utils";
import type { PathProvider } from "../platform/path-provider";
import type { LoggingConfigureOptions } from "./types";

// Test timeout for file operations
const WRITE_DELAY_MS = 100;

const DEFAULT_OPTIONS: LoggingConfigureOptions = {
  logLevel: "debug",
  enableConsole: false,
  allowedLoggers: undefined,
};

/**
 * Create a minimal PathProvider for boundary tests.
 * Uses createMockPathProvider with the temp directory as dataRootDir.
 */
function createTestPathProvider(dataRootDir: string): PathProvider {
  return createMockPathProvider({
    dataRootDir,
  });
}

/**
 * Wait for electron-log to flush to file.
 */
async function waitForWrite(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, WRITE_DELAY_MS));
}

describe("ElectronLogService boundary tests", () => {
  let tempDir: string;
  let logsDir: string;

  beforeEach(async () => {
    // Create temp directory for each test
    tempDir = await mkdtemp(join(tmpdir(), "codehydra-log-test-"));
    logsDir = join(tempDir, "logs");
  });

  afterEach(async () => {
    // Clean up temp directory
    await rm(tempDir, { recursive: true, force: true });

    // Reset module cache to get fresh electron-log instance
    // This is important because electron-log maintains global state
    const moduleId = Object.keys(require.cache).find((key) => key.includes("electron-log-service"));
    if (moduleId) {
      delete require.cache[moduleId];
    }
  });

  it("creates log directory if not exists", async () => {
    const { ElectronLogService } = await import("./electron-log-service");
    const pathProvider = createTestPathProvider(tempDir);

    const service = new ElectronLogService(pathProvider);
    service.configure(DEFAULT_OPTIONS);
    const logger = service.createLogger("app");

    logger.info("Test message");
    await waitForWrite();

    const files = await readdir(logsDir);
    expect(files.length).toBe(1);
  });

  it("writes to log file with session-based filename", async () => {
    const { ElectronLogService } = await import("./electron-log-service");
    const pathProvider = createTestPathProvider(tempDir);

    const service = new ElectronLogService(pathProvider);
    service.configure(DEFAULT_OPTIONS);
    const logger = service.createLogger("app");

    logger.info("Test message");
    await waitForWrite();

    const files = await readdir(logsDir);
    expect(files.length).toBe(1);

    // Verify filename format: YYYY-MM-DDTHH-MM-SS-<uuid>.log
    const filename = files[0];
    expect(filename).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[a-f0-9]{8}\.log$/);
  });

  it("log format matches specification", async () => {
    const { ElectronLogService } = await import("./electron-log-service");
    const pathProvider = createTestPathProvider(tempDir);

    const service = new ElectronLogService(pathProvider);
    service.configure(DEFAULT_OPTIONS);
    const logger = service.createLogger("git");

    logger.info("Clone complete", { repo: "test-repo", branch: "main" });
    await waitForWrite();

    const files = await readdir(logsDir);
    expect(files[0]).toBeDefined();
    const logContent = await readFile(join(logsDir, files[0] as string), "utf-8");

    // Verify format: [timestamp] [level] (scope) message context
    // e.g., [2025-12-16 10:30:00.123] [info]   (git) Clone complete repo=test-repo branch=main
    expect(logContent).toMatch(
      /\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] \[info\].*\(git\).*Clone complete repo=test-repo branch=main/
    );
  });

  it("filters by level - DEBUG not written when level is WARN", async () => {
    const { ElectronLogService } = await import("./electron-log-service");
    const pathProvider = createTestPathProvider(tempDir);

    const service = new ElectronLogService(pathProvider);
    service.configure({ ...DEFAULT_OPTIONS, logLevel: "warn" });
    const logger = service.createLogger("app");

    logger.debug("Debug message - should not appear");
    logger.info("Info message - should not appear");
    logger.warn("Warning message - should appear");
    await waitForWrite();

    const files = await readdir(logsDir);
    expect(files[0]).toBeDefined();
    const logContent = await readFile(join(logsDir, files[0] as string), "utf-8");

    expect(logContent).not.toContain("Debug message");
    expect(logContent).not.toContain("Info message");
    expect(logContent).toContain("Warning message");
  });

  it("writes all levels when level is DEBUG", async () => {
    const { ElectronLogService } = await import("./electron-log-service");
    const pathProvider = createTestPathProvider(tempDir);

    const service = new ElectronLogService(pathProvider);
    service.configure(DEFAULT_OPTIONS);
    const logger = service.createLogger("app");

    logger.debug("Debug message");
    logger.info("Info message");
    logger.warn("Warning message");
    logger.error("Error message");
    await waitForWrite();

    const files = await readdir(logsDir);
    expect(files[0]).toBeDefined();
    const logContent = await readFile(join(logsDir, files[0] as string), "utf-8");

    expect(logContent).toContain("Debug message");
    expect(logContent).toContain("Info message");
    expect(logContent).toContain("Warning message");
    expect(logContent).toContain("Error message");
  });

  it("includes Error stack in error logs", async () => {
    const { ElectronLogService } = await import("./electron-log-service");
    const pathProvider = createTestPathProvider(tempDir);

    const service = new ElectronLogService(pathProvider);
    service.configure(DEFAULT_OPTIONS);
    const logger = service.createLogger("app");

    const testError = new Error("Test error message");
    logger.error("Operation failed", { op: "test" }, testError);
    await waitForWrite();

    const files = await readdir(logsDir);
    expect(files[0]).toBeDefined();
    const logContent = await readFile(join(logsDir, files[0] as string), "utf-8");

    expect(logContent).toContain("Operation failed");
    expect(logContent).toContain("Test error message");
  });

  it("uses configured path for log files", async () => {
    const { ElectronLogService } = await import("./electron-log-service");
    const pathProvider = createTestPathProvider(tempDir);

    const service = new ElectronLogService(pathProvider);
    service.configure(DEFAULT_OPTIONS);
    const logger = service.createLogger("app");

    logger.info("Test");
    await waitForWrite();

    // Verify logs are in the expected location
    const files = await readdir(logsDir);
    expect(files.length).toBe(1);
    expect(logsDir).toBe(join(tempDir, "logs"));
  });

  it("flushes buffered entries to file after configure()", async () => {
    const { ElectronLogService } = await import("./electron-log-service");
    const pathProvider = createTestPathProvider(tempDir);

    const service = new ElectronLogService(pathProvider);
    const logger = service.createLogger("app");

    // Log before configure — entries are buffered
    logger.info("Buffered message");

    // Configure — flushes buffered entries
    service.configure(DEFAULT_OPTIONS);
    await waitForWrite();

    const files = await readdir(logsDir);
    expect(files[0]).toBeDefined();
    const logContent = await readFile(join(logsDir, files[0] as string), "utf-8");

    expect(logContent).toContain("Buffered message");
  });
});
