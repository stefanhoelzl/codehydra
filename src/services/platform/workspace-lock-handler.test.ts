/**
 * Tests for WorkspaceLockHandler.
 *
 * This file contains:
 * - Integration tests for WindowsWorkspaceLockHandler (with mocked ProcessRunner)
 * - Integration tests for factory function
 */

import { describe, it, expect, vi } from "vitest";
import {
  WindowsWorkspaceLockHandler,
  createWorkspaceLockHandler,
  UACCancelledError,
} from "./workspace-lock-handler";
import { createMockWorkspaceLockHandler } from "./workspace-lock-handler.test-utils";
import { createMockPlatformInfo } from "./platform-info.test-utils";
import { createMockLogger } from "../logging";
import { Path } from "./path";
import { createMockProcessRunner as createStateMockProcessRunner } from "./process.state-mock";

// Helper to create detect output JSON (unified script format)
function createDetectOutput(
  blocking: Array<{
    pid: number;
    name: string;
    commandLine: string;
    files?: string[];
    cwd?: string | null;
  }>
): string {
  return JSON.stringify({
    blocking: blocking.map((p) => ({
      pid: p.pid,
      name: p.name,
      commandLine: p.commandLine,
      files: p.files ?? [],
      cwd: p.cwd ?? null,
    })),
  });
}

// Helper to create closeHandles output JSON (unified script format)
function createCloseHandlesOutput(
  blocking: Array<{
    pid: number;
    name: string;
    commandLine: string;
    files?: string[];
    cwd?: string | null;
  }>,
  closed: string[]
): string {
  return JSON.stringify({
    blocking: blocking.map((p) => ({
      pid: p.pid,
      name: p.name,
      commandLine: p.commandLine,
      files: p.files ?? [],
      cwd: p.cwd ?? null,
    })),
    closed,
  });
}

// =============================================================================
// Mock Factory Tests (Focused Tests)
// =============================================================================

describe("createMockWorkspaceLockHandler", () => {
  const testPath = new Path("/test/path");

  it("returns empty processes by default", async () => {
    const mock = createMockWorkspaceLockHandler();
    const result = await mock.detect(testPath);
    expect(result).toEqual([]);
  });

  it("returns configured processes", async () => {
    const processes = [
      {
        pid: 1234,
        name: "test.exe",
        commandLine: "test.exe --arg",
        files: ["file.txt"],
        cwd: null,
      },
    ];
    const mock = createMockWorkspaceLockHandler({ processes });

    const result = await mock.detect(testPath);
    expect(result).toEqual(processes);
  });

  it("tracks detect calls", async () => {
    const mock = createMockWorkspaceLockHandler();
    expect(mock.detectCalls).toBe(0);

    await mock.detect(testPath);
    expect(mock.detectCalls).toBe(1);

    await mock.detect(testPath);
    expect(mock.detectCalls).toBe(2);
  });

  it("tracks killProcesses calls", async () => {
    const mock = createMockWorkspaceLockHandler();
    expect(mock.killProcessesCalls).toBe(0);

    await mock.killProcesses([1234]);
    expect(mock.killProcessesCalls).toBe(1);
    expect(mock.lastKillPids).toEqual([1234]);
  });

  it("tracks closeHandles calls", async () => {
    const mock = createMockWorkspaceLockHandler();
    expect(mock.closeHandlesCalls).toBe(0);

    await mock.closeHandles(testPath);
    expect(mock.closeHandlesCalls).toBe(1);
    expect(mock.lastCloseHandlesPath).toBe(testPath);
  });

  it("calls onDetect callback", async () => {
    const onDetect = vi.fn();
    const mock = createMockWorkspaceLockHandler({ onDetect });

    await mock.detect(testPath);
    expect(onDetect).toHaveBeenCalledWith(testPath);
  });

  it("calls onKillProcesses callback", async () => {
    const onKillProcesses = vi.fn();
    const mock = createMockWorkspaceLockHandler({ onKillProcesses });

    await mock.killProcesses([1234, 5678]);
    expect(onKillProcesses).toHaveBeenCalledWith([1234, 5678]);
  });

  it("calls onCloseHandles callback", async () => {
    const onCloseHandles = vi.fn();
    const mock = createMockWorkspaceLockHandler({ onCloseHandles });

    await mock.closeHandles(testPath);
    expect(onCloseHandles).toHaveBeenCalledWith(testPath);
  });

  it("can simulate kill failure", async () => {
    const mock = createMockWorkspaceLockHandler({ killFails: true });

    await expect(mock.killProcesses([1234])).rejects.toThrow("Failed to kill processes");
  });

  it("can simulate UAC cancellation", async () => {
    const mock = createMockWorkspaceLockHandler({ closeHandlesUacCancelled: true });

    await expect(mock.closeHandles(testPath)).rejects.toThrow(UACCancelledError);
  });

  it("can simulate closeHandles failure", async () => {
    const mock = createMockWorkspaceLockHandler({ closeHandlesFails: true });

    await expect(mock.closeHandles(testPath)).rejects.toThrow("Failed to close handles");
  });

  it("can update processes via setProcesses", async () => {
    const mock = createMockWorkspaceLockHandler();

    const initialResult = await mock.detect(testPath);
    expect(initialResult).toEqual([]);

    const newProcesses = [{ pid: 5678, name: "new.exe", commandLine: "new", files: [], cwd: null }];
    mock.setProcesses(newProcesses);

    const updatedResult = await mock.detect(testPath);
    expect(updatedResult).toEqual(newProcesses);
  });
});

