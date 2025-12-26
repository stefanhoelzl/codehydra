/**
 * Process spawning utilities.
 */

import { execa } from "execa";
import type { Logger } from "../logging";

/**
 * Platform detection for kill logic.
 * Windows uses taskkill, Unix uses process.kill.
 */
const isWindows = process.platform === "win32";

/**
 * Default timeout for graceful termination (SIGTERM on Unix).
 * On Windows, this is combined with FORCE_TIMEOUT since only forceful kill is used.
 */
export const PROCESS_KILL_GRACEFUL_TIMEOUT_MS = 1000;

/**
 * Default timeout for forced termination (SIGKILL on Unix).
 */
export const PROCESS_KILL_FORCE_TIMEOUT_MS = 1000;

export interface ProcessOptions {
  /** Working directory for the process */
  readonly cwd?: string;
  /**
   * Environment variables.
   * When provided, replaces process.env entirely (no merging).
   */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Result of running a process command.
 */
export interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  /**
   * Exit code, or null if process didn't exit normally.
   * null when: killed by signal, spawn error, or still running after timeout.
   */
  readonly exitCode: number | null;
  /** Signal name if process was killed (e.g., 'SIGTERM', 'SIGKILL') */
  readonly signal?: string;
  /**
   * True if process is still running after wait(timeout) returned.
   * Caller should decide whether to kill() or continue waiting.
   */
  readonly running?: boolean;
}

/**
 * Result of killing a process.
 */
export interface KillResult {
  /** True if the process exited successfully */
  readonly success: boolean;
  /** The signal that successfully terminated the process */
  readonly reason?: "SIGTERM" | "SIGKILL";
}

/**
 * Handle for a spawned process.
 * Provides access to PID and methods to control the process.
 */
export interface SpawnedProcess {
  /**
   * Process ID.
   * undefined if process failed to spawn (e.g., ENOENT, EACCES).
   */
  readonly pid: number | undefined;

  /**
   * Graceful shutdown: SIGTERM → wait → SIGKILL → wait.
   * Also kills child processes.
   *
   * @param termTimeout - Wait time after SIGTERM (ms). undefined = skip wait, proceed to SIGKILL.
   * @param killTimeout - Wait time after SIGKILL (ms). undefined = skip wait, return immediately.
   * @returns {success: true, reason: "SIGTERM"|"SIGKILL"} if exited, {success: false} if still running
   */
  kill(termTimeout?: number, killTimeout?: number): Promise<KillResult>;

  /**
   * Wait for the process to exit.
   * Never throws for process exit status - check result fields instead.
   * May still throw for unexpected errors (should not happen in practice).
   *
   * @param timeout - Max time to wait in ms. If exceeded, returns with running=true.
   * @returns ProcessResult with exit status or running indicator
   *
   * @example
   * // Wait indefinitely
   * const result = await proc.wait();
   *
   * @example
   * // Wait with timeout, then use new kill() API
   * const result = await proc.kill(5000, 5000);
   * if (!result.success) {
   *   console.error('Process did not exit');
   * }
   */
  wait(timeout?: number): Promise<ProcessResult>;
}

/**
 * Interface for running external processes.
 * Returns a SpawnedProcess handle for full process control.
 * Allows dependency injection for testing.
 */
export interface ProcessRunner {
  /**
   * Start a process and return a handle to control it.
   * Returns synchronously - the process is spawned immediately.
   *
   * @example
   * const proc = runner.run('ls', ['-la']);
   * const result = await proc.wait();
   * if (result.exitCode !== 0) {
   *   console.error(result.stderr);
   * }
   */
  run(command: string, args: readonly string[], options?: ProcessOptions): SpawnedProcess;
}

/**
 * Type alias for execa subprocess - using ReturnType to get the exact type.
 */
type ExecaSubprocess = ReturnType<typeof execa>;

/**
 * Symbol used to indicate timeout in Promise.race.
 */
const TIMEOUT_SYMBOL = Symbol("timeout");

/**
 * SpawnedProcess implementation wrapping an execa subprocess.
 */
export class ExecaSpawnedProcess implements SpawnedProcess {
  private readonly subprocess: ExecaSubprocess;
  private readonly logger: Logger;
  private readonly command: string;
  private cachedResult: ProcessResult | null = null;

  constructor(subprocess: ExecaSubprocess, logger: Logger, command: string) {
    this.subprocess = subprocess;
    this.logger = logger;
    this.command = command;
  }

