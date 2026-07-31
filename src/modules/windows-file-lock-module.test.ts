/**
 * Tests for exported functions in WindowsFileLockModule.
 *
 * Tests verify: parseDetectOutput, runDetectAction, killBlockingProcesses.
 * Migrated from workspace-lock-handler.test.ts.
 */

import { describe, it, expect } from "vitest";
import {
  parseDetectOutput,
  runDetectAction,
  killBlockingProcesses,
} from "./windows-file-lock-module";
import { createMockLogger } from "../boundaries/platform/logging";
import { Path } from "../utils/path/path";
import { createMockProcessRunner } from "../boundaries/platform/process.state-mock";

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
// runDetectAction
// =============================================================================
//
// The module only ever runs on Windows, but these tests drive a mock
// ProcessRunner and assert on the action passed and the JSON parsed back — none
// of which is platform-dependent. Gating them on win32 only meant every change
// to this function went unverified on the machine making it, which is how a
// signature change reached CI unnoticed. Use a path the host can represent and
// let them run everywhere.

describe("runDetectAction", () => {
  const testPath = new Path(
    process.platform === "win32" ? "C:\\workspace\\test" : "/workspace/test"
  );

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
      createMockLogger(),
      8_000
    );

    expect(result.timedOut).toBe(false);
    expect(result.processes).toEqual([
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

    await runDetectAction(runner, SCRIPT_PATH, testPath, "Detect", createMockLogger(), 8_000);

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

    const result = await runDetectAction(runner, SCRIPT_PATH, testPath, "Detect", logger, 8_000);

    // A non-zero exit is a real answer ("the scan ran and failed"), not the
    // same state as never finding out — only a timeout sets timedOut.
    expect(result).toEqual({ processes: [], timedOut: false });
    expect(logger.warn).toHaveBeenCalledWith(
      "Blocking process detection failed",
      expect.objectContaining({ exitCode: 1, stderr: "PowerShell error" })
    );
  });

  it("reports timedOut (not a clean empty scan) and kills the process on timeout", async () => {
    const runner = createMockProcessRunner({
      onSpawn: () => ({ running: true, exitCode: null }),
    });
    const logger = createMockLogger();

    const result = await runDetectAction(runner, SCRIPT_PATH, testPath, "Detect", logger, 8_000);

    // The distinction that matters: an empty list from a timed-out scan must
    // NOT be reported as "nothing is blocking".
    expect(result).toEqual({ processes: [], timedOut: true });
    expect(logger.warn).toHaveBeenCalledWith(
      "Blocking process detection timed out",
      expect.objectContaining({ path: testPath.toString() })
    );
    expect(runner.$.spawned(0)).toHaveBeenKilledWith(1000, 1000);
  });
});

// =============================================================================
// killBlockingProcesses
// =============================================================================
//
// Not platform-gated. These drive a mock ProcessRunner and never touch a path,
// so there was never anything Windows-specific about them — but the gate made
// them invisible on every other OS, which is how they went on asserting a
// taskkill invocation that no longer happens.

describe("killBlockingProcesses", () => {
  it("terminates each PID through the boundary rather than shelling out", async () => {
    const runner = createMockProcessRunner();

    const survivors = await killBlockingProcesses(runner, [1234], createMockLogger());

    // ProcessRunner.kill waits for the process to actually be gone; a taskkill
    // spawn would only tell us the request was made.
    expect(runner.$.killedPids).toEqual([1234]);
    expect(runner.$.spawnedCount).toBe(0);
    expect(survivors).toEqual([]);
  });

  it("terminates every PID it is given", async () => {
    const runner = createMockProcessRunner();

    await killBlockingProcesses(runner, [1234, 5678, 9012], createMockLogger());

    expect(runner.$.killedPids).toEqual([1234, 5678, 9012]);
  });

  it("does nothing when no PIDs provided", async () => {
    const runner = createMockProcessRunner();

    await killBlockingProcesses(runner, [], createMockLogger());

    expect(runner.$.killedPids).toEqual([]);
    expect(runner.$.spawnedCount).toBe(0);
  });

  it("reports the PIDs that survived instead of throwing", async () => {
    const runner = createMockProcessRunner({
      onKill: (pid) => (pid === 1234 ? { success: false } : undefined),
    });
    const logger = createMockLogger();

    const survivors = await killBlockingProcesses(runner, [1234, 5678], logger);

    // Returned, not thrown: one process refusing to die must not abort the
    // cleanup of the others, and the caller needs the PID to name it to the user.
    expect(survivors).toEqual([1234]);
    expect(logger.warn).toHaveBeenCalledWith(
      "Blocking processes survived termination",
      expect.objectContaining({ pids: "1234" })
    );
  });
});
