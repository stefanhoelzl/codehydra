/**
 * Tests for BlockingProcessService.
 *
 * This file contains:
 * - Integration tests for WindowsBlockingProcessService (with mocked ProcessRunner)
 * - Integration tests for factory function
 */

import { describe, it, expect, vi } from "vitest";
import {
  WindowsBlockingProcessService,
  createBlockingProcessService,
  UACCancelledError,
} from "./blocking-process";
import { createMockBlockingProcessService } from "./blocking-process.test-utils";
import { createMockPlatformInfo } from "./platform-info.test-utils";
import { createMockLogger } from "../logging";
import { Path } from "./path";
import type { ProcessRunner, SpawnedProcess, ProcessResult } from "./process";

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

describe("createMockBlockingProcessService", () => {
  const testPath = new Path("/test/path");

  it("returns empty processes by default", async () => {
    const mock = createMockBlockingProcessService();
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
    const mock = createMockBlockingProcessService({ processes });

    const result = await mock.detect(testPath);
    expect(result).toEqual(processes);
  });

  it("tracks detect calls", async () => {
    const mock = createMockBlockingProcessService();
    expect(mock.detectCalls).toBe(0);

    await mock.detect(testPath);
    expect(mock.detectCalls).toBe(1);

    await mock.detect(testPath);
    expect(mock.detectCalls).toBe(2);
  });

  it("tracks killProcesses calls", async () => {
    const mock = createMockBlockingProcessService();
    expect(mock.killProcessesCalls).toBe(0);

    await mock.killProcesses([1234]);
    expect(mock.killProcessesCalls).toBe(1);
    expect(mock.lastKillPids).toEqual([1234]);
  });

  it("tracks closeHandles calls", async () => {
    const mock = createMockBlockingProcessService();
    expect(mock.closeHandlesCalls).toBe(0);

    await mock.closeHandles(testPath);
    expect(mock.closeHandlesCalls).toBe(1);
    expect(mock.lastCloseHandlesPath).toBe(testPath);
  });

  it("calls onDetect callback", async () => {
    const onDetect = vi.fn();
    const mock = createMockBlockingProcessService({ onDetect });

    await mock.detect(testPath);
    expect(onDetect).toHaveBeenCalledWith(testPath);
  });

  it("calls onKillProcesses callback", async () => {
    const onKillProcesses = vi.fn();
    const mock = createMockBlockingProcessService({ onKillProcesses });

    await mock.killProcesses([1234, 5678]);
    expect(onKillProcesses).toHaveBeenCalledWith([1234, 5678]);
  });

  it("calls onCloseHandles callback", async () => {
    const onCloseHandles = vi.fn();
    const mock = createMockBlockingProcessService({ onCloseHandles });

    await mock.closeHandles(testPath);
    expect(onCloseHandles).toHaveBeenCalledWith(testPath);
  });

  it("can simulate kill failure", async () => {
    const mock = createMockBlockingProcessService({ killFails: true });

    await expect(mock.killProcesses([1234])).rejects.toThrow("Failed to kill processes");
  });

  it("can simulate UAC cancellation", async () => {
    const mock = createMockBlockingProcessService({ closeHandlesUacCancelled: true });

    await expect(mock.closeHandles(testPath)).rejects.toThrow(UACCancelledError);
  });

  it("can simulate closeHandles failure", async () => {
    const mock = createMockBlockingProcessService({ closeHandlesFails: true });

    await expect(mock.closeHandles(testPath)).rejects.toThrow("Failed to close handles");
  });

  it("can update processes via setProcesses", async () => {
    const mock = createMockBlockingProcessService();

    const initialResult = await mock.detect(testPath);
    expect(initialResult).toEqual([]);

    const newProcesses = [{ pid: 5678, name: "new.exe", commandLine: "new", files: [], cwd: null }];
    mock.setProcesses(newProcesses);

    const updatedResult = await mock.detect(testPath);
    expect(updatedResult).toEqual(newProcesses);
  });
});

// =============================================================================
// WindowsBlockingProcessService (Integration Tests with Mocked ProcessRunner)
// =============================================================================

