/**
 * Process spawning utilities.
 */

import { readdir, readFile, readlink } from "node:fs/promises";
import type { Readable } from "node:stream";
import { execa } from "execa";
import type { Logger } from "./logging";
import { raceTimeout, TIMED_OUT } from "../../utils/timeout";
import { errorCode, getErrorMessage } from "../../shared/error-utils";

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
  /**
   * Run `command` as a shell command line rather than an executable + argv.
   * Pass the whole line as `command` and `[]` as `args`.
   *
   * Use this for any command line that needs shell features (pipes, quoting,
   * env-var expansion). Do NOT hand-roll `sh -c` / `cmd /c` instead: spawning
   * `cmd` with `["/c", line]` leaves the line to be escaped as an ordinary
   * argument, and the resulting `\"` escapes are not something cmd.exe
   * understands, so any embedded double quote breaks. Node builds the correct
   * platform invocation here — `/bin/sh -c` on POSIX, and on Windows
   * `cmd.exe /d /s /c` with verbatim arguments so the line reaches cmd.exe
   * unmangled.
   */
  readonly shell?: boolean;
  /**
   * Mark this spawn as untrusted: its command line and its output may contain
   * credentials, so neither is written to the log verbatim at debug level.
   *
   * The string is the replacement identity. Every log site that would print the
   * command prints `command=<your text>` instead, and `args`/`spawnargs` are
   * omitted entirely — nothing of the real command line is ever logged. Output
   * lines are reduced to a byte count at debug (`stdout: 1234 bytes`); the full
   * line is still emitted at `silly`, which is opt-in.
   *
   * There is deliberately NO pattern-matching fallback: a spawn without
   * `redactBy` has its command, args and output logged in full. If you are
   * putting a token, password or credential-bearing URL into argv — or running
   * a user-authored command line that might — you MUST set this. Nothing else
   * will catch it.
   */
  readonly redactBy?: string;
  /**
   * Text written to the process's stdin, which is then closed.
   *
   * For handing a spawn a structured payload without putting it in argv, where
   * it would be visible to every other process on the machine and subject to
   * the platform's argument-length limit. Absent = stdin is not written to.
   */
  readonly input?: string;
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
   * Node's error code when the process could not be started at all (e.g.
   * 'ENOENT', 'EACCES'); `stderr` then carries Node's message, for display only.
   * Branch on this, never on `stderr`: that text is not a contract.
   *
   * Unset on Windows for a missing command: cross-spawn runs it through
   * cmd.exe, which starts fine and reports the failure as an exit code.
   */
  readonly spawnError?: string;
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
   * Also kills child processes, and on Unix each wait lasts until the process
   * *and* every descendant signalled with it have exited.
   *
   * @param termTimeout - Wait time after SIGTERM (ms). undefined = skip wait, proceed to SIGKILL.
   * @param killTimeout - Wait time after SIGKILL (ms). undefined = skip wait, return immediately.
   * @returns {success: true, reason: "SIGTERM"|"SIGKILL"} if the tree exited, {success: false} if any of it is still running
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
 * A process holding a listening socket, as reported by an OS-level scan.
 *
 * Deliberately its own type rather than the `BlockingProcess` the deletion
 * dialog uses: that one carries `files` and `cwd`, which mean nothing for a
 * port, and it lives in the intents layer, which a boundary must not depend on.
 */
export interface ListeningProcess {
  readonly pid: number;
  /** Executable name, e.g. "node" or "codehydra.exe". */
  readonly name: string;
  /** Full command line, or the bare name when the OS did not report one. */
  readonly commandLine: string;
}

/**
 * One process in an OS-wide snapshot (`ProcessRunner.listProcesses`).
 *
 * Every field the OS would not report for a process is null (or 0 for `ppid`)
 * rather than a guess: another user's process, a protected one on Windows, or
 * one that exited mid-scan. The entry itself is still listed.
 */
export interface ProcessSnapshotEntry {
  readonly pid: number;
  /** Parent pid; 0 when the OS reported none. */
  readonly ppid: number;
  /** Executable name, e.g. "node". */
  readonly name: string;
  /** Full command line, or the bare name when the OS did not report one. */
  readonly commandLine: string;
  /** Working directory, null when the OS would not tell. */
  readonly cwd: string | null;
  /** Resident memory, in bytes. */
  readonly rssBytes: number;
  /** User + system CPU time used since it started, in ms; null when unreadable. */
  readonly cpuTimeMs: number | null;
  /**
   * When it started, epoch ms; null when unreadable. With the pid, it tells a
   * process apart from a later one that reuses its pid.
   */
  readonly startedAt: number | null;
  /**
   * The value of the environment variable `listProcesses` was asked about
   * (`envVar`); null when unset, unreadable (another user's or a protected
   * process), or no variable was asked about. Linux and macOS report the
   * environment the process started with, Windows its current one.
   */
  readonly envValue: string | null;
}

/** What `listProcesses` reads besides the fixed fields. */
export interface ListProcessesOptions {
  /** An environment variable to read from every process (`envValue`). */
  readonly envVar?: string;
}

/** Every process on the machine at one moment. */
export interface ProcessSnapshot {
  /** Epoch ms the scan finished. */
  readonly takenAt: number;
  readonly processes: readonly ProcessSnapshotEntry[];
}

/**
 * How long an OS-level process scan may take before it is abandoned.
 *
 * A ceiling, not a delay: a scan that answers fast is unaffected by it, and one
 * that times out is indistinguishable from a free port at the call site — so a
 * budget that is too tight silently disables the whole feature. Windows keeps
 * the larger one from when its scan went through PowerShell and WMI (which
 * overran 5s outright on a loaded CI runner); `netstat` is far faster, but a
 * loaded runner is still slower than `lsof` on a desktop.
 */
export const PROCESS_SCAN_TIMEOUT_MS = process.platform === "win32" ? 30_000 : 10_000;

/**
 * Budget for looking up the name and command line of a Windows port holder.
 *
 * Shorter than the scan's own, because by then the pid is already known and the
 * lookup is only decoration: WMI can stall for longer than any budget worth
 * waiting on (CI saw it pass 30s while other PowerShell ran in a second), and
 * the pid alone is enough to offer.
 */
