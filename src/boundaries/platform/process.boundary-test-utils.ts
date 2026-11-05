/**
 * Cross-platform utilities for boundary tests.
 *
 * Uses Node.js as the process spawner (guaranteed available in test environment)
 * to avoid platform-specific shell commands like `sleep`, `echo`, `sh -c`.
 *
 * These utilities are NOT separately tested - they are proven correct through
 * usage in actual boundary tests.
 */

import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessRunner, SpawnedProcess } from "./process";
import { loadNativeAddon, nativeAddonFileName, type NativeAddon } from "./native-addon";

/**
 * The native addon for this platform as `pnpm build:wrappers` leaves it.
 *
 * Throws, never skips, when it has not been built: a boundary test that
 * silently skipped would report the process scan as working.
 */
export function nativeAddon(): NativeAddon {
  const file = join(process.cwd(), "dist", "bin", nativeAddonFileName());
  if (!existsSync(file)) {
    throw new Error(`${file} is missing: run \`pnpm build:wrappers\` first`);
  }
  return loadNativeAddon(file);
}

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
 * Check if a process is running using signal 0.
 */
export function isProcessRunning(pid: number): boolean {
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

/** How long `spawnIgnoringSignals` waits for the shell to reach its trap. */
const TRAP_INSTALL_TIMEOUT_MS = 2000;

/**
 * Spawn a process that ignores SIGTERM.
 * **Unix-only** - use with it.skipIf(isWindows).
 *
 * On Windows, SIGTERM is not trappable - it calls TerminateProcess
 * which immediately kills the process (similar to SIGKILL on Unix).
 *
 * Resolves only once the shell has installed its trap. Until then SIGTERM still
 * kills it, and a test that signals that early races the shell's startup: on
 * macOS the lookup before a tree kill takes about as long as `sh` takes to reach
 * `trap`. The shell creates a marker file after `trap` to say it got there.
 *
 * @param runner - ProcessRunner to use for spawning
 * @returns SpawnedProcess handle, already ignoring SIGTERM
 * @throws Error if called on Windows, or if the shell does not get there in time
 *
 * @example
 * it.skipIf(isWindows)("escalates SIGTERM to SIGKILL", async () => {
 *   const proc = await spawnIgnoringSignals(runner);
 *   await proc.kill(500, 1000); // SIGTERM is ignored, so this escalates to SIGKILL
 * });
 */
export async function spawnIgnoringSignals(runner: ProcessRunner): Promise<SpawnedProcess> {
  if (isWindows) {
    throw new Error("spawnIgnoringSignals is only supported on Unix platforms");
  }
  const dir = await mkdtemp(join(tmpdir(), "spawn-ignoring-signals-"));
  try {
    const marker = join(dir, "trap-installed");
    const proc = runner.run("sh", ["-c", 'trap "" TERM; : > "$1"; sleep 60', "sh", marker]);
    const deadline = Date.now() + TRAP_INSTALL_TIMEOUT_MS;
    while (!existsSync(marker)) {
      if (Date.now() >= deadline) {
        await proc.kill(0, 100);
        throw new Error(`sh did not install its trap within ${TRAP_INSTALL_TIMEOUT_MS}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return proc;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
