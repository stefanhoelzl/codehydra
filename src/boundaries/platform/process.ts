/**
 * Process spawning utilities.
 */

import type { Readable } from "node:stream";
import { execa } from "execa";
import type { Logger } from "./logging";

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

/** How long an OS-level process scan may take before it is abandoned. */
export const PROCESS_SCAN_TIMEOUT_MS = 5000;

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
   * on `PortManager`: the work is shelling out to `lsof` / `Get-NetTCPConnection`,
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
 * Kill a process and its children using platform-appropriate method.
 * - Windows: taskkill /pid <pid> /t /f for native tree killing
 *   (Always uses /f because WM_CLOSE cannot signal console processes)
 * - Unix: pkill -P to kill children, then process.kill for parent
 *
 * Works on any PID, not just one we spawned — the tree-kill mechanics are
 * identical either way, and `ProcessRunner.kill` needs them for foreign PIDs.
 *
 * @param pid - Process ID to kill
 * @param force - If true, use SIGKILL (Unix only). On Windows, always forceful.
 */
async function killProcessTree(pid: number, force: boolean): Promise<void> {
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

    // Kill all child processes by parent PID.
    // The signal must come first: BSD pkill (macOS) only accepts a signal as
    // its first argument and rejects it anywhere else as an invalid option.
    try {
      await execa("pkill", [force ? "-9" : "-15", "-P", String(pid)]);
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

/** Interval between liveness probes while waiting for a foreign PID to exit. */
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
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Wait for a foreign PID to disappear, up to `timeout` ms.
 *
 * Polls rather than waiting on a handle: we did not spawn this process, so
 * there is no child handle to await. Returns true if it is gone.
 *
 * Note this observes process *exit*, which is not the same as the OS having
 * released the file handles it held — termination is asynchronous with respect
 * to teardown. It is still strictly better than the alternative of assuming a
 * kill landed because the kill *command* exited.
 */
async function waitForPidExit(pid: number, timeout: number): Promise<boolean> {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (!pidExists(pid)) return true;
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
    if (termTimeout !== undefined) {
      const result = await this.wait(termTimeout);
      if (!result.running) {
        return { success: true, reason: "SIGTERM" };
      }
    }

    // 3. Send SIGKILL
    await this.killProcess(pid, true);
    this.logger.warn("Killed", { command: this.loggableCommand, pid, signal: "SIGKILL" });

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

  private async killProcess(pid: number, force: boolean): Promise<void> {
    return killProcessTree(pid, force);
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

/** Parse the JSON emitted by the Windows listener query. */
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

/**
 * PowerShell that maps a listening port to the processes behind it.
 *
 * `Get-NetTCPConnection` reports only an OwningProcess id, so it is joined to
 * Win32_Process for the name and command line. SilentlyContinue because "no
 * listener" is an error there, not an empty result.
 *
 * Two constraints shape how this is written, both learned the hard way:
 *
 * - **No double quotes anywhere.** This is passed as a single `-Command`
 *   argument, and Node escapes an embedded `"` as `\"`, which the Windows
 *   command line does not put back together — the same hazard `ProcessOptions.shell`
 *   documents for `cmd /c`. Hence `('ProcessId=' + $_)` rather than
 *   `"ProcessId=$_"`.
 * - **Windows PowerShell 5.1 only.** `powershell.exe` is 5.1, not pwsh, so
 *   `ConvertTo-Json -AsArray` (6+) is unavailable and would fail the whole
 *   command. Without it a single result serializes as a bare object, which
 *   `parseWindowsListeners` accepts.
 */
function windowsListenerQuery(port: number): string {
  return (
    `$ErrorActionPreference='SilentlyContinue'; ` +
    `$p = Get-NetTCPConnection -LocalPort ${port} -State Listen | ` +
    `Select-Object -ExpandProperty OwningProcess -Unique; ` +
    `if (-not $p) { exit 0 }; ` +
    `$p | ForEach-Object { Get-CimInstance Win32_Process -Filter ('ProcessId=' + $_) } | ` +
    `Select-Object ProcessId, Name, CommandLine | ConvertTo-Json -Compress`
  );
}

export class ExecaProcessRunner implements ProcessRunner {
  constructor(private readonly logger: Logger) {}

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
      if (timeout > 0 && (await waitForPidExit(pid, timeout))) {
        return { success: true, reason: "SIGKILL" };
      }
      if (timeout === 0) return { success: false };

      this.logger.warn("Foreign process survived termination", { pid, timeout });
      return { success: false };
    }

    await killProcessTree(pid, false);
    this.logger.info("Killed foreign process", { pid, signal: "SIGTERM" });
    if (termTimeout !== undefined && (await waitForPidExit(pid, termTimeout))) {
      return { success: true, reason: "SIGTERM" };
    }

    await killProcessTree(pid, true);
    this.logger.warn("Killed foreign process", { pid, signal: "SIGKILL" });
    if (killTimeout !== undefined && (await waitForPidExit(pid, killTimeout))) {
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
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /** Run a scan command, returning its stdout or "" if it failed or hung. */
  private async scan(command: string, args: readonly string[]): Promise<string> {
    const proc = this.run(command, args);
    const result = await proc.wait(PROCESS_SCAN_TIMEOUT_MS);
    if (result.running) {
      await proc.kill(1000, 1000);
      this.logger.warn("Port listener scan timed out", { command });
      return "";
    }
    // A scan that produces nothing is indistinguishable from a free port at the
    // call site, so say why here — a broken platform query is otherwise silent.
    if (result.stdout.trim() === "") {
      this.logger.debug("Port listener scan produced no output", {
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
    return parseWindowsListeners(
      await this.scan("powershell", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        windowsListenerQuery(port),
      ])
    );
  }
}