export const LISTENER_DETAILS_TIMEOUT_MS = 10_000;

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

  /**
   * Terminate a process we did NOT spawn, and wait for it to actually be gone.
   *
   * Same contract as `SpawnedProcess.kill` — SIGTERM → wait → SIGKILL → wait,
   * children included, `{success: false}` when it is still running — but keyed
   * by PID, because a blocking process discovered by a scan has no handle here.
   *
   * The waiting is the point. `taskkill` (and `process.kill`) return once the
   * request has been made, not once the target is down, so a caller that only
   * checks the kill command's exit status learns that it was *invoked*, not
   * that anything died. Acting on that — attempting a directory removal
   * immediately afterwards, say — races the teardown it just asked for.
   *
   * Caveat: process exit is observable, handle release is not. A `{success:
   * true}` here means the process is gone, not that the OS has finished
   * releasing what it held.
   *
   * @param pid - Process ID to terminate.
   * @param termTimeout - Wait after SIGTERM (ms). undefined = skip to SIGKILL.
   * @param killTimeout - Wait after SIGKILL (ms). undefined = return immediately.
   */
  kill(pid: number, termTimeout?: number, killTimeout?: number): Promise<KillResult>;

  /**
   * Processes holding a LISTEN socket on `port`.
   *
   * Process inspection keyed by a port, which is why it lives here rather than
   * on `PortManager`: the work is shelling out to `lsof` / `netstat`,
   * exactly like every other process scan in this codebase, and `PortManager`
   * would have to reach across into the process boundary to do it.
   *
   * Normally one entry — Node marks sockets close-on-exec, so a server's
   * children do not inherit its listener — but a list because `lsof` can
   * legitimately report several (fork-inherited descriptors, `SO_REUSEPORT`).
   *
   * Best-effort: returns an empty array when the scan fails, times out, or the
   * platform tool is missing. A caller must treat "nothing found" as "could not
   * tell", never as "the port is free".
   *
   * @param port - TCP port to look up on localhost.
   */
  findListeningProcesses(port: number): Promise<ListeningProcess[]>;

  /**
   * Every process on the machine, with parent, working directory, command
   * line, memory and CPU time — what the process monitor attributes to
   * workspaces.
   *
   * Linux reads /proc; macOS runs `ps` and `lsof -d cwd`; Windows runs the
   * bundled helper exe (`codehydra-procs.exe snapshot`), which reads each
   * process's PEB.
   *
   * Null when the scan failed or timed out — never an empty list, so a caller
   * cannot mistake a failed scan for a machine running nothing.
   */
  listProcesses(options?: ListProcessesOptions): Promise<ProcessSnapshot | null>;

  /**
   * The TCP ports each of `pids` listens on. A pid listening on nothing, or
   * one the OS would not tell about, is absent from the map.
   *
   * Scoped to the given pids because the per-process lookup is the expensive
   * half on Linux (each process's fds are read). Best-effort like
   * `findListeningProcesses`: an empty map when the scan failed.
   */
  findListeningPorts(pids: readonly number[]): Promise<ReadonlyMap<number, readonly number[]>>;
}

/**
 * Type alias for execa subprocess - using ReturnType to get the exact type.
 */
type ExecaSubprocess = ReturnType<typeof execa>;

/**
 * Every descendant of `pid` alive right now, found level by level with
 * `pgrep -P` (available wherever `pkill` is: procps on Linux, base macOS).
 *
 * Direct children are not enough. A shell command line is `sh` → the script →
 * whatever the script started, and a grandchild left running keeps the
 * inherited stdout/stderr pipes open, so the spawn it belongs to never
 * finishes even though its own process is gone.
 */
async function collectDescendants(pid: number): Promise<number[]> {
  const found: number[] = [];
  let frontier = [pid];
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const parent of frontier) {
      try {
        const { stdout } = await execa("pgrep", ["-P", String(parent)]);
        for (const token of stdout.split(/\s+/)) {
          const child = Number(token);
          if (Number.isInteger(child) && child > 0 && !found.includes(child)) next.push(child);
        }
      } catch {
        // pgrep exits non-zero when nothing matched - a leaf
      }
    }
    found.push(...next);
    frontier = next;
  }
  return found;
}

/**
 * Kill a process and its descendants using platform-appropriate method.
 * - Windows: taskkill /pid <pid> /t /f for native tree killing
 *   (Always uses /f because WM_CLOSE cannot signal console processes)
 * - Unix: signal every descendant (`collectDescendants`), then the process
 *
 * Works on any PID, not just one we spawned — the tree-kill mechanics are
 * identical either way, and `ProcessRunner.kill` needs them for foreign PIDs.
 *
 * @param pid - Process ID to kill
 * @param force - If true, use SIGKILL (Unix only). On Windows, always forceful.
 * @param tree - Descendants seen by an earlier call for the same kill (Unix).
 *   Pass the same set to the SIGTERM and the SIGKILL pass: a descendant whose
 *   parent died of the SIGTERM is re-parented and can no longer be found from
 *   `pid`, so the forced pass must remember it rather than look for it again.
 */
async function killProcessTree(
  pid: number,
  force: boolean,
  tree: Set<number> = new Set()
): Promise<void> {
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
    // Unix: kill descendants first, then the parent
    const signal = force ? "SIGKILL" : "SIGTERM";

    for (const descendant of await collectDescendants(pid)) tree.add(descendant);
    for (const descendant of tree) {
      try {
        process.kill(descendant, signal);
      } catch {
        // Already exited (ESRCH)
      }
    }

    // Kill the parent process
    try {
      process.kill(pid, signal);
    } catch {
      // Process may have already exited (ESRCH)
    }
  }
}

/** Interval between liveness probes while waiting for PIDs to exit. */
const PID_EXIT_POLL_INTERVAL_MS = 50;

/**
 * Whether a process with this PID currently exists.
 *
 * Signal 0 performs the permission and existence checks without delivering a
 * signal. ESRCH means gone; EPERM means it exists but belongs to someone else,
 * which for our purposes is still "alive".
 */
function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

/**
 * Wait for every one of `pids` to disappear, up to `timeout` ms.
 *
 * Polls rather than waiting on a handle: a foreign process, or a descendant of
 * one we spawned, has no child handle here to await. Returns true if all are gone.
 *
 * Note this observes process *exit*, which is not the same as the OS having
 * released the file handles it held — termination is asynchronous with respect
 * to teardown. It is still strictly better than the alternative of assuming a
 * kill landed because the kill *command* exited.
 */
