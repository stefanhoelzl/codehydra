// @vitest-environment node
import { describe, it, expect, afterEach } from "vitest";
import { ExecaProcessRunner, type SpawnedProcess, type ProcessRunner } from "./process";

// Platform detection for signal tests (Unix only)
const isWindows = process.platform === "win32";

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
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}

describe("ExecaProcessRunner", () => {
  const runner: ProcessRunner = new ExecaProcessRunner();
  const runningProcesses: SpawnedProcess[] = [];

  afterEach(async () => {
    // Clean up tracked SpawnedProcess handles
    for (const proc of runningProcesses) {
      try {
        proc.kill("SIGKILL");
        await proc.wait(100);
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
        const proc = runner.run("echo", ["hello"]);
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
        const proc = runner.run("echo", ["test output"]);
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
        const proc = runner.run("sh", ["-c", "echo error >&2"]);
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
        const proc = runner.run("sh", ["-c", "exit 0"]);
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
        const proc = runner.run("sh", ["-c", "exit 42"]);
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
        const proc = runner.run("pwd", [], { cwd: "/tmp" });
        runningProcesses.push(proc);
        trackProcess(proc);

        const result = await proc.wait();

        expect(result.stdout.trim()).toBe("/tmp");
      },
      TEST_TIMEOUT
    );

    it(
      "supports environment variables",
      async () => {
        const proc = runner.run("sh", ["-c", "echo $TEST_VAR"], {
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

  describe("signal handling", () => {
    it.skipIf(isWindows)(
      "terminates process with SIGTERM",
      async () => {
        const proc = runner.run("sleep", ["30"]);
        runningProcesses.push(proc);
        trackProcess(proc);

        const killed = proc.kill("SIGTERM");
        expect(killed).toBe(true);

        const result = await proc.wait();

        expect(result.signal).toBe("SIGTERM");
        expect(result.exitCode).toBeNull();
      },
      TEST_TIMEOUT
    );

    it.skipIf(isWindows)(
      "terminates process with SIGKILL",
      async () => {
        const proc = runner.run("sleep", ["30"]);
        runningProcesses.push(proc);
        trackProcess(proc);

        const killed = proc.kill("SIGKILL");
        expect(killed).toBe(true);

        const result = await proc.wait();

        expect(result.signal).toBe("SIGKILL");
        expect(result.exitCode).toBeNull();
      },
      TEST_TIMEOUT
    );

    it.skipIf(isWindows)(
      "SIGTERM to SIGKILL escalation for process that ignores SIGTERM",
      async () => {
        // Spawn process that ignores SIGTERM using trap
        const proc = runner.run("sh", ["-c", 'trap "" TERM; sleep 30']);
        runningProcesses.push(proc);
        trackProcess(proc);

        const pid = proc.pid;
        expect(pid).toBeDefined();

        // Send SIGTERM and verify process is still running (trap ignores it)
        const terminated = proc.kill("SIGTERM");
        expect(terminated).toBe(true);

        const stillRunning = await proc.wait(500);
        expect(stillRunning.running).toBe(true);

        // Verify process is actually still running at OS level
        expect(isProcessRunning(pid!)).toBe(true);

        // Escalate to SIGKILL using OS directly.
        // Why process.kill() instead of proc.kill()?
        // After the first kill() call, execa sets subprocess.killed = true internally.
        // Subsequent proc.kill() calls check this flag and may not send new signals.
        // Using process.kill() bypasses execa's wrapper and sends SIGKILL directly.
        process.kill(pid!, "SIGKILL");

        // Wait for process to actually die at OS level
        const died = await waitForProcessDeath(pid!, 1000);
        expect(died).toBe(true);

        // Get final result from execa's wait()
        const result = await proc.wait(1000);

        // The reported signal may be SIGTERM or SIGKILL depending on timing:
        // - SIGTERM if execa captured the first signal before we sent SIGKILL
        // - SIGKILL if execa saw our direct process.kill() signal
        // Either way, the process is dead and exitCode should be null (killed by signal)
        if (!result.running) {
          expect(result.exitCode).toBeNull();
          expect(result.signal).toMatch(/^SIG(TERM|KILL)$/);
        }
      },
      TEST_TIMEOUT
    );

    it(
      "kill() returns false when process already dead",
      async () => {
        const proc = runner.run("echo", ["done"]);
        runningProcesses.push(proc);
        trackProcess(proc);

        await proc.wait();

        const killed = proc.kill();
        expect(killed).toBe(false);
      },
      TEST_TIMEOUT
    );

    it(
      "rapid sequential kill() calls are safe",
      async () => {
        const proc = runner.run("sleep", ["30"]);
        runningProcesses.push(proc);
        trackProcess(proc);

        // Rapid sequential calls
        const result1 = proc.kill();
        const result2 = proc.kill();
        const result3 = proc.kill();

        // First should succeed, subsequent should return false
        expect(result1).toBe(true);
        expect(result2).toBe(false);
        expect(result3).toBe(false);

        // Wait for process to finish
        const result = await proc.wait();
        expect(result.exitCode).toBeNull();
      },
      TEST_TIMEOUT
    );
  });

  describe("timeout behavior", () => {
    it(
      "wait() with timeout returns running:true when process does not exit in time",
      async () => {
        const proc = runner.run("sleep", ["30"]);
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
        const proc = runner.run("echo", ["quick"]);
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
        const proc = runner.run("echo", ["cached"]);
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
        const proc = runner.run("echo", ["done"]);
        runningProcesses.push(proc);
        trackProcess(proc);

        // Wait for process to complete naturally
        await proc.wait();

        // Delay then call wait() again
        await new Promise((r) => setTimeout(r, 100));

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
        const proc = runner.run("sh", ["-c", "sleep 0.1; echo concurrent"]);
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
        const proc = runner.run("sleep", ["30"]);
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
        // Note: wait(Infinity) doesn't work as expected due to JavaScript's
        // setTimeout truncating Infinity to 1ms. Use wait() without timeout instead.
        const proc = runner.run("sh", ["-c", "sleep 0.1; echo completed"]);
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
          // Spawn with custom env that excludes the variable
          const proc = runner.run("sh", ["-c", "echo ${BOUNDARY_TEST_VAR:-EMPTY}"], {
            env: { PATH: process.env.PATH },
          });
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
        const proc = runner.run("sh", ["-c", 'echo ">${TEST_EMPTY}<"'], {
          env: { ...process.env, TEST_EMPTY: "" },
        });
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
        const proc = runner.run("sh", ["-c", 'echo "$TEST_SPECIAL"'], {
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
        const proc = runner.run("sh", ["-c", 'echo "$TEST_LONG" | wc -c'], {
          env: { ...process.env, TEST_LONG: longValue },
        });
        runningProcesses.push(proc);
        trackProcess(proc);

        const result = await proc.wait();

        // wc -c counts bytes including newline from echo
        const byteCount = parseInt(result.stdout.trim(), 10);
        expect(byteCount).toBe(2001); // 2000 chars + newline
      },
      TEST_TIMEOUT
    );
  });

  describe("error handling", () => {
    it(
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
    it.skipIf(isWindows)(
      "SIGTERM kills child processes",
      async () => {
        // Spawn parent that creates a child and echoes its PID
        const proc = runner.run("sh", ["-c", "sleep 30 & echo $!; wait"]);
        runningProcesses.push(proc);
        trackProcess(proc);

        // Wait for child PID to be printed
        await new Promise((r) => setTimeout(r, 100));

        // Kill parent with SIGTERM
        proc.kill("SIGTERM");

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

    it.skipIf(isWindows)(
      "SIGKILL kills child processes",
      async () => {
        // Spawn parent that creates a child and echoes its PID
        const proc = runner.run("sh", ["-c", "sleep 30 & echo $!; wait"]);
        runningProcesses.push(proc);
        trackProcess(proc);

        // Wait for child PID to be printed
        await new Promise((r) => setTimeout(r, 100));

        // Kill parent with SIGKILL
        proc.kill("SIGKILL");

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
    it.skipIf(isWindows)(
      "handles large stdout without hanging or truncation",
      async () => {
        // Generate ~137KB of base64 output
        const proc = runner.run("sh", [
          "-c",
          "dd if=/dev/zero bs=1024 count=100 2>/dev/null | base64",
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