  get pid(): number | undefined {
    return this.subprocess.pid;
  }

  async kill(termTimeout?: number, killTimeout?: number): Promise<KillResult> {
    const pid = this.subprocess.pid;
    if (pid === undefined) {
      // Process never started, consider it "killed"
      return { success: true, reason: "SIGTERM" };
    }

    if (isWindows) {
      // Windows: Always use forceful kill (taskkill /f) because:
      // 1. WM_CLOSE (taskkill without /f) is ignored by console apps
      // 2. We can't send CTRL_C_EVENT to detached processes
      // So we skip the "graceful" phase entirely and go straight to forceful.
      await this.killProcess(pid, true);
      this.logger.warn("Killed", { command: this.command, pid, signal: "TASKKILL" });

      // Wait for termTimeout (combined wait since we only do one kill)
      const timeout = (termTimeout ?? 0) + (killTimeout ?? 0);
      if (timeout > 0) {
        const result = await this.wait(timeout);
        if (!result.running) {
          return { success: true, reason: "SIGKILL" }; // Report as SIGKILL for consistency
        }
      }

      // Process may still be running
      return { success: false };
    }

    // Unix: Two-phase SIGTERM → SIGKILL
    // 1. Send SIGTERM
    await this.killProcess(pid, false);
    this.logger.warn("Killed", { command: this.command, pid, signal: "SIGTERM" });

    // 2. If termTimeout defined, wait for graceful exit
    if (termTimeout !== undefined) {
      const result = await this.wait(termTimeout);
      if (!result.running) {
        return { success: true, reason: "SIGTERM" };
      }
    }

    // 3. Send SIGKILL
    await this.killProcess(pid, true);
    this.logger.warn("Killed", { command: this.command, pid, signal: "SIGKILL" });

    // 4. If killTimeout defined, wait for forced exit
    if (killTimeout !== undefined) {
      const result = await this.wait(killTimeout);
      if (!result.running) {
        return { success: true, reason: "SIGKILL" };
      }
    }

    // 5. Process may still be running
    return { success: false };
  }

  /**
   * Kill a process and its children using platform-appropriate method.
   * - Windows: taskkill /pid <pid> /t /f for native tree killing
   *   (Always uses /f because WM_CLOSE cannot signal console processes)
   * - Unix: pkill -P to kill children, then process.kill for parent
   *
   * @param pid - Process ID to kill
   * @param force - If true, use SIGKILL (Unix only). On Windows, always forceful.
   */
  private async killProcess(pid: number, force: boolean): Promise<void> {
    if (isWindows) {
      // Windows: Always use /f because WM_CLOSE (sent by taskkill without /f)
      // is ignored by console applications. We can't send CTRL_C_EVENT to
      // detached processes, so forceful termination is our only option.
      // The `force` parameter is ignored on Windows - always forceful.
      const args = ["/pid", String(pid), "/t", "/f"];
      try {
        await execa("taskkill", args);
      } catch {
        // Process may have already exited, or taskkill failed
        // (e.g., access denied, process not found)
      }
    } else {
      // Unix: kill children first with pkill -P, then kill parent
      const signal = force ? "SIGKILL" : "SIGTERM";

      // Kill all child processes by parent PID
      try {
        await execa("pkill", ["-P", String(pid), force ? "-9" : "-15"]);
      } catch {
        // pkill returns non-zero if no processes matched - that's fine
      }

      // Kill the parent process
      try {
        process.kill(pid, signal);
      } catch {
        // Process may have already exited (ESRCH)
      }
    }
  }

  async wait(timeout?: number): Promise<ProcessResult> {
    // If we have a cached result, return it
    if (this.cachedResult !== null) {
      return this.cachedResult;
    }

    // Create the process completion promise
    const processPromise = this.waitForProcess();

    // If no timeout, just wait for the process
    if (timeout === undefined) {
      const result = await processPromise;
      this.cachedResult = result;
      this.logResult(result);
      return result;
    }

    // Race between process completion and timeout
    const timeoutPromise = new Promise<typeof TIMEOUT_SYMBOL>((resolve) => {
      setTimeout(() => resolve(TIMEOUT_SYMBOL), timeout);
    });

    const raceResult = await Promise.race([processPromise, timeoutPromise]);

    if (raceResult === TIMEOUT_SYMBOL) {
      // Timeout occurred, process is still running
      this.logger.warn("Wait timeout", {
        command: this.command,
        pid: this.pid ?? 0,
        timeout,
      });
      return {
        stdout: "",
        stderr: "",
        exitCode: null,
        running: true,
      };
    }

    // Process completed
    this.cachedResult = raceResult;
    this.logResult(raceResult);
    return raceResult;
  }