async function waitForPidsExit(pids: Iterable<number>, timeout: number): Promise<boolean> {
  const deadline = Date.now() + timeout;
  let alive = [...pids];
  for (;;) {
    alive = alive.filter(pidExists);
    if (alive.length === 0) return true;
    if (Date.now() >= deadline) return false;
    const remaining = deadline - Date.now();
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(PID_EXIT_POLL_INTERVAL_MS, remaining))
    );
  }
}

/**
 * SpawnedProcess implementation wrapping an execa subprocess.
 */
class ExecaSpawnedProcess implements SpawnedProcess {
  private readonly subprocess: ExecaSubprocess;
  private readonly logger: Logger;
  /**
   * The only form of the command any log site may print. Computed once here so
   * that a redacted spawn cannot leak through a site that forgot to redact —
   * the raw command line is never stored on the instance.
   */
  readonly loggableCommand: string;
  /** True when the caller passed `redactBy` (see ProcessOptions.redactBy). */
  readonly redacted: boolean;
  private cachedResult: ProcessResult | null = null;
  private readonly streamingActive: boolean;
  /** Descendants met while killing, shared by the SIGTERM and SIGKILL passes. */
  private readonly killTree = new Set<number>();

  constructor(subprocess: ExecaSubprocess, logger: Logger, command: string, redactBy?: string) {
    this.subprocess = subprocess;
    this.logger = logger;
    this.redacted = redactBy !== undefined;
    this.loggableCommand = redactBy !== undefined ? `<${redactBy}>` : command;
    this.streamingActive = this.setupStreamLogging();
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
      this.logger.warn("Killed", { command: this.loggableCommand, pid, signal: "TASKKILL" });

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
    this.logger.info("Killed", { command: this.loggableCommand, pid, signal: "SIGTERM" });

    // 2. If termTimeout defined, wait for graceful exit
    if (termTimeout !== undefined && (await this.waitForTreeExit(termTimeout))) {
      return { success: true, reason: "SIGTERM" };
    }

    // 3. Send SIGKILL
    await this.killProcess(pid, true);
    this.logger.warn("Killed", { command: this.loggableCommand, pid, signal: "SIGKILL" });

    // 4. If killTimeout defined, wait for forced exit
    if (killTimeout !== undefined && (await this.waitForTreeExit(killTimeout))) {
      return { success: true, reason: "SIGKILL" };
    }

    // 5. Process may still be running
    return { success: false };
  }

  private async killProcess(pid: number, force: boolean): Promise<void> {
    return killProcessTree(pid, force, this.killTree);
  }

