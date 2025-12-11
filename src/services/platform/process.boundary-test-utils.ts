/**
 * Cross-platform utilities for boundary tests.
 *
 * Uses Node.js as the process spawner (guaranteed available in test environment)
 * to avoid platform-specific shell commands like `sleep`, `echo`, `sh -c`.
 *
 * These utilities are NOT separately tested - they are proven correct through
 * usage in actual boundary tests.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ProcessRunner, SpawnedProcess } from "./process";

/**
 * Platform detection constant.
 * Use with vitest's it.skipIf() for platform-specific tests.
 *
 * @example
 * it.skipIf(isWindows)("Unix signal test", async () => {
 *   // This test only runs on Unix
 * });
 */
export const isWindows: boolean = process.platform === "win32";

/**
 * Spawn a long-running process (no children).
 * Cross-platform using Node.js setTimeout.
 *
 * @param runner - ProcessRunner to use for spawning
 * @param durationMs - How long the process should run (default: 60_000)
 * @returns SpawnedProcess handle
 * @throws Error if durationMs < 0
 *
 * @example
 * const proc = spawnLongRunning(runner, 30_000);
 * // Process runs for 30 seconds
 */
export function spawnLongRunning(
  runner: ProcessRunner,
  durationMs: number = 60_000
): SpawnedProcess {
  if (durationMs < 0) {
    throw new Error("Duration must be non-negative");
  }
  const script = `setTimeout(() => {}, ${durationMs})`;
  return runner.run(process.execPath, ["-e", script]);
}

/**
 * Spawn a process that outputs to stdout and optionally stderr.
 * Cross-platform using Node.js console methods.
 *
 * String content is safely escaped using JSON.stringify to handle
 * special characters, quotes, and newlines.
 *
 * @param runner - ProcessRunner to use for spawning
 * @param stdout - Content to write to stdout
 * @param stderr - Optional content to write to stderr
 * @returns SpawnedProcess handle
 *
 * @example
 * const proc = spawnWithOutput(runner, "hello", "error");
 * const result = await proc.wait();
 * // result.stdout = "hello\n"
 * // result.stderr = "error\n"
 *
 * @example
 * // Special characters are handled safely
 * const proc = spawnWithOutput(runner, "user's \"input\"");
 * const result = await proc.wait();
 * // result.stdout = "user's \"input\"\n"
 */
export function spawnWithOutput(
  runner: ProcessRunner,
  stdout: string,
  stderr?: string
): SpawnedProcess {
  let script = `console.log(${JSON.stringify(stdout)})`;
  if (stderr !== undefined) {
    script += `; console.error(${JSON.stringify(stderr)})`;
  }
  return runner.run(process.execPath, ["-e", script]);
}

/**
 * Spawn a process that exits with a specific code.
 * Cross-platform using Node.js process.exit.
 *
 * @param runner - ProcessRunner to use for spawning
 * @param exitCode - Exit code for the process (0-255)
 * @returns SpawnedProcess handle
 *
 * @example
 * const proc = spawnWithExitCode(runner, 42);
 * const result = await proc.wait();
 * // result.exitCode = 42
 */
export function spawnWithExitCode(runner: ProcessRunner, exitCode: number): SpawnedProcess {
  if (exitCode < 0 || exitCode > 255) {
    throw new Error("Exit code must be in range 0-255");
  }
  const script = `process.exit(${exitCode})`;
  return runner.run(process.execPath, ["-e", script]);
}

/**
 * Spawn a process that ignores SIGTERM.
 * **Unix-only** - use with it.skipIf(isWindows).
 *
 * On Windows, SIGTERM is not trappable - it calls TerminateProcess
 * which immediately kills the process (similar to SIGKILL on Unix).
 *
 * @param runner - ProcessRunner to use for spawning
 * @returns SpawnedProcess handle
 * @throws Error if called on Windows
 *
 * @example
 * it.skipIf(isWindows)("escalates SIGTERM to SIGKILL", async () => {
 *   const proc = spawnIgnoringSignals(runner);
 *   proc.kill("SIGTERM"); // Ignored on Unix
 *   proc.kill("SIGKILL"); // Works
 * });
 */
