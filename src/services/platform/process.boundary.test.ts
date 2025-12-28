// @vitest-environment node
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import { ExecaProcessRunner, type SpawnedProcess, type ProcessRunner } from "./process";
import { SILENT_LOGGER } from "../logging";
import {
  isWindows,
  spawnIgnoringSignals,
  spawnLongRunning,
  spawnWithOutput,
  spawnWithExitCode,
  spawnWithChild,
} from "./process.boundary-test-utils";
import { delay } from "@shared/test-fixtures";

// Default timeout for boundary tests
const TEST_TIMEOUT = 5000;

// Track spawned PIDs for cleanup
const spawnedPids: number[] = [];

/**
 * Track a spawned process PID for cleanup in afterEach.
 */
function trackProcess(proc: SpawnedProcess): void {
  if (proc.pid !== undefined) {
    spawnedPids.push(proc.pid);
  }
}

/**
 * Check if a process is running using signal 0.
 */
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    throw err;
  }
}

/**
 * Wait for a process to die, with polling.
 */
async function waitForProcessDeath(pid: number, maxMs = 500): Promise<boolean> {
  const interval = 50;
  const maxAttempts = maxMs / interval;

  for (let i = 0; i < maxAttempts; i++) {
    if (!isProcessRunning(pid)) {
      return true;
    }
    await delay(interval);
  }
  return false;
}