  /**
   * Whether the process and every descendant the kill signalled exit within
   * `timeout`. The process alone is not enough: a descendant that handles the
   * signal (an agent shutting down cleanly, say) can take far longer than its
   * parent, and returning without it lets it outlive whoever called kill() —
   * or never die at all, if its shutdown hangs.
   */
  private async waitForTreeExit(timeout: number): Promise<boolean> {
    const deadline = Date.now() + timeout;
    if ((await this.wait(timeout)).running) return false;
    return waitForPidsExit(this.killTree, Math.max(0, deadline - Date.now()));
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
    const raceResult = await raceTimeout(processPromise, timeout);

    if (raceResult === TIMED_OUT) {
      // Timeout occurred, process is still running
      this.logger.silly("Wait timeout", {
        command: this.loggableCommand,
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
   * Set up real-time streaming of stdout/stderr to the logger.
   * Returns true if streaming was activated (streams were available).
   */
  private setupStreamLogging(): boolean {
    const { stdout, stderr } = this.subprocess;

    if (!stdout && !stderr) {
      return false;
    }

    if (stdout) {
      this.attachStreamLogger(stdout as Readable, "stdout");
    }
    if (stderr) {
      this.attachStreamLogger(stderr as Readable, "stderr");
    }

    return true;
  }

  /**
   * Attach a line-buffered logger to a readable stream.
   * Logs complete lines as they arrive, flushes partial line on stream end.
   */
  private attachStreamLogger(stream: Readable, name: "stdout" | "stderr"): void {
    let buffer = "";

    stream.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      this.logLines(lines, name);
    });

    stream.on("end", () => {
      this.logLines([buffer], name);
    });
  }

  /**
   * Log the result of a completed process.
   */
  private logResult(result: ProcessResult): void {
    // Skip batch logging when streaming was active (already logged in real-time)
    if (!this.streamingActive) {
      this.logOutputLines(result.stdout, "stdout");
      this.logOutputLines(result.stderr, "stderr");
    }

    // Log exit status
    if (result.signal) {
      // Already logged in kill()
    } else {
      // Normal exit
      this.logger.debug("Exited", {
        command: this.loggableCommand,
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
    this.logLines(output.split("\n"), stream);
  }

  /**
   * Log non-empty lines, prefixed with the pid. The pid (rather than the
   * command) keeps the prefix short on chatty processes and correlates with
   * the "Spawned" record, the OS, and the process-cleanup modules; it is
   * reused by the OS over a long session, so resolve it against the nearest
   * preceding "Spawned" line.
   *
   * For a redacted spawn the line content itself may carry credentials (argv
   * redaction cannot reach a response body), so debug gets only a byte count
   * and the content is deferred to `silly`, which is opt-in. Both calls are
   * always made — the transport filters by level — so at `silly` a redacted
   * spawn shows the count line and the content line.
   *
   * Shared by the streaming logger and the batch (post-exit) logger.
   */
  private logLines(lines: string[], stream: "stdout" | "stderr"): void {
    const prefix = `[${this.pid ?? 0}]`;
    for (const line of lines) {
      if (line.trim() === "") continue;
      if (this.redacted) {
        this.logger.debug(`${prefix} ${stream}: ${Buffer.byteLength(line)} bytes`);
        this.logger.silly(`${prefix} ${stream}: ${line}`);
        continue;
      }
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
        command: this.loggableCommand,
        error: err.message,
      });
      return {
        stdout: "",
        stderr: err.message,
        exitCode: null,
        ...(typeof err.code === "string" && { spawnError: err.code }),
      };
    }
  }

  private convertResult(result: Awaited<ExecaSubprocess>): ProcessResult {
    // Cast to get access to 'failed', 'originalMessage' and 'code' properties
    const execaResult = result as typeof result & {
      failed?: boolean;
      originalMessage?: string;
      code?: string;
    };

    // For spawn errors (ENOENT, EACCES), execa sets failed=true and puts
    // error info in originalMessage instead of throwing (with reject: false)
    let stderr = typeof execaResult.stderr === "string" ? execaResult.stderr : "";
    if (execaResult.failed && execaResult.originalMessage && !stderr) {
      stderr = execaResult.originalMessage;
    }

    // A spawn failure never started the process, so it has no exit code: only
    // then is execa's `code` (the errno) a spawn error rather than, say, a
    // timeout's ETIMEDOUT.
    const exitCode = execaResult.exitCode ?? null;
    const spawnError =
      execaResult.failed && exitCode === null && !execaResult.signal ? execaResult.code : undefined;

    const processResult: ProcessResult = {
      stdout: typeof execaResult.stdout === "string" ? execaResult.stdout : "",
      stderr,
      exitCode,
      ...(spawnError !== undefined && { spawnError }),
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

// ============================================================================
// Listening-process scan
// ============================================================================

/**
 * Extract PIDs from `lsof -F p` output.
 *
 * `-F` prints one field per line, each prefixed by its type: `p` is a PID.
 * lsof reports no command line, only a command *name*, so callers pair this
 * with `ps` to get something the user can actually recognize.
 */
export function parseLsofPids(stdout: string): number[] {
  const pids: number[] = [];
  for (const line of stdout.split("\n")) {
    if (line[0] !== "p") continue;
    const pid = Number(line.slice(1));
    if (Number.isInteger(pid) && pid > 0 && !pids.includes(pid)) pids.push(pid);
  }
  return pids;
}

/**
 * Parse `ps -o pid=,comm=,args=` output into ListeningProcess entries.
 *
 * Fields are whitespace-separated with `args` running to end of line, so this
 * splits twice and keeps the remainder verbatim — a command line contains
 * spaces and must survive intact for the user to recognize it.
 */
export function parsePsOutput(stdout: string): ListeningProcess[] {
  const processes: ListeningProcess[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const match = /^(\d+)\s+(\S+)\s*(.*)$/.exec(trimmed);
    if (!match) continue;
    const [, rawPid, name, args] = match;
    const pid = Number(rawPid);
    if (!Number.isInteger(pid)) continue;
    processes.push({ pid, name: name!, commandLine: args!.trim() === "" ? name! : args!.trim() });
  }
  return processes;
}

/**
 * Parse `netstat -ano` output into the pids listening on `port`.
 *
 * A listening row is one whose foreign address is the unspecified one
 * (`0.0.0.0:0` / `[::]:0`) — matched on that rather than on the state column,
 * because netstat translates the state (`LISTENING` is `ABHÖREN` on a German
 * Windows). The pid is the last column. UDP rows have no state and are skipped
 * by the protocol, which netstat never translates.
 */
export function parseNetstatListeners(stdout: string, port: number): number[] {
  const pids: number[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5 || fields[0] !== "TCP") continue;
    const local = fields[1]!;
    const foreign = fields[2]!;
    if (!local.endsWith(`:${port}`)) continue;
    if (foreign !== "0.0.0.0:0" && foreign !== "[::]:0") continue;
    const pid = Number(fields[fields.length - 1]);
    // pid 0 is the System Idle Process, which is what a socket in TIME_WAIT
    // reports; it holds nothing anyone could terminate.
    if (Number.isInteger(pid) && pid > 0 && !pids.includes(pid)) pids.push(pid);
  }
  return pids;
}

/** Parse the JSON emitted by the Windows listener details query. */
export function parseWindowsListeners(stdout: string): ListeningProcess[] {
  const trimmed = stdout.trim();
  if (trimmed === "") return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }

  // ConvertTo-Json emits a bare object for a single result and an array for
  // several. Windows PowerShell 5.1 has no -AsArray to normalize that, so both
  // shapes have to be accepted — and one listener is the common case.
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const processes: ListeningProcess[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const pid = record["ProcessId"];
    if (typeof pid !== "number" || !Number.isInteger(pid)) continue;
    const name = typeof record["Name"] === "string" ? record["Name"] : "unknown";
    const commandLine = typeof record["CommandLine"] === "string" ? record["CommandLine"] : name;
    processes.push({ pid, name, commandLine });
  }
  return processes;
}

// ============================================================================
// Process snapshot parsers (listProcesses / findListeningPorts)
// ============================================================================

/** Last path segment of an executable, either separator. */
function executableName(path: string): string {
  const segment = path.split(/[\\/]/).pop() ?? path;
  return segment === "" ? path : segment;
}

/** The `btime` line of /proc/stat: boot time, epoch seconds → ms. */
export function parseLinuxBootTime(procStat: string): number | null {
  const match = /^btime\s+(\d+)$/m.exec(procStat);
  return match ? Number(match[1]) * 1000 : null;
}

/** What the Linux snapshot needs from the system besides /proc/<pid>. */
export interface LinuxProcContext {
  /** Epoch ms of boot (`btime`), null when /proc/stat had none. */
  readonly bootMs: number | null;
  /** Clock ticks per second (`getconf CLK_TCK`, nearly always 100). */
  readonly clockTicks: number;
  /** Bytes per page (`getconf PAGESIZE`). */
  readonly pageSize: number;
}

/**
 * One process from /proc/<pid>/stat plus its cmdline and cwd link.
 *
 * `comm` sits in parentheses and may itself contain spaces and parentheses,
 * so the fixed fields are read after the LAST `)`. Field numbers below are
 * proc(5)'s, counted from 1 with `pid` and `comm` first.
 */
export function parseLinuxProcess(
  stat: string,
  cmdline: string,
  cwd: string | null,
  context: LinuxProcContext,
  envValue: string | null = null
): ProcessSnapshotEntry | null {
  const open = stat.indexOf("(");
  const close = stat.lastIndexOf(")");
  if (open === -1 || close < open) return null;
  const pid = Number(stat.slice(0, open).trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const comm = stat.slice(open + 1, close);
  // After ")": field 3 (state) is index 0, so field N is index N - 3.
  const fields = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const field = (n: number): number => Number(fields[n - 3]);
  const ppid = field(4);
  const utime = field(14);
  const stime = field(15);
  const starttime = field(22);
  const rssPages = field(24);

  const argv = cmdline.split("\0").filter((arg) => arg !== "");
  const name = argv.length > 0 ? executableName(argv[0]!) : comm;
  return {
    pid,
    ppid: Number.isInteger(ppid) && ppid > 0 ? ppid : 0,
    name,
    commandLine: argv.length > 0 ? argv.join(" ") : comm,
    // A cwd removed from under the process reads as "<path> (deleted)".
    cwd: cwd === null ? null : cwd.replace(/ \(deleted\)$/, ""),
    rssBytes: Number.isFinite(rssPages) && rssPages > 0 ? rssPages * context.pageSize : 0,
    cpuTimeMs:
      Number.isFinite(utime) && Number.isFinite(stime)
        ? ((utime + stime) * 1000) / context.clockTicks
        : null,
    startedAt:
      context.bootMs !== null && Number.isFinite(starttime)
        ? Math.round(context.bootMs + (starttime * 1000) / context.clockTicks)
        : null,
    envValue,
  };
}

/** Field 22 of /proc/<pid>/stat (start time, in ticks since boot), raw; "" when malformed. */
export function linuxStartTicks(stat: string): string {
  const close = stat.lastIndexOf(")");
  if (close === -1) return "";
  return (
    stat
      .slice(close + 1)
      .trim()
      .split(/\s+/)[22 - 3] ?? ""
  );
}

/**
 * Listening TCP sockets in /proc/net/tcp or tcp6: socket inode → port.
 *
 * Each row is `sl local rem st … inode`; `local` is `<hex addr>:<hex port>`
 * and state `0A` is LISTEN.
 */
export function parseProcNetTcpListeners(text: string): Map<number, number> {
  const ports = new Map<number, number>();
  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10 || fields[3] !== "0A") continue;
    const local = fields[1]!;
    const port = parseInt(local.slice(local.lastIndexOf(":") + 1), 16);
    const inode = Number(fields[9]);
    if (Number.isInteger(port) && port > 0 && Number.isInteger(inode) && inode > 0) {
      ports.set(inode, port);
    }
  }
  return ports;
}

/** The inode of a `socket:[12345]` fd link, or null for anything else. */
export function socketInode(link: string): number | null {
  const match = /^socket:\[(\d+)\]$/.exec(link);
  return match ? Number(match[1]) : null;
}

/**
 * A `ps` time column — `time` (CPU) or `etime` (elapsed) — in ms.
 *
 * `[[dd-]hh:]mm:ss[.ff]`: macOS prints `time` as `m:ss.ff` and `etime` as
 * `[[dd-]hh:]mm:ss`. Null for anything else.
 */
export function parsePsDuration(value: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(value.trim());
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  const total =
    Number(days ?? 0) * 86_400 +
    Number(hours ?? 0) * 3_600 +
    Number(minutes) * 60 +
    Number(seconds);
  return Math.round(total * 1000);
}

/** Variable `name` in a NUL-separated `NAME=value` block (/proc/<pid>/environ); null when unset. */
export function parseEnviron(environ: string, name: string): string | null {
  const prefix = `${name}=`;
  for (const entry of environ.split("\0")) {
    if (entry.startsWith(prefix)) return entry.slice(prefix.length);
  }
  return null;
}

/**
 * `ps -A -ww -E -o pid=,command=` output: pid → the value of `name`.
 *
 * macOS prints the environment after the arguments, space-separated and
 * unquoted, so the format is ambiguous. The LAST `name=` wins (the arguments
 * come first and could contain the text too), and the value runs up to the
 * next ` OTHER_NAME=` or the end of the line — a value that itself contains
 * " X=" is cut there. Processes ps shows no environment for (another user's)
 * are absent.
 */
export function parsePsEnvironment(stdout: string, name: string): Map<number, string> {
  const values = new Map<number, string>();
  const marker = ` ${name}=`;
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s(.*)$/.exec(line);
    if (!match) continue;
    const rest = match[2]!;
    const at = rest.lastIndexOf(marker);
    if (at === -1) continue;
    const value = rest.slice(at + marker.length);
    const next = /\s[A-Za-z_][A-Za-z0-9_]*=/.exec(value);
    values.set(Number(match[1]), (next ? value.slice(0, next.index) : value).trimEnd());
  }
  return values;
}

/** `lsof -d cwd -Fpn` output: pid → working directory. */
export function parseLsofCwds(stdout: string): Map<number, string> {
  const cwds = new Map<number, string>();
  let pid: number | undefined;
  for (const line of stdout.split("\n")) {
    if (line[0] === "p") pid = Number(line.slice(1));
    else if (line[0] === "n" && pid !== undefined && Number.isInteger(pid)) {
      cwds.set(pid, line.slice(1));
    }
  }
  return cwds;
}

/**
 * `lsof -iTCP -sTCP:LISTEN -Fpn` output: pid → ports.
 *
 * An `n` line is the local address: `*:5173`, `127.0.0.1:5173`, `[::1]:5173`.
 */
export function parseLsofListenPorts(stdout: string): Map<number, number[]> {
  const ports = new Map<number, number[]>();
  let pid: number | undefined;
  for (const line of stdout.split("\n")) {
    if (line[0] === "p") {
      pid = Number(line.slice(1));
      continue;
    }
    if (line[0] !== "n" || pid === undefined || !Number.isInteger(pid)) continue;
    const port = Number(line.slice(line.lastIndexOf(":") + 1));
    if (!Number.isInteger(port) || port <= 0) continue;
    const list = ports.get(pid) ?? [];
    if (!list.includes(port)) list.push(port);
    ports.set(pid, list);
  }
  return ports;
}

/**
 * The macOS snapshot from three scans:
 * - `ps -A -o pid=,ppid=,rss=,time=,etime=,args=` (rss in KiB; args to end of line),
 * - `ps -A -o pid=,comm=` (the executable path, which may contain spaces),
 * - `lsof -d cwd -Fpn` (working directories).
 */
export function parseMacSnapshot(
  psOut: string,
  commOut: string,
  cwds: ReadonlyMap<number, string>,
  now: number,
  envValues: ReadonlyMap<number, string> = new Map()
): ProcessSnapshotEntry[] {
  const names = new Map<number, string>();
  for (const line of commOut.split("\n")) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (match) names.set(Number(match[1]), executableName(match[2]!.trim()));
  }
  const entries: ProcessSnapshotEntry[] = [];
  for (const line of psOut.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, rawPid, rawPpid, rawRss, time, etime, args] = match;
    const pid = Number(rawPid);
    const elapsed = parsePsDuration(etime!);
    const name = names.get(pid) ?? executableName(args!.split(" ")[0] ?? "unknown");
    entries.push({
      pid,
      ppid: Number(rawPpid),
      name,
      commandLine: args!.trim() === "" ? name : args!.trim(),
      cwd: cwds.get(pid) ?? null,
      rssBytes: Number(rawRss) * 1024,
      cpuTimeMs: parsePsDuration(time!),
      startedAt: elapsed === null ? null : now - elapsed,
      envValue: envValues.get(pid) ?? null,
    });
  }
  return entries;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** `codehydra-procs.exe snapshot` output; null when it is not the expected JSON. */
export function parseWindowsSnapshot(stdout: string): ProcessSnapshotEntry[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed["processes"])) return null;
  const entries: ProcessSnapshotEntry[] = [];
  for (const item of parsed["processes"] as unknown[]) {
    if (!isRecord(item)) continue;
    const pid = numberOrNull(item["pid"]);
    if (pid === null || pid <= 0) continue;
    const name = typeof item["name"] === "string" ? item["name"] : "unknown";
    const commandLine = typeof item["commandLine"] === "string" ? item["commandLine"] : "";
    entries.push({
      pid,
      ppid: numberOrNull(item["ppid"]) ?? 0,
      name,
      commandLine: commandLine === "" ? name : commandLine,
      cwd: typeof item["cwd"] === "string" && item["cwd"] !== "" ? item["cwd"] : null,
      rssBytes: numberOrNull(item["rssBytes"]) ?? 0,
      cpuTimeMs: numberOrNull(item["cpuTimeMs"]),
      startedAt: numberOrNull(item["startedAt"]),
      envValue: typeof item["env"] === "string" ? item["env"] : null,
    });
  }
  return entries;
}