export function spawnIgnoringSignals(runner: ProcessRunner): SpawnedProcess {
  if (isWindows) {
    throw new Error("spawnIgnoringSignals is only supported on Unix platforms");
  }
  // Use shell trap to ignore SIGTERM, then sleep
  return runner.run("sh", ["-c", 'trap "" TERM; sleep 60']);
}

/**
 * Handle for a process with children.
 * Use `waitForChildPids()` to get child PIDs (self-synchronizing).
 * Use `cleanup()` in afterEach to ensure all processes are killed.
 */
export interface ProcessWithChildren {
  /** The spawned parent process */
  readonly process: SpawnedProcess;

  /**
   * Wait for children to spawn and return their PIDs.
   * Self-synchronizing: waits for parent to output child PIDs to stdout.
   * @param timeoutMs - Max time to wait for children (default: 5000)
   * @returns Array of child PIDs (readonly to prevent accidental mutation)
   * @throws Error if timeout exceeded before children reported
   */
  waitForChildPids(timeoutMs?: number): Promise<readonly number[]>;

  /**
   * Kill parent process and all tracked children.
   * Call this in afterEach to ensure cleanup.
   */
  cleanup(): Promise<void>;
}

/**
 * Spawn a process that creates N child processes.
 * Cross-platform using Node.js child_process.
 *
 * The parent process writes child PIDs to a temp file, then waits.
 * Use waitForChildPids() to get the PIDs (polls the file until available).
 * Use cleanup() in afterEach to kill parent and all children.
 *
 * @param runner - ProcessRunner to use for spawning
 * @param childCount - Number of child processes to create (must be >= 1)
 * @returns ProcessWithChildren with parent process, PID accessor, and cleanup
 * @throws Error if childCount < 1
 *
 * @example
 * const spawned = spawnWithChildren(runner, 2);
 * const childPids = await spawned.waitForChildPids();
 * // childPids = [12345, 12346] (readonly)
 *
 * // In afterEach:
 * await spawned.cleanup();
 */
export function spawnWithChildren(runner: ProcessRunner, childCount: number): ProcessWithChildren {
  if (childCount < 1) {
    throw new Error("childCount must be at least 1");
  }

  // Use a temp file to communicate child PIDs from parent process
  // This avoids issues with stdout not being available until process exits
  const tempDir = os.tmpdir();
  const pidFile = path.join(tempDir, `process-tree-test-${Date.now()}-${Math.random()}.json`);

  // Script that spawns N children, writes PIDs to file, then waits
  // Uses CommonJS syntax because -e eval context doesn't support ESM imports
  const script = `
    const { spawn } = require("child_process");
    const fs = require("fs");
    const children = [];
    for (let i = 0; i < ${childCount}; i++) {
      const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], {
        stdio: "ignore",
        detached: false
      });
      children.push(child.pid);
    }
    fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify(children));
    setTimeout(() => {}, 60000);
  `;

  const proc = runner.run(process.execPath, ["-e", script]);
  let childPids: readonly number[] | null = null;

  return {
    process: proc,

    async waitForChildPids(timeoutMs: number = 5000): Promise<readonly number[]> {
      if (childPids !== null) {
        return childPids;
      }

      // Poll the temp file until PIDs are written
      const startTime = Date.now();
      const pollInterval = 50;

      while (Date.now() - startTime < timeoutMs) {
        try {
          if (fs.existsSync(pidFile)) {
            const content = fs.readFileSync(pidFile, "utf8");
            const pids = JSON.parse(content) as number[];
            childPids = Object.freeze([...pids]);

            // Clean up temp file
            try {
              fs.unlinkSync(pidFile);
            } catch {
              // Ignore cleanup errors
            }

            return childPids;
          }
        } catch {
          // File not ready yet, keep polling
        }

        await new Promise((r) => setTimeout(r, pollInterval));
      }

      throw new Error(`Timeout waiting for child PIDs after ${timeoutMs}ms`);
    },

    async cleanup(): Promise<void> {
      // Kill parent first
      proc.kill("SIGKILL");

      // Wait briefly for parent to die
      await proc.wait(100);

      // Kill all tracked children
      if (childPids !== null) {
        for (const pid of childPids) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Process already dead - expected
          }
        }
      }

      // Clean up temp file if it still exists
      try {
        if (fs.existsSync(pidFile)) {
          fs.unlinkSync(pidFile);
        }
      } catch {
        // Ignore cleanup errors
      }
    },
  };
}