// =============================================================================
// WindowsWorkspaceLockHandler (Integration Tests with Mocked ProcessRunner)
// =============================================================================

describe.skipIf(process.platform !== "win32")("WindowsWorkspaceLockHandler", () => {
  // These variables are only initialized on Windows to avoid Path validation errors
  // on non-Windows platforms (describe body runs at module load, before skipIf takes effect)
  let testPath: Path;
  const mockScriptPath = "C:\\mock\\scripts\\blocking-processes.ps1";

  // Initialize Windows-specific paths only on Windows
  if (process.platform === "win32") {
    testPath = new Path("C:\\workspace\\test");
  }

  describe("detect", () => {
    it("throws error when script path not configured", async () => {
      const processRunner = createStateMockProcessRunner();
      // Create service WITHOUT script path
      const service = new WindowsWorkspaceLockHandler(processRunner, createMockLogger());

      await expect(service.detect(testPath)).rejects.toThrow("script path not configured");
    });

    it("parses valid JSON output with single process and files", async () => {
      const output = createDetectOutput([
        {
          pid: 1234,
          name: "node.exe",
          commandLine: "node server.js",
          files: ["src/index.ts"],
          cwd: null,
        },
      ]);

      const processRunner = createStateMockProcessRunner({
        defaultResult: { stdout: output },
      });
      const service = new WindowsWorkspaceLockHandler(
        processRunner,
        createMockLogger(),
        mockScriptPath
      );

      const result = await service.detect(testPath);

      expect(result).toEqual([
        {
          pid: 1234,
          name: "node.exe",
          commandLine: "node server.js",
          files: ["src/index.ts"],
          cwd: null,
        },
      ]);
    });

    it("parses valid JSON output with multiple processes", async () => {
      const output = createDetectOutput([
        { pid: 1234, name: "node.exe", commandLine: "node server.js", files: ["server.js"] },
        {
          pid: 5678,
          name: "Code.exe",
          commandLine: '"C:\\Program Files\\VS Code\\Code.exe"',
          files: ["package.json", "src/main.ts"],
        },
      ]);

      const processRunner = createStateMockProcessRunner({
        defaultResult: { stdout: output },
      });
      const service = new WindowsWorkspaceLockHandler(
        processRunner,
        createMockLogger(),
        mockScriptPath
      );

      const result = await service.detect(testPath);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        pid: 1234,
        name: "node.exe",
        commandLine: "node server.js",
        files: ["server.js"],
        cwd: null,
      });
      expect(result[1]).toEqual({
        pid: 5678,
        name: "Code.exe",
        commandLine: '"C:\\Program Files\\VS Code\\Code.exe"',
        files: ["package.json", "src/main.ts"],
        cwd: null,
      });
    });

    it("parses CWD field when present", async () => {
      const output = createDetectOutput([
        {
          pid: 1234,
          name: "powershell.exe",
          commandLine: "powershell",
          files: [],
          cwd: "subdir/nested",
        },
      ]);

      const processRunner = createStateMockProcessRunner({
        defaultResult: { stdout: output },
      });
      const service = new WindowsWorkspaceLockHandler(
        processRunner,
        createMockLogger(),
        mockScriptPath
      );

      const result = await service.detect(testPath);

      expect(result[0]?.cwd).toBe("subdir/nested");
    });

    it("returns empty array for empty blocking array", async () => {
      const processRunner = createStateMockProcessRunner({
        defaultResult: { stdout: createDetectOutput([]) },
      });
      const service = new WindowsWorkspaceLockHandler(
        processRunner,
        createMockLogger(),
        mockScriptPath
      );

      const result = await service.detect(testPath);
      expect(result).toEqual([]);
    });

    it("returns empty files array when files not provided", async () => {
      const output = createDetectOutput([
        { pid: 1234, name: "node.exe", commandLine: "node server.js" },
      ]);

      const processRunner = createStateMockProcessRunner({
        defaultResult: { stdout: output },
      });
      const service = new WindowsWorkspaceLockHandler(
        processRunner,
        createMockLogger(),
        mockScriptPath
      );

      const result = await service.detect(testPath);

      expect(result).toEqual([
        { pid: 1234, name: "node.exe", commandLine: "node server.js", files: [], cwd: null },
      ]);
    });

    it("truncates files array to max 20", async () => {
      const manyFiles = Array.from({ length: 30 }, (_, i) => `file${i}.txt`);
      const output = createDetectOutput([
        { pid: 1234, name: "node.exe", commandLine: "node", files: manyFiles },
      ]);

      const processRunner = createStateMockProcessRunner({
        defaultResult: { stdout: output },
      });
      const service = new WindowsWorkspaceLockHandler(
        processRunner,
        createMockLogger(),
        mockScriptPath
      );

      const result = await service.detect(testPath);

      expect(result[0]?.files).toHaveLength(20);
      expect(result[0]?.files[0]).toBe("file0.txt");
      expect(result[0]?.files[19]).toBe("file19.txt");
    });

    it("returns empty array on malformed JSON", async () => {
      const processRunner = createStateMockProcessRunner({
        defaultResult: { stdout: "not valid json" },
      });
      const logger = createMockLogger();
      const service = new WindowsWorkspaceLockHandler(processRunner, logger, mockScriptPath);

      const result = await service.detect(testPath);

      expect(result).toEqual([]);
      expect(logger.warn).toHaveBeenCalledWith(
        "Failed to parse blocking process output",
        expect.objectContaining({ stdout: "not valid json" })
      );
    });

    it("returns empty array when error field is present", async () => {
      const output = JSON.stringify({ error: "Some detection error" });
      const processRunner = createStateMockProcessRunner({
        defaultResult: { stdout: output },
      });
      const logger = createMockLogger();
      const service = new WindowsWorkspaceLockHandler(processRunner, logger, mockScriptPath);

      const result = await service.detect(testPath);

      expect(result).toEqual([]);
      expect(logger.warn).toHaveBeenCalledWith(
        "Blocking process detection returned error",
        expect.objectContaining({ error: "Some detection error" })
      );
    });

    it("returns empty array on non-zero exit code", async () => {
      const processRunner = createStateMockProcessRunner({
        defaultResult: { exitCode: 1, stderr: "PowerShell error" },
      });
      const logger = createMockLogger();
      const service = new WindowsWorkspaceLockHandler(processRunner, logger, mockScriptPath);

      const result = await service.detect(testPath);

      expect(result).toEqual([]);
      expect(logger.warn).toHaveBeenCalledWith(
        "Blocking process detection failed",
        expect.objectContaining({ exitCode: 1, stderr: "PowerShell error" })
      );
    });

    it("returns empty array and kills process on timeout", async () => {
      const processRunner = createStateMockProcessRunner({
        onSpawn: () => ({ running: true, exitCode: null }),
      });
      const logger = createMockLogger();
      const service = new WindowsWorkspaceLockHandler(processRunner, logger, mockScriptPath);

      const result = await service.detect(testPath);

      expect(result).toEqual([]);
      expect(logger.warn).toHaveBeenCalledWith(
        "Blocking process detection timed out",
        expect.objectContaining({ path: testPath.toString() })
      );
      expect(processRunner.$.spawned(0)).toHaveBeenKilledWith(1000, 1000);
    });

    it("filters out invalid process entries", async () => {
      // Manual JSON to include invalid entries
      const output = JSON.stringify({
        blocking: [
          { pid: 1234, name: "valid.exe", commandLine: "valid", files: [], cwd: null },
          { pid: "not-a-number", name: "invalid", commandLine: "invalid", files: [], cwd: null },
          { name: "missing-pid", commandLine: "cmd", files: [], cwd: null },
          {
            pid: 5678,
            name: "also-valid.exe",
            commandLine: "also valid",
            files: ["f.txt"],
            cwd: ".",
          },
        ],
      });

      const processRunner = createStateMockProcessRunner({
        defaultResult: { stdout: output },
      });
      const service = new WindowsWorkspaceLockHandler(
        processRunner,
        createMockLogger(),
        mockScriptPath
      );

      const result = await service.detect(testPath);

      expect(result).toHaveLength(2);
      expect(result.map((p) => p.pid)).toEqual([1234, 5678]);
    });

    it("filters out non-string entries in files array", async () => {
      // Manual JSON to include non-string files
      const output = JSON.stringify({
        blocking: [
          {
            pid: 1234,
            name: "node.exe",
            commandLine: "node",
            files: ["valid.txt", 123, null, "also-valid.txt", { bad: "object" }],
            cwd: null,
          },
        ],
      });

      const processRunner = createStateMockProcessRunner({
        defaultResult: { stdout: output },
      });
      const service = new WindowsWorkspaceLockHandler(
        processRunner,
        createMockLogger(),
        mockScriptPath
      );

      const result = await service.detect(testPath);

      expect(result[0]?.files).toEqual(["valid.txt", "also-valid.txt"]);
    });

    it("calls script with -Action Detect", async () => {
      const output = createDetectOutput([]);
      const processRunner = createStateMockProcessRunner({
        defaultResult: { stdout: output, stderr: "", exitCode: 0 },
      });
      const service = new WindowsWorkspaceLockHandler(
        processRunner,
        createMockLogger(),
        mockScriptPath
      );

      await service.detect(testPath);

      expect(processRunner).toHaveSpawned([
        {
          command: "powershell",
          args: expect.arrayContaining(["-File", mockScriptPath, "-Action", "Detect"]),
        },
      ]);
    });
  });

  describe("killProcesses", () => {
    it("calls taskkill with correct arguments for single PID", async () => {
      const processRunner = createStateMockProcessRunner();
      const logger = createMockLogger();
      const service = new WindowsWorkspaceLockHandler(processRunner, logger);

      await service.killProcesses([1234]);

      expect(processRunner).toHaveSpawned([
        { command: "taskkill", args: ["/pid", 1234, "/t", "/f"] },
      ]);
    });

    it("batches multiple PIDs in single taskkill call", async () => {
      const processRunner = createStateMockProcessRunner();
      const service = new WindowsWorkspaceLockHandler(processRunner, createMockLogger());

      await service.killProcesses([1234, 5678, 9012]);

      expect(processRunner).toHaveSpawned([
        {
          command: "taskkill",
          args: ["/pid", 1234, "/pid", 5678, "/pid", 9012, "/t", "/f"],
        },
      ]);
    });

    it("does not call taskkill when no PIDs provided", async () => {
      const processRunner = createStateMockProcessRunner();
      const service = new WindowsWorkspaceLockHandler(processRunner, createMockLogger());

      await service.killProcesses([]);

      // No processes should be spawned
      expect(processRunner).toHaveSpawned([]);
    });

    it("throws error when taskkill fails", async () => {
      const processRunner = createStateMockProcessRunner({
        defaultResult: { exitCode: 1, stderr: "Access denied" },
      });
      const logger = createMockLogger();
      const service = new WindowsWorkspaceLockHandler(processRunner, logger);

      await expect(service.killProcesses([1234])).rejects.toThrow("Failed to kill processes");
      expect(logger.warn).toHaveBeenCalledWith(
        "Some blocking processes could not be killed",
        expect.objectContaining({ stderr: "Access denied" })
      );
    });
  });

  describe("closeHandles", () => {
    it("throws error when script path not configured", async () => {
      const processRunner = createStateMockProcessRunner();
      // Create service WITHOUT script path
      const service = new WindowsWorkspaceLockHandler(processRunner, createMockLogger());

      await expect(service.closeHandles(testPath)).rejects.toThrow("script path not configured");
    });

    it("throws UACCancelledError when UAC is cancelled", async () => {
      const output = JSON.stringify({ error: "UAC cancelled by user" });
      const processRunner = createStateMockProcessRunner({
        defaultResult: { stdout: output, exitCode: 1 },
      });
      const service = new WindowsWorkspaceLockHandler(
        processRunner,
        createMockLogger(),
        mockScriptPath
      );

      await expect(service.closeHandles(testPath)).rejects.toThrow(UACCancelledError);
    });

    it("succeeds when closeHandles returns closed files", async () => {
      const output = createCloseHandlesOutput(
        [{ pid: 1234, name: "node.exe", commandLine: "node" }],
        ["C:\\workspace\\test\\file1.txt", "C:\\workspace\\test\\file2.txt"]
      );
      const processRunner = createStateMockProcessRunner({
        defaultResult: { stdout: output },
      });
      const logger = createMockLogger();
      const service = new WindowsWorkspaceLockHandler(processRunner, logger, mockScriptPath);

      await expect(service.closeHandles(testPath)).resolves.toBeUndefined();
      expect(logger.info).toHaveBeenCalledWith("Closed file handles", {
        path: testPath.toString(),
        closedCount: 2,
      });
    });

    it("succeeds when no handles to close", async () => {
      const output = createCloseHandlesOutput([], []);
      const processRunner = createStateMockProcessRunner({
        defaultResult: { stdout: output },
      });
      const logger = createMockLogger();
      const service = new WindowsWorkspaceLockHandler(processRunner, logger, mockScriptPath);

      await expect(service.closeHandles(testPath)).resolves.toBeUndefined();
      expect(logger.info).toHaveBeenCalledWith("No file handles to close", {
        path: testPath.toString(),
      });
    });

    it("throws error when script returns error", async () => {
      const output = JSON.stringify({ error: "Some internal error" });
      const processRunner = createStateMockProcessRunner({
        defaultResult: { stdout: output, exitCode: 1 },
      });
      const service = new WindowsWorkspaceLockHandler(
        processRunner,
        createMockLogger(),
        mockScriptPath
      );

      await expect(service.closeHandles(testPath)).rejects.toThrow("Some internal error");
    });

    it("throws error on timeout", async () => {
      const processRunner = createStateMockProcessRunner({
        onSpawn: () => ({ running: true, exitCode: null }),
      });
      const logger = createMockLogger();
      const service = new WindowsWorkspaceLockHandler(processRunner, logger, mockScriptPath);

      await expect(service.closeHandles(testPath)).rejects.toThrow(
        "Close handles operation timed out"
      );
      expect(processRunner.$.spawned(0)).toHaveBeenKilled();
    });

    it("calls script with -Action CloseHandles", async () => {
      const output = createCloseHandlesOutput([], []);
      const processRunner = createStateMockProcessRunner({
        defaultResult: { stdout: output, stderr: "", exitCode: 0 },
      });
      const service = new WindowsWorkspaceLockHandler(
        processRunner,
        createMockLogger(),
        mockScriptPath
      );

      await service.closeHandles(testPath);

      expect(processRunner).toHaveSpawned([
        {
          command: "powershell",
          args: expect.arrayContaining(["-File", mockScriptPath, "-Action", "CloseHandles"]),
        },
      ]);
    });
  });
});