/** `codehydra-procs.exe listeners` output: pid → ports. */
export function parseWindowsListenPorts(stdout: string): Map<number, number[]> {
  const ports = new Map<number, number[]>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return ports;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed["listeners"])) return ports;
  for (const item of parsed["listeners"] as unknown[]) {
    if (!isRecord(item)) continue;
    const pid = numberOrNull(item["pid"]);
    const port = numberOrNull(item["port"]);
    if (pid === null || port === null || pid <= 0 || port <= 0) continue;
    const list = ports.get(pid) ?? [];
    if (!list.includes(port)) list.push(port);
    ports.set(pid, list);
  }
  return ports;
}

/**
 * PowerShell that looks up the name and command line of the given processes.
 *
 * Win32_Process is the only place Windows reports another process's command
 * line. SilentlyContinue so that a pid which exited meanwhile is just absent.
 *
 * Sent via `-EncodedCommand`, so quoting is a non-issue — but it still has to
 * be **Windows PowerShell 5.1**: `powershell.exe` is 5.1, not pwsh, so
 * `ConvertTo-Json -AsArray` (6+) is unavailable and would fail the whole
 * command. Without it a single result serializes as a bare object, which
 * `parseWindowsListeners` accepts.
 */
function windowsListenerDetailsQuery(pids: readonly number[]): string {
  const filter = pids.map((pid) => `ProcessId=${pid}`).join(" OR ");
  return (
    `$ErrorActionPreference='SilentlyContinue'; ` +
    `Get-CimInstance Win32_Process -Filter '${filter}' | ` +
    `Select-Object ProcessId, Name, CommandLine | ConvertTo-Json -Compress`
  );
}