describe.skipIf(process.platform !== "win32")("WindowsBlockingProcessService", () => {
  // These variables are only initialized on Windows to avoid Path validation errors
  // on non-Windows platforms (describe body runs at module load, before skipIf takes effect)
  let testPath: Path;
  const mockScriptPath = "C:\\mock\\scripts\\blocking-processes.ps1";

  // Initialize Windows-specific paths only on Windows
  if (process.platform === "win32") {
    testPath = new Path("C:\\workspace\\test");
  }

  // Helper to create a mock ProcessRunner
  function createMockProcessRunner(opts: {
    stdout?: string;
    stderr?: string;
    exitCode?: number | null;
    running?: boolean;
    killResult?: { success: boolean };
  }): ProcessRunner {
    const mockProcess: SpawnedProcess = {
      pid: 1234,
      wait: vi.fn().mockResolvedValue({
        stdout: opts.stdout ?? "",
        stderr: opts.stderr ?? "",
        exitCode: opts.exitCode ?? 0,
        running: opts.running ?? false,
      } satisfies ProcessResult),
      kill: vi.fn().mockResolvedValue(opts.killResult ?? { success: true }),
    };

    return {
      run: vi.fn().mockReturnValue(mockProcess),
    };
  }

  describe("detect", () => {
    it("throws error when script path not configured", async () => {
      const processRunner = createMockProcessRunner({ stdout: "" });
      // Create service WITHOUT script path
      const service = new WindowsBlockingProcessService(processRunner, createMockLogger());

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

      const processRunner = createMockProcessRunner({ stdout: output });
      const service = new WindowsBlockingProcessService(
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

      const processRunner = createMockProcessRunner({ stdout: output });
      const service = new WindowsBlockingProcessService(
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

      const processRunner = createMockProcessRunner({ stdout: output });
      const service = new WindowsBlockingProcessService(
        processRunner,
        createMockLogger(),
        mockScriptPath
      );

      const result = await service.detect(testPath);

      expect(result[0]?.cwd).toBe("subdir/nested");
    });

    it("returns empty array for empty blocking array", async () => {
      const processRunner = createMockProcessRunner({ stdout: createDetectOutput([]) });
      const service = new WindowsBlockingProcessService(
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

      const processRunner = createMockProcessRunner({ stdout: output });
      const service = new WindowsBlockingProcessService(
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

      const processRunner = createMockProcessRunner({ stdout: output });
      const service = new WindowsBlockingProcessService(
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
      const processRunner = createMockProcessRunner({ stdout: "not valid json" });
      const logger = createMockLogger();
      const service = new WindowsBlockingProcessService(processRunner, logger, mockScriptPath);

      const result = await service.detect(testPath);

      expect(result).toEqual([]);
      expect(logger.warn).toHaveBeenCalledWith(
        "Failed to parse blocking process output",
        expect.objectContaining({ stdout: "not valid json" })
      );
    });

    it("returns empty array when error field is present", async () => {
      const output = JSON.stringify({ error: "Some detection error" });
      const processRunner = createMockProcessRunner({ stdout: output });
      const logger = createMockLogger();
      const service = new WindowsBlockingProcessService(processRunner, logger, mockScriptPath);

      const result = await service.detect(testPath);

      expect(result).toEqual([]);
      expect(logger.warn).toHaveBeenCalledWith(
        "Blocking process detection returned error",
        expect.objectContaining({ error: "Some detection error" })
      );
    });

    it("returns empty array on non-zero exit code", async () => {
      const processRunner = createMockProcessRunner({
        exitCode: 1,
        stderr: "PowerShell error",
      });
      const logger = createMockLogger();
      const service = new WindowsBlockingProcessService(processRunner, logger, mockScriptPath);

      const result = await service.detect(testPath);

      expect(result).toEqual([]);
      expect(logger.warn).toHaveBeenCalledWith(
        "Blocking process detection failed",
        expect.objectContaining({ exitCode: 1, stderr: "PowerShell error" })
      );
    });

    it("returns empty array and kills process on timeout", async () => {
      const mockProcess: SpawnedProcess = {
        pid: 1234,
        wait: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: null, running: true }),
        kill: vi.fn().mockResolvedValue({ success: true }),
      };
      const processRunner: ProcessRunner = { run: vi.fn().mockReturnValue(mockProcess) };
      const logger = createMockLogger();
      const service = new WindowsBlockingProcessService(processRunner, logger, mockScriptPath);

      const result = await service.detect(testPath);

      expect(result).toEqual([]);
      expect(logger.warn).toHaveBeenCalledWith(
        "Blocking process detection timed out",
        expect.objectContaining({ path: testPath.toString() })
      );
      expect(mockProcess.kill).toHaveBeenCalledWith(1000, 1000);
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

      const processRunner = createMockProcessRunner({ stdout: output });
      const service = new WindowsBlockingProcessService(
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

      const processRunner = createMockProcessRunner({ stdout: output });
      const service = new WindowsBlockingProcessService(
        processRunner,
        createMockLogger(),
        mockScriptPath
      );

      const result = await service.detect(testPath);

      expect(result[0]?.files).toEqual(["valid.txt", "also-valid.txt"]);
    });

    it("calls script with -Action Detect", async () => {
      const output = createDetectOutput([]);
      const processRunner = createMockProcessRunner({ stdout: output });
      const service = new WindowsBlockingProcessService(
        processRunner,
        createMockLogger(),
        mockScriptPath
      );

      await service.detect(testPath);

      expect(processRunner.run).toHaveBeenCalledWith("powershell", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        mockScriptPath,
        "-BasePath",
        testPath.toNative(),
        "-Action",
        "Detect",
      ]);
    });
  });

  describe("killProcesses", () => {
    it("calls taskkill with correct arguments for single PID", async () => {
      const mockProcess: SpawnedProcess = {
        pid: 101,
        wait: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0, running: false }),
        kill: vi.fn(),
      };

      const processRunner: ProcessRunner = {
        run: vi.fn().mockReturnValue(mockProcess),
      };
      const logger = createMockLogger();
      const service = new WindowsBlockingProcessService(processRunner, logger);

      await service.killProcesses([1234]);

      expect(processRunner.run).toHaveBeenCalledTimes(1);
      expect(processRunner.run).toHaveBeenCalledWith("taskkill", ["/pid", "1234", "/t", "/f"]);
    });

    it("batches multiple PIDs in single taskkill call", async () => {
      const mockProcess: SpawnedProcess = {
        pid: 101,
        wait: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0, running: false }),
        kill: vi.fn(),
      };

      const processRunner: ProcessRunner = {
        run: vi.fn().mockReturnValue(mockProcess),
      };
      const service = new WindowsBlockingProcessService(processRunner, createMockLogger());

      await service.killProcesses([1234, 5678, 9012]);

      expect(processRunner.run).toHaveBeenCalledWith("taskkill", [
        "/pid",
        "1234",
        "/pid",
        "5678",
        "/pid",
        "9012",
        "/t",
        "/f",
      ]);
    });

    it("does not call taskkill when no PIDs provided", async () => {
      const processRunner = createMockProcessRunner({ stdout: "" });
      const service = new WindowsBlockingProcessService(processRunner, createMockLogger());

      await service.killProcesses([]);

      expect(processRunner.run).not.toHaveBeenCalled();
    });

    it("throws error when taskkill fails", async () => {
      const mockProcess: SpawnedProcess = {
        pid: 101,
        wait: vi
          .fn()
          .mockResolvedValue({ stdout: "", stderr: "Access denied", exitCode: 1, running: false }),
        kill: vi.fn(),
      };

      const processRunner: ProcessRunner = {
        run: vi.fn().mockReturnValue(mockProcess),
      };
      const logger = createMockLogger();
      const service = new WindowsBlockingProcessService(processRunner, logger);

      await expect(service.killProcesses([1234])).rejects.toThrow("Failed to kill processes");
      expect(logger.warn).toHaveBeenCalledWith(
        "Some blocking processes could not be killed",
        expect.objectContaining({ stderr: "Access denied" })
      );
    });
  });

  describe("closeHandles", () => {
    it("throws error when script path not configured", async () => {
      const processRunner = createMockProcessRunner({ stdout: "" });
      // Create service WITHOUT script path
      const service = new WindowsBlockingProcessService(processRunner, createMockLogger());

      await expect(service.closeHandles(testPath)).rejects.toThrow("script path not configured");
    });

    it("throws UACCancelledError when UAC is cancelled", async () => {
      const output = JSON.stringify({ error: "UAC cancelled by user" });
      const mockProcess: SpawnedProcess = {
        pid: 101,
        wait: vi.fn().mockResolvedValue({
          stdout: output,
          stderr: "",
          exitCode: 1,
          running: false,
        }),
        kill: vi.fn(),
      };

      const processRunner: ProcessRunner = {
        run: vi.fn().mockReturnValue(mockProcess),
      };
      const service = new WindowsBlockingProcessService(
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
      const mockProcess: SpawnedProcess = {
        pid: 101,
        wait: vi.fn().mockResolvedValue({
          stdout: output,
          stderr: "",
          exitCode: 0,
          running: false,
        }),
        kill: vi.fn(),
      };

      const processRunner: ProcessRunner = {
        run: vi.fn().mockReturnValue(mockProcess),
      };
      const logger = createMockLogger();
      const service = new WindowsBlockingProcessService(processRunner, logger, mockScriptPath);

      await expect(service.closeHandles(testPath)).resolves.toBeUndefined();
      expect(logger.info).toHaveBeenCalledWith("Closed file handles", {
        path: testPath.toString(),
        closedCount: 2,
      });
    });

    it("succeeds when no handles to close", async () => {
      const output = createCloseHandlesOutput([], []);
      const mockProcess: SpawnedProcess = {
        pid: 101,
        wait: vi.fn().mockResolvedValue({
          stdout: output,
          stderr: "",
          exitCode: 0,
          running: false,
        }),
        kill: vi.fn(),
      };

      const processRunner: ProcessRunner = {
        run: vi.fn().mockReturnValue(mockProcess),
      };
      const logger = createMockLogger();
      const service = new WindowsBlockingProcessService(processRunner, logger, mockScriptPath);

      await expect(service.closeHandles(testPath)).resolves.toBeUndefined();
      expect(logger.info).toHaveBeenCalledWith("No file handles to close", {
        path: testPath.toString(),
      });
    });

    it("throws error when script returns error", async () => {
      const output = JSON.stringify({ error: "Some internal error" });
      const mockProcess: SpawnedProcess = {
        pid: 101,
        wait: vi.fn().mockResolvedValue({
          stdout: output,
          stderr: "",
          exitCode: 1,
          running: false,
        }),
        kill: vi.fn(),
      };

      const processRunner: ProcessRunner = {
        run: vi.fn().mockReturnValue(mockProcess),
      };
      const service = new WindowsBlockingProcessService(
        processRunner,
        createMockLogger(),
        mockScriptPath
      );

      await expect(service.closeHandles(testPath)).rejects.toThrow("Some internal error");
    });

    it("throws error on timeout", async () => {
      const mockProcess: SpawnedProcess = {
        pid: 101,
        wait: vi.fn().mockResolvedValue({
          stdout: "",
          stderr: "",
          exitCode: null,
          running: true,
        }),
        kill: vi.fn().mockResolvedValue({ success: true }),
      };

      const processRunner: ProcessRunner = {
        run: vi.fn().mockReturnValue(mockProcess),
      };
      const logger = createMockLogger();
      const service = new WindowsBlockingProcessService(processRunner, logger, mockScriptPath);

      await expect(service.closeHandles(testPath)).rejects.toThrow(
        "Close handles operation timed out"
      );
      expect(mockProcess.kill).toHaveBeenCalled();
    });

    it("calls script with -Action CloseHandles", async () => {
      const output = createCloseHandlesOutput([], []);
      const mockProcess: SpawnedProcess = {
        pid: 101,
        wait: vi.fn().mockResolvedValue({
          stdout: output,
          stderr: "",
          exitCode: 0,
          running: false,
        }),
        kill: vi.fn(),
      };

      const processRunner: ProcessRunner = {
        run: vi.fn().mockReturnValue(mockProcess),
      };
      const service = new WindowsBlockingProcessService(
        processRunner,
        createMockLogger(),
        mockScriptPath
      );

      await service.closeHandles(testPath);

      expect(processRunner.run).toHaveBeenCalledWith("powershell", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        mockScriptPath,
        "-BasePath",
        testPath.toNative(),
        "-Action",
        "CloseHandles",
      ]);
    });
  });
});

