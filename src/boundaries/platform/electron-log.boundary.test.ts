/**
 * Boundary tests for ElectronLog.
 *
 * These tests verify actual file writing behavior with electron-log.
 * They create real log files in a temporary directory.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockPathProvider } from "./path-provider.test-utils";
import type { LoggingConfigureOptions, LogLine } from "./logging-types";
import { ElectronLog } from "./electron-log";

// Test timeout for file operations
const WRITE_DELAY_MS = 100;

const DEFAULT_OPTIONS: LoggingConfigureOptions = {
  logLevel: "debug",
  logFile: true,
  logConsole: false,
  allowedLoggers: undefined,
  logFormat: "text",
};

/**
 * Wait for electron-log to flush to file.
 */
async function waitForWrite(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, WRITE_DELAY_MS));
}

describe("ElectronLog boundary tests", () => {
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
    const moduleId = Object.keys(require.cache).find((key) => key.includes("electron-log"));
    if (moduleId) {
      delete require.cache[moduleId];
    }
  });

  it("creates log directory if not exists", async () => {
    const pathProvider = createMockPathProvider({ dataRootDir: tempDir });

    const service = new ElectronLog(pathProvider);
    service.configure(DEFAULT_OPTIONS);
    const logger = service.createLogger("app");

    logger.info("Test message");
    await waitForWrite();

    const files = await readdir(logsDir);
    expect(files.length).toBe(1);
  });

  it("writes to log file with session-based filename", async () => {
    const pathProvider = createMockPathProvider({ dataRootDir: tempDir });

    const service = new ElectronLog(pathProvider);
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
    const pathProvider = createMockPathProvider({ dataRootDir: tempDir });

    const service = new ElectronLog(pathProvider);
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
    const pathProvider = createMockPathProvider({ dataRootDir: tempDir });

    const service = new ElectronLog(pathProvider);
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
    const pathProvider = createMockPathProvider({ dataRootDir: tempDir });

    const service = new ElectronLog(pathProvider);
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
    const pathProvider = createMockPathProvider({ dataRootDir: tempDir });

    const service = new ElectronLog(pathProvider);
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
    const pathProvider = createMockPathProvider({ dataRootDir: tempDir });

    const service = new ElectronLog(pathProvider);
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
    const pathProvider = createMockPathProvider({ dataRootDir: tempDir });

    const service = new ElectronLog(pathProvider);
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

  /** Read the single log file written by a test. */
  async function readLogFile(): Promise<string> {
    const files = await readdir(logsDir);
    expect(files[0]).toBeDefined();
    return readFile(join(logsDir, files[0] as string), "utf-8");
  }

  describe("logger filtering", () => {
    it("writes from every logger when allowedLoggers is undefined", async () => {
      const service = new ElectronLog(createMockPathProvider({ dataRootDir: tempDir }));
      service.configure({ ...DEFAULT_OPTIONS, allowedLoggers: undefined });

      service.createLogger("git").info("from git");
      service.createLogger("network").info("from network");
      await waitForWrite();

      const logContent = await readLogFile();
      expect(logContent).toContain("from git");
      expect(logContent).toContain("from network");
    });

    it("writes only from loggers in allowedLoggers", async () => {
      const service = new ElectronLog(createMockPathProvider({ dataRootDir: tempDir }));
      service.configure({ ...DEFAULT_OPTIONS, allowedLoggers: new Set(["git"]) });

      service.createLogger("git").info("from git");
      service.createLogger("network").info("from network");
      await waitForWrite();

      const logContent = await readLogFile();
      expect(logContent).toContain("from git");
      expect(logContent).not.toContain("from network");
    });
  });

  describe("JSON format mode", () => {
    it("writes one JSON object per line with the logger name and message", async () => {
      const service = new ElectronLog(createMockPathProvider({ dataRootDir: tempDir }));
      service.configure({ ...DEFAULT_OPTIONS, logFormat: "json" });

      service.createLogger("git").info("Services started");
      await waitForWrite();

      const line = (await readLogFile()).trim().split("\n")[0] as string;
      const entry = JSON.parse(line) as Record<string, unknown>;

      expect(entry.level).toBe("info");
      expect(entry.scope).toEqual({ logger: "git" });
      expect(entry.message).toBe("Services started");
      expect(entry.context).toBeUndefined();
      expect(typeof entry.timestamp).toBe("string");
    });

    it("keeps context as a structured field rather than appending it to the message", async () => {
      const service = new ElectronLog(createMockPathProvider({ dataRootDir: tempDir }));
      service.configure({ ...DEFAULT_OPTIONS, logFormat: "json" });

      service.createLogger("git").info("Clone complete", { repo: "myrepo", branch: "main" });
      await waitForWrite();

      const entry = JSON.parse((await readLogFile()).trim()) as Record<string, unknown>;

      expect(entry.message).toBe("Clone complete");
      expect(entry.context).toEqual({ repo: "myrepo", branch: "main" });
    });

    it("records context and error separately for error level", async () => {
      const service = new ElectronLog(createMockPathProvider({ dataRootDir: tempDir }));
      service.configure({ ...DEFAULT_OPTIONS, logFormat: "json" });

      service.createLogger("git").error("Failed", { op: "test" }, new Error("boom"));
      await waitForWrite();

      const entry = JSON.parse((await readLogFile()).trim()) as Record<string, unknown>;

      expect(entry.message).toBe("Failed");
      expect(entry.context).toEqual({ op: "test" });
      expect(entry.error).toMatchObject({ message: "boom" });
    });

    it("appends context to the message in text mode", async () => {
      const service = new ElectronLog(createMockPathProvider({ dataRootDir: tempDir }));
      service.configure({ ...DEFAULT_OPTIONS, logFormat: "text" });

      service.createLogger("git").info("Clone complete", { repo: "myrepo" });
      await waitForWrite();

      const logContent = await readLogFile();
      expect(logContent).toContain("Clone complete repo=myrepo");
      expect(() => JSON.parse(logContent.trim())).toThrow();
    });

    it("carries the ambient scope in the scope object, beside the logger name", async () => {
      const service = new ElectronLog(createMockPathProvider({ dataRootDir: tempDir }));
      service.configure({ ...DEFAULT_OPTIONS, logFormat: "json" });

      service.scope.run(
        () => ({ trace: "7f3a01", intent: "workspace:switch", project: "proj", ws: "feat" }),
        () => service.createLogger("git").info("ListBranches", { ref: "main" })
      );
      await waitForWrite();

      const entry = JSON.parse((await readLogFile()).trim()) as Record<string, unknown>;
      expect(entry.scope).toEqual({
        logger: "git",
        trace: "7f3a01",
        intent: "workspace:switch",
        project: "proj",
        ws: "feat",
      });
      expect(entry.context).toEqual({ ref: "main" });
    });
  });

  describe("ambient scope", () => {
    it("writes the scope as a block between the logger name and the message", async () => {
      const service = new ElectronLog(createMockPathProvider({ dataRootDir: tempDir }));
      service.configure(DEFAULT_OPTIONS);

      service.scope.run(
        () => ({
          trace: "7f3a01",
          intent: "workspace:switch",
          project: "proj",
          ws: "feat",
          module: "git-worktree",
          hook: "create",
          origin: "cli",
        }),
        () => service.createLogger("git").info("ListBranches", { ref: "main" })
      );
      await waitForWrite();

      expect(await readLogFile()).toMatch(
        /\(git\)\s+\[7f3a01 proj\/feat workspace:switch@git-worktree\/create cli\] ListBranches ref=main/
      );
    });

    it("writes a line scoped to a named workspace's path under its name", async () => {
      const service = new ElectronLog(createMockPathProvider({ dataRootDir: tempDir }));
      service.configure(DEFAULT_OPTIONS);
      const ws = join(tempDir, "ws", "feat");
      service.scope.nameWorkspace(ws, { project: "proj", ws: "feat" });

      const git = service.createLogger("git");
      git.scoped({ path: ws }).info("Status", { dirty: false });
      git.scoped({ path: join(ws, "src") }).info("Read");
      await waitForWrite();

      const logContent = await readLogFile();
      expect(logContent).toContain("[proj/feat] Status dirty=false");
      expect(logContent).toContain("[proj/feat] Read path=src");
    });

    it("tells line listeners of every line, whatever the level and logger filter", () => {
      const service = new ElectronLog(createMockPathProvider({ dataRootDir: tempDir }));
      service.configure({ ...DEFAULT_OPTIONS, logLevel: "warn", allowedLoggers: new Set(["app"]) });
      const lines: LogLine[] = [];
      const unsubscribe = service.onLine((line) => lines.push(line));

      service.scope.run(
        () => ({ trace: "7f3a01", ws: "feat" }),
        () => service.createLogger("git").debug("below the file's level", { n: 1 })
      );
      unsubscribe();
      service.createLogger("git").warn("after unsubscribing");

      expect(lines).toEqual([
        {
          level: "debug",
          logger: "git",
          scope: { trace: "7f3a01", ws: "feat" },
          message: "below the file's level",
          context: { n: 1 },
          error: undefined,
        },
      ]);
    });

    it("keeps the scope a buffered line was written in, not the one it is flushed in", async () => {
      const service = new ElectronLog(createMockPathProvider({ dataRootDir: tempDir }));
      const logger = service.createLogger("app");

      service.scope.run(
        () => ({ trace: "aaaaaa", intent: "app:start" }),
        () => logger.info("Buffered")
      );
      service.scope.run(
        () => ({ trace: "bbbbbb", intent: "other" }),
        () => service.configure(DEFAULT_OPTIONS)
      );
      await waitForWrite();

      expect(await readLogFile()).toContain("[aaaaaa app:start] Buffered");
    });
  });
});