describe("ExecaProcessRunner", () => {
  let runner: ProcessRunner;
  const runningProcesses: SpawnedProcess[] = [];

  beforeEach(async () => {
    runner = new ExecaProcessRunner(SILENT_LOGGER);
  });

  afterEach(async () => {
    // Clean up tracked SpawnedProcess handles
    for (const proc of runningProcesses) {
      try {
        await proc.kill(0, 100); // Immediate SIGTERM, wait 100ms for SIGKILL
      } catch {
        // Ignore errors during cleanup
      }
    }
    runningProcesses.length = 0;

    // Clean up any additional tracked PIDs (child processes)
    for (const pid of spawnedPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Process already dead - expected
      }
    }
    spawnedPids.length = 0;
  });

  describe("basic operations", () => {
    it(
      "spawns a process and returns SpawnedProcess handle",
      async () => {
        const proc = spawnWithOutput(runner, "hello");
        runningProcesses.push(proc);
        trackProcess(proc);

        expect(proc.pid).toBeDefined();
        expect(typeof proc.pid).toBe("number");

        const result = await proc.wait();

        expect(result.stdout).toContain("hello");
        expect(result.exitCode).toBe(0);
      },
      TEST_TIMEOUT
    );

    it(
      "captures stdout from process",
      async () => {
        const proc = spawnWithOutput(runner, "test output");
        runningProcesses.push(proc);
        trackProcess(proc);

        const result = await proc.wait();

        expect(result.stdout).toContain("test output");
      },
      TEST_TIMEOUT
    );

    it(
      "captures stderr from process",
      async () => {
        const proc = spawnWithOutput(runner, "", "error");
        runningProcesses.push(proc);
        trackProcess(proc);

        const result = await proc.wait();

        expect(result.stderr).toContain("error");
      },
      TEST_TIMEOUT
    );

    it(
      "provides exit code on completion",
      async () => {
        const proc = spawnWithExitCode(runner, 0);
        runningProcesses.push(proc);
        trackProcess(proc);

        const result = await proc.wait();

        expect(result.exitCode).toBe(0);
      },
      TEST_TIMEOUT
    );

    it(
      "provides non-zero exit code on failure (no throw)",
      async () => {
        const proc = spawnWithExitCode(runner, 42);
        runningProcesses.push(proc);
        trackProcess(proc);

        const result = await proc.wait();

        expect(result.exitCode).toBe(42);
      },
      TEST_TIMEOUT
    );

    it(
      "supports custom working directory",
      async () => {
        // Use os.tmpdir() for cross-platform temp directory
        const tempDir = os.tmpdir();
        // Use Node.js to print cwd - cross-platform
        const proc = runner.run(process.execPath, ["-e", "console.log(process.cwd())"], {
          cwd: tempDir,
        });
        runningProcesses.push(proc);
        trackProcess(proc);

        const result = await proc.wait();

        // Normalize paths for comparison (handles Windows path casing and trailing slashes)
        expect(path.normalize(result.stdout.trim())).toBe(path.normalize(tempDir));
      },
      TEST_TIMEOUT
    );

    it(
      "supports environment variables",
      async () => {
        // Use Node.js to print env var - cross-platform
        const proc = runner.run(process.execPath, ["-e", "console.log(process.env.TEST_VAR)"], {
          env: { ...process.env, TEST_VAR: "test_value" },
        });
        runningProcesses.push(proc);
        trackProcess(proc);

        const result = await proc.wait();

        expect(result.stdout).toContain("test_value");
      },
      TEST_TIMEOUT
    );
  });

  describe("kill() behavior", () => {
    // Windows-specific test: kill always uses forceful termination
    it.skipIf(!isWindows)(
      "Windows kill() uses forceful termination immediately",
      async () => {
        const proc = spawnLongRunning(runner, 30_000);
        runningProcesses.push(proc);
        trackProcess(proc);

        // On Windows, kill should terminate immediately with forceful kill
        const killResult = await proc.kill(1000, 1000);
        expect(killResult.success).toBe(true);

        // Verify process is actually dead
        const died = await waitForProcessDeath(proc.pid!, 500);
        expect(died).toBe(true);
      },
      TEST_TIMEOUT
    );

    it.skipIf(!isWindows)(
      "Windows kill() with process tree terminates all children",
      async () => {
        // Cross-platform test using Node.js to spawn parent with child
        const proc = spawnWithChild(runner, 30_000);
        runningProcesses.push(proc);
        trackProcess(proc);

        // Wait for child to spawn and PID to be printed
        await delay(200);

        // Kill parent - should kill children too via taskkill /t
        const killResult = await proc.kill(1000, 1000);
        expect(killResult.success).toBe(true);

        // Get the result to capture stdout with child PID
        const result = await proc.wait(1000);
        const childPid = parseInt(result.stdout.trim(), 10);

        if (childPid && !isNaN(childPid)) {
          spawnedPids.push(childPid);

          // Verify child is also dead (killed by tree kill via taskkill /t)
          const died = await waitForProcessDeath(childPid, 1000);
          expect(died).toBe(true);
        }
      },
      TEST_TIMEOUT
    );

    it.skipIf(isWindows)(
      "kill() terminates process with SIGTERM when it responds",
      async () => {
        const proc = spawnLongRunning(runner, 30_000);
        runningProcesses.push(proc);
        trackProcess(proc);

        // kill(5000, 0) - wait up to 5s for SIGTERM, don't wait for SIGKILL
        const killResult = await proc.kill(5000, 0);
        expect(killResult.success).toBe(true);
        expect(killResult.reason).toBe("SIGTERM");

        const result = await proc.wait();
        expect(result.exitCode).toBeNull();
      },
      TEST_TIMEOUT
    );

    it.skipIf(isWindows)(
      "kill() escalates to SIGKILL when SIGTERM is ignored",
      async () => {
        // Spawn process that ignores SIGTERM using trap (Unix-only utility)
        const proc = spawnIgnoringSignals(runner);
        runningProcesses.push(proc);
        trackProcess(proc);

        const pid = proc.pid;
        expect(pid).toBeDefined();

        // kill(500, 1000) - wait 500ms for SIGTERM (ignored), then SIGKILL with 1s wait
        const killResult = await proc.kill(500, 1000);

        // Should have escalated to SIGKILL since SIGTERM was ignored
        expect(killResult.success).toBe(true);
        expect(killResult.reason).toBe("SIGKILL");

        // Verify process is actually dead at OS level
        const died = await waitForProcessDeath(pid!, 500);
        expect(died).toBe(true);
      },
      TEST_TIMEOUT
    );

    it(
      "kill() on already dead process returns success with SIGTERM",
      async () => {
        const proc = spawnWithOutput(runner, "done");
        runningProcesses.push(proc);
        trackProcess(proc);

        await proc.wait();

        // kill() on dead process - SIGTERM send "succeeds" but process already done
        const killResult = await proc.kill(100, 100);
        // Process was already dead, kill returns success (nothing to do)
        expect(killResult.success).toBe(true);
      },
      TEST_TIMEOUT
    );

    it(
      "kill() respects configured timeouts",
      async () => {
        const proc = spawnLongRunning(runner, 30_000);
        runningProcesses.push(proc);
        trackProcess(proc);

        const start = Date.now();
        // Use short timeouts - process should be killed quickly
        const killResult = await proc.kill(500, 500);
        const elapsed = Date.now() - start;

        expect(killResult.success).toBe(true);
        // Should complete within a reasonable time (not hang)
        expect(elapsed).toBeLessThan(3000);
      },
      TEST_TIMEOUT
    );

    it(
      "kill() without timeouts sends SIGTERM and SIGKILL immediately",
      async () => {
        const proc = spawnLongRunning(runner, 30_000);
        runningProcesses.push(proc);
        trackProcess(proc);

        // kill() with no timeouts - sends SIGTERM then SIGKILL immediately
        const killResult = await proc.kill();
        // Process should be killed (either by SIGTERM or SIGKILL)
        expect(killResult.success).toBe(false); // No wait, so we can't confirm exit

        // Wait for process to actually exit
        const result = await proc.wait(1000);
        if (process.platform === "win32") {
          // Windows: taskkill terminates with exit code 1, not a signal
          expect(result.exitCode).toBe(1);
        } else {
          // Unix: killed by signal returns null exitCode
          expect(result.exitCode).toBeNull();
        }
      },
      TEST_TIMEOUT
    );
  });

  describe("timeout behavior", () => {
    it(
      "wait() with timeout returns running:true when process does not exit in time",
      async () => {
        const proc = spawnLongRunning(runner, 30_000);
        runningProcesses.push(proc);
        trackProcess(proc);

        const result = await proc.wait(100);

        expect(result.running).toBe(true);
        expect(result.exitCode).toBeNull();

        proc.kill();
      },
      TEST_TIMEOUT
    );

    it(
      "wait() with timeout returns result when process exits before timeout",
      async () => {
        const proc = spawnWithOutput(runner, "quick");
        runningProcesses.push(proc);
        trackProcess(proc);

        const result = await proc.wait(5000);

        expect(result.running).toBeUndefined();
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("quick");
      },
      TEST_TIMEOUT
    );

    it(
      "multiple wait() calls return cached result after process exits",
      async () => {
        const proc = spawnWithOutput(runner, "cached");
        runningProcesses.push(proc);
        trackProcess(proc);

        const result1 = await proc.wait();
        const result2 = await proc.wait();

        expect(result1).toEqual(result2);
      },
      TEST_TIMEOUT
    );

    it(
      "wait() after natural exit returns cached result immediately",
      async () => {
        const proc = spawnWithOutput(runner, "done");
        runningProcesses.push(proc);
        trackProcess(proc);

        // Wait for process to complete naturally
        await proc.wait();

        // Delay then call wait() again
        await delay(100);

        const start = Date.now();
        const result = await proc.wait();
        const elapsed = Date.now() - start;

        // Should return almost immediately (cached)
        expect(elapsed).toBeLessThan(50);
        expect(result.exitCode).toBe(0);
      },
      TEST_TIMEOUT
    );

    it(
      "concurrent wait() calls return same result",
      async () => {
        // Use Node.js with a brief delay instead of shell sleep
        const proc = runner.run(process.execPath, [
          "-e",
          'setTimeout(() => console.log("concurrent"), 100)',
        ]);
        runningProcesses.push(proc);
        trackProcess(proc);

        // Call wait() twice concurrently
        const [result1, result2] = await Promise.all([proc.wait(), proc.wait()]);

        expect(result1).toEqual(result2);
        expect(result1.stdout).toContain("concurrent");
      },
      TEST_TIMEOUT
    );

    it(
      "wait(0) returns running:true immediately for long process",
      async () => {
        const proc = spawnLongRunning(runner, 30_000);
        runningProcesses.push(proc);
        trackProcess(proc);

        const start = Date.now();
        const result = await proc.wait(0);
        const elapsed = Date.now() - start;

        expect(result.running).toBe(true);
        expect(elapsed).toBeLessThan(50);

        proc.kill();
      },
      TEST_TIMEOUT
    );

    it(
      "wait() without timeout waits for process completion",
      async () => {
        // Use Node.js with a brief delay instead of shell sleep
        const proc = runner.run(process.execPath, [
          "-e",
          'setTimeout(() => console.log("completed"), 100)',
        ]);
        runningProcesses.push(proc);
        trackProcess(proc);

        const result = await proc.wait();

        expect(result.running).toBeUndefined();
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("completed");
      },
      TEST_TIMEOUT
    );
  });

  describe("environment isolation", () => {
    it(
      "custom env excludes inherited variables",
      async () => {
        // Set a variable in the test process
        process.env.BOUNDARY_TEST_VAR = "should_not_inherit";

        try {
          // Spawn with custom env that excludes the variable - use Node.js
          const proc = runner.run(
            process.execPath,
            ["-e", 'console.log(process.env.BOUNDARY_TEST_VAR || "EMPTY")'],
            { env: { PATH: process.env.PATH } }
          );
          runningProcesses.push(proc);
          trackProcess(proc);

          const result = await proc.wait();

          expect(result.stdout.trim()).toBe("EMPTY");
        } finally {
          delete process.env.BOUNDARY_TEST_VAR;
        }
      },
      TEST_TIMEOUT
    );

    it(
      "empty string env values are preserved",
      async () => {
        // Use Node.js to check empty string env var
        const proc = runner.run(
          process.execPath,
          ["-e", "console.log(`>${process.env.TEST_EMPTY}<`)"],
          { env: { ...process.env, TEST_EMPTY: "" } }
        );
        runningProcesses.push(proc);
        trackProcess(proc);

        const result = await proc.wait();

        expect(result.stdout.trim()).toBe("><");
      },
      TEST_TIMEOUT
    );

    it(
      "special characters in env values are preserved",
      async () => {
        const specialValue = "foo$bar\"baz'qux";
        // Use Node.js to print env var - handles special chars correctly
        const proc = runner.run(process.execPath, ["-e", "console.log(process.env.TEST_SPECIAL)"], {
          env: { ...process.env, TEST_SPECIAL: specialValue },
        });
        runningProcesses.push(proc);
        trackProcess(proc);

        const result = await proc.wait();

        expect(result.stdout.trim()).toBe(specialValue);
      },
      TEST_TIMEOUT
    );

    it(
      "long env values are not truncated",
      async () => {
        const longValue = "x".repeat(2000); // 2KB string
        // Use Node.js to get length - cross-platform
        const proc = runner.run(
          process.execPath,
          ["-e", "console.log(process.env.TEST_LONG.length)"],
          { env: { ...process.env, TEST_LONG: longValue } }
        );
        runningProcesses.push(proc);
        trackProcess(proc);

        const result = await proc.wait();

        const length = parseInt(result.stdout.trim(), 10);
        expect(length).toBe(2000);
      },
      TEST_TIMEOUT
    );
  });

  describe("error handling", () => {
    // Skip on Windows: execa/cross-spawn wraps unknown commands in cmd.exe which
    // reports "command not found" via stderr and exit code 1, rather than failing
    // the spawn with ENOENT. This is fundamental to how cross-spawn handles Windows.
    it.skipIf(isWindows)(
      "handles ENOENT when command not found",
      async () => {
        const proc = runner.run("nonexistent-command-12345", []);
        runningProcesses.push(proc);
        // Don't track PID as it will be undefined

        const result = await proc.wait();

        expect(result.exitCode).toBeNull();
        expect(result.stderr).toContain("ENOENT");
        expect(proc.pid).toBeUndefined();
      },
      TEST_TIMEOUT
    );
  });

  describe("process tree cleanup", () => {
    it(
      "kill() kills child processes along with parent",
      async () => {
        // Cross-platform test using Node.js to spawn parent with child
        const proc = spawnWithChild(runner, 30_000);
        runningProcesses.push(proc);
        trackProcess(proc);

        // Wait for child to spawn and PID to be printed
        await delay(200);

        // Kill parent with graceful shutdown
        const killResult = await proc.kill(1000, 1000);
        expect(killResult.success).toBe(true);

        // Get the result to capture stdout with child PID
        const result = await proc.wait(1000);
        const childPid = parseInt(result.stdout.trim(), 10);

        expect(childPid).toBeDefined();
        expect(isNaN(childPid)).toBe(false);

        // Track for cleanup in case assertion fails
        spawnedPids.push(childPid);

        // Verify child is also dead (killed by tree kill)
        const died = await waitForProcessDeath(childPid, 1000);
        expect(died).toBe(true);
      },
      TEST_TIMEOUT
    );

    // Unix-only: test SIGTERM behavior specifically (Windows doesn't have graceful SIGTERM)
    it.skipIf(isWindows)(
      "kill() kills child processes via SIGTERM on Unix",
      async () => {
        // Spawn parent that creates a child and echoes its PID using shell
        const proc = runner.run("sh", ["-c", "sleep 30 & echo $!; wait"]);
        runningProcesses.push(proc);
        trackProcess(proc);

        // Wait for child PID to be printed
        await delay(100);

        // Kill parent with graceful shutdown (SIGTERM with 1s timeout)
        const killResult = await proc.kill(1000, 100);
        expect(killResult.success).toBe(true);
        expect(killResult.reason).toBe("SIGTERM");

        // Get the result to capture stdout with child PID
        const result = await proc.wait(1000);
        const childPid = parseInt(result.stdout.trim(), 10);

        if (childPid && !isNaN(childPid)) {
          spawnedPids.push(childPid);

          // Wait for child to die
          const died = await waitForProcessDeath(childPid, 500);
          expect(died).toBe(true);
        }
      },
      TEST_TIMEOUT
    );

    // Unix-only: test SIGKILL escalation when SIGTERM is ignored
    it.skipIf(isWindows)(
      "kill() kills child processes via SIGKILL escalation on Unix",
      async () => {
        // Spawn parent that creates a child that ignores SIGTERM
        const proc = runner.run("sh", ["-c", "trap '' TERM; sleep 30 & echo $!; wait"]);
        runningProcesses.push(proc);
        trackProcess(proc);

        // Wait for child PID to be printed
        await delay(100);

        // Kill parent with short SIGTERM timeout (will escalate to SIGKILL)
        const killResult = await proc.kill(200, 500);
        expect(killResult.success).toBe(true);
        expect(killResult.reason).toBe("SIGKILL"); // Should have escalated

        // Get the result to capture stdout with child PID
        const result = await proc.wait(1000);
        const childPid = parseInt(result.stdout.trim(), 10);

        if (childPid && !isNaN(childPid)) {
          spawnedPids.push(childPid);

          // Wait for child to die
          const died = await waitForProcessDeath(childPid, 500);
          expect(died).toBe(true);
        }
      },
      TEST_TIMEOUT
    );
  });

  describe("large output", () => {
    it(
      "handles large stdout without hanging or truncation",
      async () => {
        // Generate ~137KB of base64 output using Node.js Buffer - cross-platform
        const proc = runner.run(process.execPath, [
          "-e",
          'console.log(Buffer.alloc(100 * 1024, 0).toString("base64"))',
        ]);
        runningProcesses.push(proc);
        trackProcess(proc);

        const result = await proc.wait();

        expect(result.exitCode).toBe(0);
        // 100KB of zeros produces ~137KB of base64 (4/3 ratio)
        expect(result.stdout.length).toBeGreaterThan(130000);
      },
      TEST_TIMEOUT
    );
  });
});