// =============================================================================
// Factory Function (Integration Tests)
// =============================================================================

describe("createBlockingProcessService", () => {
  const logger = createMockLogger();

  // Helper to create a mock ProcessRunner
  function createMockProcessRunner(opts: { stdout?: string }): ProcessRunner {
    const mockProcess: SpawnedProcess = {
      pid: 1234,
      wait: vi.fn().mockResolvedValue({
        stdout: opts.stdout ?? "",
        stderr: "",
        exitCode: 0,
        running: false,
      }),
      kill: vi.fn().mockResolvedValue({ success: true }),
    };
    return { run: vi.fn().mockReturnValue(mockProcess) };
  }

  const mockProcessRunner = createMockProcessRunner({ stdout: "{}" });

  it("returns WindowsBlockingProcessService for win32 platform", () => {
    const platformInfo = createMockPlatformInfo({ platform: "win32" });
    const processRunner = createMockProcessRunner({ stdout: "{}" });

    const service = createBlockingProcessService(processRunner, platformInfo, logger);

    expect(service).toBeInstanceOf(WindowsBlockingProcessService);
  });

  it("returns undefined for linux platform", () => {
    const platformInfo = createMockPlatformInfo({ platform: "linux" });

    const service = createBlockingProcessService(mockProcessRunner, platformInfo, logger);

    expect(service).toBeUndefined();
  });

  it("returns undefined for darwin platform", () => {
    const platformInfo = createMockPlatformInfo({ platform: "darwin" });

    const service = createBlockingProcessService(mockProcessRunner, platformInfo, logger);

    expect(service).toBeUndefined();
  });

  it("passes script path to WindowsBlockingProcessService", () => {
    const platformInfo = createMockPlatformInfo({ platform: "win32" });
    const processRunner = createMockProcessRunner({ stdout: "{}" });
    const scriptPath = "C:\\path\\to\\script.ps1";

    const service = createBlockingProcessService(processRunner, platformInfo, logger, scriptPath);

    expect(service).toBeInstanceOf(WindowsBlockingProcessService);
    // The script path is used internally, we can verify by testing detect/closeHandles behavior
  });
});