export interface ExecaProcessRunnerOptions {
  /**
   * The bundled Windows process helper (`codehydra-procs.exe`). Without it,
   * `listProcesses` and `findListeningPorts` find nothing on Windows.
   */
  readonly windowsProcessHelper?: string;
}

export class ExecaProcessRunner implements ProcessRunner {
  /** `getconf` answers, read once: they do not change while we run. */
  private linuxConstants: Promise<{ clockTicks: number; pageSize: number }> | undefined;
  /**
   * What the last Linux scan read that never changes after exec — command
   * line and the asked-about environment variable — by `pid:starttime:var`.
   */
  private linuxFixed = new Map<string, { cmdline: string; envValue: string | null }>();

  constructor(
    private readonly logger: Logger,
    private readonly options: ExecaProcessRunnerOptions = {}
  ) {}

  run(command: string, args: readonly string[], options?: ProcessOptions): SpawnedProcess {
    const subprocess = execa(command, [...args], {
      cleanup: true,
      encoding: "utf8",
      reject: false, // Don't throw on non-zero exit - check exitCode instead
      ...(options?.shell && { shell: true }),
      ...(options?.cwd && { cwd: options.cwd }),
      // When custom env is provided, disable extendEnv so that deleted keys
      // from the custom env are actually removed (not inherited from process.env)
      ...(options?.env && { env: options.env, extendEnv: false }),
      ...(options?.input !== undefined && { input: options.input }),
    }) as ExecaSubprocess;

    const spawned = new ExecaSpawnedProcess(subprocess, this.logger, command, options?.redactBy);

    // Check if spawn failed (no PID)
    if (spawned.pid === undefined) {
      // Log spawn failure when wait() is called (to get stderr with error message)
      // Don't log here - will be logged in wait()
    } else {
      // Log successful spawn.
      //
      // `spawnfile`/`spawnargs` are what CreateProcess/execve actually received, after any
      // shell transformation. On Windows a `.cmd` goes through cmd.exe, and how its
      // arguments end up quoted decides whether a batch script can parse them at all —
      // VSCodium's codium-server.cmd dies on a quoted first argument.
      //
      // A redacted spawn logs its replacement identity and nothing else: `args`
      // and `spawnargs` are both derived from the real command line, and
      // `spawnargs` in particular re-embeds it (`["/bin/sh", "-c", <line>]`).
      const child = subprocess as unknown as { spawnfile?: string; spawnargs?: string[] };
      this.logger.debug("Spawned", {
        // Same computed value the handle's own log sites use, so the two can
        // never disagree about what is safe to print.
        command: spawned.loggableCommand,
        pid: spawned.pid,
        ...(!spawned.redacted && {
          args: args.join(" "),
          ...(child.spawnfile !== undefined && { spawnfile: child.spawnfile }),
          ...(child.spawnargs !== undefined && { spawnargs: JSON.stringify(child.spawnargs) }),
        }),
      });
    }

    return spawned;
  }

