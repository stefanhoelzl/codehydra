/**
 * Tests for exported functions in WindowsFileLockModule.
 *
 * Tests verify: runDetectAction, killBlockingProcesses.
 * Migrated from workspace-lock-handler.test.ts.
 */

import { describe, it, expect } from "vitest";
import { runDetectAction, killBlockingProcesses } from "./windows-file-lock-module";
import { createMockLogger } from "../boundaries/platform/logging";
import { Path } from "../utils/path/path";
import { createMockProcessRunner } from "../boundaries/platform/process.state-mock";
import { directoryHolders, type HolderScanCall } from "../boundaries/platform/process.state-mock";

// =============================================================================
// runDetectAction
// =============================================================================
//
// The module only ever runs on Windows, but these tests drive a mock
// ProcessRunner — none of which is platform-dependent. Use a path the host can
// represent and let them run everywhere.

describe("runDetectAction", () => {
  const testPath = new Path(
    process.platform === "win32" ? "C:\\workspace\\test" : "/workspace/test"
  );

  it("scans open files as well as working directories, within its budget", async () => {
    const calls: HolderScanCall[] = [];
    const runner = createMockProcessRunner({ directoryHolders: directoryHolders([], calls) });

    await runDetectAction(runner, testPath, createMockLogger(), 8_000);

    expect(calls).toEqual([{ dir: testPath.toNative(), files: true, timeoutMs: 8_000 }]);
  });

  it("returns what the scan found", async () => {
    const holder = {
      pid: 1234,
      name: "node.exe",
      commandLine: "node server.js",
      files: ["src/index.ts"],
      cwd: null,
    };
    const runner = createMockProcessRunner({ directoryHolders: directoryHolders([holder]) });

    const result = await runDetectAction(runner, testPath, createMockLogger(), 8_000);

    expect(result).toEqual({ processes: [holder], timedOut: false });
  });

  it("throws when the scan cannot run, rather than reporting nothing found", async () => {
    const runner = createMockProcessRunner({
      directoryHolders: directoryHolders(new Error("addon missing")),
    });

    await expect(runDetectAction(runner, testPath, createMockLogger(), 8_000)).rejects.toThrow(
      "addon missing"
    );
  });

  it("reports timedOut (not a clean empty scan) on timeout", async () => {
    const runner = createMockProcessRunner({ directoryHolders: directoryHolders("timeout") });
    const logger = createMockLogger();

    const result = await runDetectAction(runner, testPath, logger, 8_000);

    // The distinction that matters: an empty list from a timed-out scan must
    // NOT be reported as "nothing is blocking".
    expect(result).toEqual({ processes: [], timedOut: true });
    expect(logger.warn).toHaveBeenCalledWith(
      "Blocking process detection timed out",
      expect.objectContaining({ "scope.path": testPath.toString() })
    );
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