  /**
   * Log the result of a completed process.
   */
  private logResult(result: ProcessResult): void {
    // Log stdout/stderr lines
    this.logOutputLines(result.stdout, "stdout");
    this.logOutputLines(result.stderr, "stderr");

    // Log exit status
    if (result.signal) {
      // Already logged in kill()
    } else {
      // Normal exit
      this.logger.debug("Exited", {
        command: this.command,
        pid: this.pid ?? 0,
        exitCode: result.exitCode ?? -1,
      });
    }
  }

  /**
   * Log output lines (stdout or stderr) at DEBUG level.
   */
  private logOutputLines(output: string, stream: "stdout" | "stderr"): void {
    if (!output) return;

    const lines = output.split("\n");
    const prefix = `[${this.command} ${this.pid ?? 0}]`;

    for (const line of lines) {
      // Skip empty lines
      if (line.trim() === "") continue;

      this.logger.debug(`${prefix} ${stream}: ${line}`);
    }
  }

  private async waitForProcess(): Promise<ProcessResult> {
    try {
      const result = await this.subprocess;
      return this.convertResult(result);
    } catch (error) {
      // Handle ENOENT, EACCES, and other spawn errors
      const err = error as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        exitCode?: number | null;
        signal?: string;
      };

      // If error has execa result properties, use them
      if ("stdout" in err || "stderr" in err) {
        const result: ProcessResult = {
          stdout: typeof err.stdout === "string" ? err.stdout : "",
          stderr: typeof err.stderr === "string" ? err.stderr : err.message,
          exitCode: typeof err.exitCode === "number" ? err.exitCode : null,
        };
        // Only include signal if it's defined (exactOptionalPropertyTypes compatibility)
        if (err.signal) {
          return { ...result, signal: err.signal };
        }
        return result;
      }

      // Pure spawn error (ENOENT, EACCES, etc.)
      this.logger.error("Spawn failed", {
        command: this.command,
        error: err.message,
      });
      return {
        stdout: "",
        stderr: err.message,
        exitCode: null,
      };
    }
  }

  private convertResult(result: Awaited<ExecaSubprocess>): ProcessResult {
    // Cast to get access to 'failed' and 'originalMessage' properties
    const execaResult = result as typeof result & {
      failed?: boolean;
      originalMessage?: string;
    };

    // For spawn errors (ENOENT, EACCES), execa sets failed=true and puts
    // error info in originalMessage instead of throwing (with reject: false)
    let stderr = typeof execaResult.stderr === "string" ? execaResult.stderr : "";
    if (execaResult.failed && execaResult.originalMessage && !stderr) {
      stderr = execaResult.originalMessage;
    }

    const processResult: ProcessResult = {
      stdout: typeof execaResult.stdout === "string" ? execaResult.stdout : "",
      stderr,
      exitCode: execaResult.exitCode ?? null,
    };
    // Only include signal if it's defined (exactOptionalPropertyTypes compatibility)
    if (execaResult.signal) {
      return { ...processResult, signal: execaResult.signal };
    }
    return processResult;
  }
}

/**
 * Process runner implementation using execa.
 * Returns a SpawnedProcess handle for controlling the spawned process.
 */
export class ExecaProcessRunner implements ProcessRunner {
  constructor(private readonly logger: Logger) {}

  run(command: string, args: readonly string[], options?: ProcessOptions): SpawnedProcess {
    const subprocess = execa(command, [...args], {
      cleanup: true,
      encoding: "utf8",
      reject: false, // Don't throw on non-zero exit - check exitCode instead
      ...(options?.cwd && { cwd: options.cwd }),
      // When custom env is provided, disable extendEnv so that deleted keys
      // from the custom env are actually removed (not inherited from process.env)
      ...(options?.env && { env: options.env, extendEnv: false }),
    }) as ExecaSubprocess;

    const spawned = new ExecaSpawnedProcess(subprocess, this.logger, command);

    // Check if spawn failed (no PID)
    if (spawned.pid === undefined) {
      // Log spawn failure when wait() is called (to get stderr with error message)
      // Don't log here - will be logged in wait()
    } else {
      // Log successful spawn
      this.logger.debug("Spawned", { command, args: args.join(" "), pid: spawned.pid });
    }

    return spawned;
  }
}