  async kill(pid: number, termTimeout?: number, killTimeout?: number): Promise<KillResult> {
    // Already gone: nothing to do, and reporting success keeps callers from
    // treating a race (it exited between the scan and the kill) as a failure.
    if (!pidExists(pid)) {
      return { success: true, reason: "SIGTERM" };
    }

    if (isWindows) {
      // Windows has no graceful phase for console processes — see killProcessTree.
      await killProcessTree(pid, true);
      this.logger.warn("Killed foreign process", { pid, signal: "TASKKILL" });

      const timeout = (termTimeout ?? 0) + (killTimeout ?? 0);
      if (timeout > 0 && (await waitForPidsExit([pid], timeout))) {
        return { success: true, reason: "SIGKILL" };
      }
      if (timeout === 0) return { success: false };

      this.logger.warn("Foreign process survived termination", { pid, timeout });
      return { success: false };
    }

    const tree = new Set<number>();
    await killProcessTree(pid, false, tree);
    this.logger.info("Killed foreign process", { pid, signal: "SIGTERM" });
    // The whole tree, not just `pid` — see ExecaSpawnedProcess.waitForTreeExit.
    if (termTimeout !== undefined && (await waitForPidsExit([pid, ...tree], termTimeout))) {
      return { success: true, reason: "SIGTERM" };
    }

    await killProcessTree(pid, true, tree);
    this.logger.warn("Killed foreign process", { pid, signal: "SIGKILL" });
    if (killTimeout !== undefined && (await waitForPidsExit([pid, ...tree], killTimeout))) {
      return { success: true, reason: "SIGKILL" };
    }

    if (killTimeout !== undefined) {
      this.logger.warn("Foreign process survived termination", { pid, timeout: killTimeout });
    }
    return { success: false };
  }

  async findListeningProcesses(port: number): Promise<ListeningProcess[]> {
    try {
      const processes =
        process.platform === "win32"
          ? await this.findListenersWindows(port)
          : await this.findListenersPosix(port);
      this.logger.debug("Scanned port for listeners", { port, count: processes.length });
      return processes;
    } catch (error) {
      // Best-effort by contract: a caller must not read "none found" as "port
      // free", so a failed scan is indistinguishable from an empty one.
      this.logger.warn("Port listener scan failed", {
        port,
        error: getErrorMessage(error),
      });
      return [];
    }
  }

  async listProcesses(options?: ListProcessesOptions): Promise<ProcessSnapshot | null> {
    const envVar = options?.envVar;
    try {
      const processes =
        process.platform === "win32"
          ? await this.listProcessesWindows(envVar)
          : process.platform === "darwin"
            ? await this.listProcessesMac(envVar)
            : await this.listProcessesLinux(envVar);
      if (processes === null) return null;
      return { takenAt: Date.now(), processes };
    } catch (error) {
      this.logger.warn("Process snapshot failed", { error: getErrorMessage(error) });
      return null;
    }
  }

  async findListeningPorts(
    pids: readonly number[]
  ): Promise<ReadonlyMap<number, readonly number[]>> {
    if (pids.length === 0) return new Map();
    try {
      if (process.platform === "win32") {
        const helper = this.options.windowsProcessHelper;
        if (helper === undefined) return new Map();
        const all = parseWindowsListenPorts(await this.scan(helper, ["listeners"]));
        const wanted = new Set(pids);
        return new Map([...all].filter(([pid]) => wanted.has(pid)));
      }
      if (process.platform === "darwin") {
        // -a ANDs -p with -i; without it lsof ORs them and lists every socket.
        // Nothing listening is the common case, and lsof then prints nothing.
        return parseLsofListenPorts(
          await this.scan(
            "lsof",
            ["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-p", pids.join(","), "-Fpn"],
            PROCESS_SCAN_TIMEOUT_MS,
            true
          )
        );
      }
      return await this.findListeningPortsLinux(pids);
    } catch (error) {
      this.logger.warn("Listening port scan failed", { error: getErrorMessage(error) });
      return new Map();
    }
  }

