/**
 * Tests for exported functions in WindowsFileLockModule.
 *
 * Tests verify: parseDetectOutput, runDetectAction, killBlockingProcesses, closeFileHandles.
 * Migrated from workspace-lock-handler.test.ts.
 */

import { describe, it, expect } from "vitest";
import {
  parseDetectOutput,
  runDetectAction,
  killBlockingProcesses,
  closeFileHandles,
  UACCancelledError,
} from "./windows-file-lock-module";
import { createMockLogger } from "../../services/logging";
import { Path } from "../../services/platform/path";
import { createMockProcessRunner } from "../../services/platform/process.state-mock";

// =============================================================================
// Test Helpers
// =============================================================================

function createDetectJson(
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

function createCloseHandlesJson(
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

const SCRIPT_PATH = "/scripts/blocking-processes.ps1";

// =============================================================================
// parseDetectOutput
// =============================================================================

describe("parseDetectOutput", () => {
  it("parses valid JSON output with single process and files", () => {
    const output = createDetectJson([
      {
        pid: 1234,
        name: "node.exe",
        commandLine: "node server.js",
        files: ["src/index.ts"],
        cwd: null,
      },
    ]);

    const result = parseDetectOutput(output, createMockLogger());

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

  it("parses valid JSON output with multiple processes", () => {
    const output = createDetectJson([
      { pid: 1234, name: "node.exe", commandLine: "node server.js", files: ["server.js"] },
      {
        pid: 5678,
        name: "Code.exe",
        commandLine: '"C:\\Program Files\\VS Code\\Code.exe"',
        files: ["package.json", "src/main.ts"],
      },
    ]);

    const result = parseDetectOutput(output, createMockLogger());

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

  it("parses CWD field when present", () => {
    const output = createDetectJson([
      {
        pid: 1234,
        name: "powershell.exe",
        commandLine: "powershell",
        files: [],
        cwd: "subdir/nested",
      },
    ]);

    const result = parseDetectOutput(output, createMockLogger());

    expect(result[0]?.cwd).toBe("subdir/nested");
  });

  it("returns empty array for empty blocking array", () => {
    const result = parseDetectOutput(createDetectJson([]), createMockLogger());
    expect(result).toEqual([]);
  });

  it("returns empty files array when files not provided", () => {
    const output = createDetectJson([
      { pid: 1234, name: "node.exe", commandLine: "node server.js" },
    ]);

    const result = parseDetectOutput(output, createMockLogger());

    expect(result).toEqual([
      { pid: 1234, name: "node.exe", commandLine: "node server.js", files: [], cwd: null },
    ]);
  });

  it("truncates files array to max 20", () => {
    const manyFiles = Array.from({ length: 30 }, (_, i) => `file${i}.txt`);
    const output = createDetectJson([
      { pid: 1234, name: "node.exe", commandLine: "node", files: manyFiles },
    ]);

    const result = parseDetectOutput(output, createMockLogger());

    expect(result[0]?.files).toHaveLength(20);
    expect(result[0]?.files[0]).toBe("file0.txt");
    expect(result[0]?.files[19]).toBe("file19.txt");
  });

  it("returns empty array on malformed JSON", () => {
    const logger = createMockLogger();
    const result = parseDetectOutput("not valid json", logger);

    expect(result).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      "Failed to parse blocking process output",
      expect.objectContaining({ stdout: "not valid json" })
    );
  });

  it("returns empty array when error field is present", () => {
    const output = JSON.stringify({ error: "Some detection error" });
    const logger = createMockLogger();
    const result = parseDetectOutput(output, logger);

    expect(result).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      "Blocking process detection returned error",
      expect.objectContaining({ error: "Some detection error" })
    );
  });

  it("returns empty array for empty string", () => {
    const result = parseDetectOutput("", createMockLogger());
    expect(result).toEqual([]);
  });

  it("returns empty array for whitespace-only string", () => {
    const result = parseDetectOutput("   \n  ", createMockLogger());
    expect(result).toEqual([]);
  });

  it("filters out invalid process entries", () => {
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

    const result = parseDetectOutput(output, createMockLogger());

    expect(result).toHaveLength(2);
    expect(result.map((p) => p.pid)).toEqual([1234, 5678]);
  });

  it("filters out non-string entries in files array", () => {
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

    const result = parseDetectOutput(output, createMockLogger());

    expect(result[0]?.files).toEqual(["valid.txt", "also-valid.txt"]);
  });
});

// =============================================================================
// runDetectAction (Windows-only: requires Path with Windows-style paths)
// =============================================================================

describe.skipIf(process.platform !== "win32")("runDetectAction", () => {
  let testPath: Path;
  if (process.platform === "win32") {
    testPath = new Path("C:\\workspace\\test");
  }

  it("parses valid detect output", async () => {
    const output = createDetectJson([
      { pid: 1234, name: "node.exe", commandLine: "node server.js", files: ["src/index.ts"] },
    ]);
    const runner = createMockProcessRunner({
      defaultResult: { stdout: output },
    });

    const result = await runDetectAction(
      runner,
      SCRIPT_PATH,
      testPath,
      "Detect",
      createMockLogger()
    );

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

  it("calls script with correct action", async () => {
    const runner = createMockProcessRunner({
      defaultResult: { stdout: createDetectJson([]) },
    });

    await runDetectAction(runner, SCRIPT_PATH, testPath, "Detect", createMockLogger());

    expect(runner).toHaveSpawned([
      {
        command: "powershell",
        args: expect.arrayContaining(["-File", SCRIPT_PATH, "-Action", "Detect"]),
      },
    ]);
  });

  it("returns empty array on non-zero exit code", async () => {
    const runner = createMockProcessRunner({
      defaultResult: { exitCode: 1, stderr: "PowerShell error" },
    });
    const logger = createMockLogger();

    const result = await runDetectAction(runner, SCRIPT_PATH, testPath, "Detect", logger);

    expect(result).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      "Blocking process detection failed",
      expect.objectContaining({ exitCode: 1, stderr: "PowerShell error" })
    );
  });

  it("returns empty array and kills process on timeout", async () => {
    const runner = createMockProcessRunner({
      onSpawn: () => ({ running: true, exitCode: null }),
    });
    const logger = createMockLogger();

    const result = await runDetectAction(runner, SCRIPT_PATH, testPath, "Detect", logger);

    expect(result).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      "Blocking process detection timed out",
      expect.objectContaining({ path: testPath.toString() })
    );
    expect(runner.$.spawned(0)).toHaveBeenKilledWith(1000, 1000);
  });
});

// =============================================================================
// killBlockingProcesses (Windows-only: uses taskkill)
// =============================================================================

describe.skipIf(process.platform !== "win32")("killBlockingProcesses", () => {
  it("calls taskkill with correct arguments for single PID", async () => {
    const runner = createMockProcessRunner();

    await killBlockingProcesses(runner, [1234], createMockLogger());

    expect(runner).toHaveSpawned([{ command: "taskkill", args: ["/pid", "1234", "/t", "/f"] }]);
  });

  it("batches multiple PIDs in single taskkill call", async () => {
    const runner = createMockProcessRunner();

    await killBlockingProcesses(runner, [1234, 5678, 9012], createMockLogger());

    expect(runner).toHaveSpawned([
      {
        command: "taskkill",
        args: ["/pid", "1234", "/pid", "5678", "/pid", "9012", "/t", "/f"],
      },
    ]);
  });

  it("does not call taskkill when no PIDs provided", async () => {
    const runner = createMockProcessRunner();

    await killBlockingProcesses(runner, [], createMockLogger());

    expect(runner).toHaveSpawned([]);
  });

  it("throws error when taskkill fails", async () => {
    const runner = createMockProcessRunner({
      defaultResult: { exitCode: 1, stderr: "Access denied" },
    });

    await expect(killBlockingProcesses(runner, [1234], createMockLogger())).rejects.toThrow(
      "Failed to kill processes"
    );
  });
});

// =============================================================================
// closeFileHandles (Windows-only: uses PowerShell)
// =============================================================================

describe.skipIf(process.platform !== "win32")("closeFileHandles", () => {
  let testPath: Path;
  if (process.platform === "win32") {
    testPath = new Path("C:\\workspace\\test");
  }

  it("throws UACCancelledError when UAC is cancelled", async () => {
    const output = JSON.stringify({ error: "UAC cancelled by user" });
    const runner = createMockProcessRunner({
      defaultResult: { stdout: output, exitCode: 1 },
    });

    await expect(
      closeFileHandles(runner, SCRIPT_PATH, testPath, createMockLogger())
    ).rejects.toThrow(UACCancelledError);
  });

  it("succeeds when closeHandles returns closed files", async () => {
    const output = createCloseHandlesJson(
      [{ pid: 1234, name: "node.exe", commandLine: "node" }],
      ["C:\\workspace\\test\\file1.txt", "C:\\workspace\\test\\file2.txt"]
    );
    const runner = createMockProcessRunner({
      defaultResult: { stdout: output },
    });
    const logger = createMockLogger();

    await expect(closeFileHandles(runner, SCRIPT_PATH, testPath, logger)).resolves.toBeUndefined();
    expect(logger.info).toHaveBeenCalledWith("Closed file handles", {
      path: testPath.toString(),
      closedCount: 2,
    });
  });

  it("succeeds when no handles to close", async () => {
    const output = createCloseHandlesJson([], []);
    const runner = createMockProcessRunner({
      defaultResult: { stdout: output },
    });
    const logger = createMockLogger();

    await expect(closeFileHandles(runner, SCRIPT_PATH, testPath, logger)).resolves.toBeUndefined();
    expect(logger.info).toHaveBeenCalledWith("No file handles to close", {
      path: testPath.toString(),
    });
  });

  it("throws error when script returns error", async () => {
    const output = JSON.stringify({ error: "Some internal error" });
    const runner = createMockProcessRunner({
      defaultResult: { stdout: output, exitCode: 1 },
    });

    await expect(
      closeFileHandles(runner, SCRIPT_PATH, testPath, createMockLogger())
    ).rejects.toThrow("Some internal error");
  });

  it("throws error on timeout", async () => {
    const runner = createMockProcessRunner({
      onSpawn: () => ({ running: true, exitCode: null }),
    });

    await expect(
      closeFileHandles(runner, SCRIPT_PATH, testPath, createMockLogger())
    ).rejects.toThrow("Close handles operation timed out");
    expect(runner.$.spawned(0)).toHaveBeenKilled();
  });

  it("calls script with -Action CloseHandles", async () => {
    const output = createCloseHandlesJson([], []);
    const runner = createMockProcessRunner({
      defaultResult: { stdout: output, stderr: "", exitCode: 0 },
    });

    await closeFileHandles(runner, SCRIPT_PATH, testPath, createMockLogger());

    expect(runner).toHaveSpawned([
      {
        command: "powershell",
        args: expect.arrayContaining(["-File", SCRIPT_PATH, "-Action", "CloseHandles"]),
      },
    ]);
  });
});
