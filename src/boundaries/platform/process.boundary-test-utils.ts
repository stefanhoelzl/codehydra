/**
 * Cross-platform utilities for boundary tests.
 *
 * Uses Node.js as the process spawner (guaranteed available in test environment)
 * to avoid platform-specific shell commands like `sleep`, `echo`, `sh -c`.
 *
 * These utilities are NOT separately tested - they are proven correct through
 * usage in actual boundary tests.
 */

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
 * Spawn a parent process that creates a single child and prints the child's PID.
 * Cross-platform using Node.js child_process.
 *
 * The parent prints the child's PID to stdout immediately after spawning.
 * Both parent and child run for `durationMs` unless killed.
 *
 * @param runner - ProcessRunner to use for spawning
 * @param durationMs - How long both processes should run (default: 30_000)
 * @returns SpawnedProcess handle for the parent
 *
 * @example
 * const proc = spawnWithChild(runner, 30_000);
 * await new Promise(r => setTimeout(r, 200)); // Wait for child to spawn
 * await proc.kill(1000, 1000);
 * const result = await proc.wait();
 * const childPid = parseInt(result.stdout.trim(), 10);
 * // Verify childPid is dead
 */
export function spawnWithChild(runner: ProcessRunner, durationMs: number = 30_000): SpawnedProcess {
  if (durationMs < 0) {
    throw new Error("Duration must be non-negative");
  }
  // Node.js script that spawns a child and prints its PID to stdout
  // Uses CommonJS syntax because -e eval context doesn't support ESM imports
  const script = `
    const { spawn } = require("child_process");
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, ${durationMs})"], {
      stdio: "ignore",
      detached: false
    });
    console.log(child.pid);
    setTimeout(() => {}, ${durationMs});
  `;
  return runner.run(process.execPath, ["-e", script]);
}