  private async listProcessesLinux(envVar: string | undefined): Promise<ProcessSnapshotEntry[]> {
    const [names, procStat, constants] = await Promise.all([
      readdir("/proc"),
      readFile("/proc/stat", "utf8"),
      this.getLinuxConstants(),
    ]);
    const context: LinuxProcContext = { ...constants, bootMs: parseLinuxBootTime(procStat) };
    const fixed = new Map<string, { cmdline: string; envValue: string | null }>();
    const entries = await Promise.all(
      names
        .filter((name) => /^\d+$/.test(name))
        .map(async (pid): Promise<ProcessSnapshotEntry | null> => {
          try {
            const [stat, cwd] = await Promise.all([
              readFile(`/proc/${pid}/stat`, "utf8"),
              // EACCES for another user's process: listed, without a cwd.
              readlink(`/proc/${pid}/cwd`).catch(() => null),
            ]);
            // The command line and /proc/<pid>/environ are fixed once the
            // process has exec'd, so they are read once per process (pid +
            // start time), not every scan: far fewer reads on a poll that runs
            // every few seconds.
            const key = `${pid}:${linuxStartTicks(stat)}:${envVar ?? ""}`;
            const known = this.linuxFixed.get(key);
            const read = known ?? {
              cmdline: await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => ""),
              envValue:
                envVar === undefined
                  ? null
                  : parseEnviron(
                      // EACCES for another user's process.
                      await readFile(`/proc/${pid}/environ`, "utf8").catch(() => ""),
                      envVar
                    ),
            };
            fixed.set(key, read);
            return parseLinuxProcess(stat, read.cmdline, cwd, context, read.envValue);
          } catch {
            // It exited between readdir and the read.
            return null;
          }
        })
    );
    // Only the processes still alive: the cache never outgrows the machine.
    this.linuxFixed = fixed;
    return entries.filter((entry): entry is ProcessSnapshotEntry => entry !== null);
  }

  private getLinuxConstants(): Promise<{ clockTicks: number; pageSize: number }> {
    this.linuxConstants ??= (async () => {
      const read = async (name: string, fallback: number): Promise<number> => {
        const value = Number((await this.scan("getconf", [name])).trim());
        return Number.isInteger(value) && value > 0 ? value : fallback;
      };
      const [clockTicks, pageSize] = await Promise.all([
        read("CLK_TCK", 100),
        read("PAGESIZE", 4096),
      ]);
      return { clockTicks, pageSize };
    })();
    return this.linuxConstants;
  }

  private async findListeningPortsLinux(pids: readonly number[]): Promise<Map<number, number[]>> {
    const tables = await Promise.all(
      ["/proc/net/tcp", "/proc/net/tcp6"].map((file) => readFile(file, "utf8").catch(() => ""))
    );
    const listening = new Map<number, number>();
    for (const table of tables) {
      for (const [inode, port] of parseProcNetTcpListeners(table)) listening.set(inode, port);
    }
    const result = new Map<number, number[]>();
    if (listening.size === 0) return result;
    await Promise.all(
      pids.map(async (pid) => {
        let fds: string[];
        try {
          fds = await readdir(`/proc/${pid}/fd`);
        } catch {
          return; // gone, or another user's
        }
        const ports: number[] = [];
        await Promise.all(
          fds.map(async (fd) => {
            const inode = socketInode(await readlink(`/proc/${pid}/fd/${fd}`).catch(() => ""));
            const port = inode === null ? undefined : listening.get(inode);
            if (port !== undefined && !ports.includes(port)) ports.push(port);
          })
        );
        if (ports.length > 0)
          result.set(
            pid,
            ports.sort((a, b) => a - b)
          );
      })
    );
    return result;
  }

  private async listProcessesMac(
    envVar: string | undefined
  ): Promise<ProcessSnapshotEntry[] | null> {
    const [psOut, commOut, cwdOut, envOut] = await Promise.all([
      this.scan("ps", ["-A", "-o", "pid=,ppid=,rss=,time=,etime=,args="]),
      this.scan("ps", ["-A", "-o", "pid=,comm="]),
      // -w: no warnings about filesystems lsof cannot stat.
      this.scan("lsof", ["-w", "-d", "cwd", "-Fpn"]),
      // -E appends each process's (start-up) environment; -ww: untruncated.
      envVar === undefined
        ? Promise.resolve("")
        : this.scan("ps", ["-A", "-ww", "-E", "-o", "pid=,command="]),
    ]);
    if (psOut.trim() === "") return null;
    return parseMacSnapshot(
      psOut,
      commOut,
      parseLsofCwds(cwdOut),
      Date.now(),
      envVar === undefined ? new Map() : parsePsEnvironment(envOut, envVar)
    );
  }

  private async listProcessesWindows(
    envVar: string | undefined
  ): Promise<ProcessSnapshotEntry[] | null> {
    const helper = this.options.windowsProcessHelper;
    if (helper === undefined) {
      this.logger.warn("Process snapshot unavailable: no Windows process helper configured");
      return null;
    }
    const entries = parseWindowsSnapshot(
      await this.scan(helper, envVar === undefined ? ["snapshot"] : ["snapshot", envVar])
    );
    if (entries === null) this.logger.warn("Process snapshot output did not parse");
    return entries;
  }

  /** Run a scan command, returning its stdout or "" if it failed or hung. */
  private async scan(
    command: string,
    args: readonly string[],
    timeout = PROCESS_SCAN_TIMEOUT_MS,
    emptyIsNormal = false
  ): Promise<string> {
    const proc = this.run(command, args);
    const result = await proc.wait(timeout);
    if (result.running) {
      await proc.kill(1000, 1000);
      this.logger.warn("Process scan timed out", { command });
      return "";
    }
    // A scan that produces nothing is indistinguishable from a free port at the
    // call site, so say why here — a broken platform query is otherwise silent.
    if (result.stdout.trim() === "" && !emptyIsNormal) {
      this.logger.warn("Process scan produced no output", {
        command,
        exitCode: result.exitCode ?? -1,
        stderr: result.stderr.slice(0, 500),
      });
    }
    return result.stdout;
  }

  private async findListenersPosix(port: number): Promise<ListeningProcess[]> {
    // -n/-P: no DNS or port-name lookups, which are slow and can hang.
    // Exit code 1 means "nothing found", which parses to an empty list anyway.
    const pids = parseLsofPids(
      await this.scan("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"])
    );
    if (pids.length === 0) return [];

    // lsof knows the command name but never the full command line; ps does.
    const details = parsePsOutput(
      await this.scan("ps", ["-o", "pid=,comm=,args=", "-p", pids.join(",")])
    );
    if (details.length > 0) return details;

    // ps failed but we still know who holds the port — better to offer the pid
    // than to pretend the scan found nothing.
    return pids.map((pid) => ({ pid, name: "unknown", commandLine: "unknown" }));
  }

  private async findListenersWindows(port: number): Promise<ListeningProcess[]> {
    // netstat, not Get-NetTCPConnection: that cmdlet goes through WMI, which on
    // a loaded machine can stall past any budget — and a timed-out scan leaves
    // the caller unable to name the holder of a port it knows is busy. netstat
    // reads the TCP table directly and answers in well under a second.
    const pids = parseNetstatListeners(await this.scan("netstat", ["-ano"]), port);
    if (pids.length === 0) return [];

    // -EncodedCommand, not -Command: the script travels as base64 of UTF-16LE,
    // so nothing in it is subject to Windows command-line parsing. An inline
    // -Command has to survive Node's argv escaping *and* PowerShell's own
    // tokenizing, which is a standing source of silent breakage — a mangled
    // script just produces no output.
    const encoded = Buffer.from(windowsListenerDetailsQuery(pids), "utf16le").toString("base64");
    const details = parseWindowsListeners(
      await this.scan(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
        LISTENER_DETAILS_TIMEOUT_MS
      )
    );
    if (details.length > 0) return details;

    // WMI failed or stalled but we still know who holds the port — better to
    // offer the pid than to pretend the scan found nothing.
    return pids.map((pid) => ({ pid, name: "unknown", commandLine: "unknown" }));
  }
}