// =============================================================================
// Factory Function (Integration Tests)
// =============================================================================

describe("createWorkspaceLockHandler", () => {
  const logger = createMockLogger();

  const mockProcessRunner = createStateMockProcessRunner({
    defaultResult: { stdout: "{}", stderr: "", exitCode: 0 },
  });

  it("returns WindowsWorkspaceLockHandler for win32 platform", () => {
    const platformInfo = createMockPlatformInfo({ platform: "win32" });
    const processRunner = createStateMockProcessRunner({
      defaultResult: { stdout: "{}", stderr: "", exitCode: 0 },
    });

    const service = createWorkspaceLockHandler(processRunner, platformInfo, logger);

    expect(service).toBeInstanceOf(WindowsWorkspaceLockHandler);
  });

  it("returns undefined for linux platform", () => {
    const platformInfo = createMockPlatformInfo({ platform: "linux" });

    const service = createWorkspaceLockHandler(mockProcessRunner, platformInfo, logger);

    expect(service).toBeUndefined();
  });

  it("returns undefined for darwin platform", () => {
    const platformInfo = createMockPlatformInfo({ platform: "darwin" });

    const service = createWorkspaceLockHandler(mockProcessRunner, platformInfo, logger);

    expect(service).toBeUndefined();
  });

  it("passes script path to WindowsWorkspaceLockHandler", () => {
    const platformInfo = createMockPlatformInfo({ platform: "win32" });
    const processRunner = createStateMockProcessRunner({
      defaultResult: { stdout: "{}", stderr: "", exitCode: 0 },
    });
    const scriptPath = "C:\\path\\to\\script.ps1";

    const service = createWorkspaceLockHandler(processRunner, platformInfo, logger, scriptPath);

    expect(service).toBeInstanceOf(WindowsWorkspaceLockHandler);
    // The script path is used internally, we can verify by testing detect/closeHandles behavior
  });
});
