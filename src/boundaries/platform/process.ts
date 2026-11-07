/**
 * Process spawning utilities.
 */

import { constants as osConstants, setPriority } from "node:os";
import type { Readable } from "node:stream";
import { execa } from "execa";
import type { Logger } from "./logging";
import type { NativeAddon } from "./native-addon";
import { Path } from "../../utils/path/path";
import { raceTimeout, TIMED_OUT } from "../../utils/timeout";
import { errorCode, getErrorMessage } from "../../shared/error-utils";

/**
 * Platform detection: Windows has no graceful kill (see killProcessTree).
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
  /** Who the holder is and where it came from; for logs, not for decisions. */
  readonly origin?: ListeningProcessOrigin;
}

/** Where a port holder came from. A field is null when the OS would not say. */
export interface ListeningProcessOrigin {
  /** Its session. On Windows that is the logon: another logged-in account has another one. */
  readonly sessionId: number | null;
  /** Whether that is this app's session. */
  readonly sameSession: boolean | null;
  /** False when the OS gave neither command line nor cwd: another user's, or protected. */
  readonly detailsReadable: boolean;
  readonly cwd: string | null;
  /** ISO timestamp; tells a server left from an earlier session from a new one. */
  readonly startedAt: string | null;
  readonly parentPid: number | null;
  /** Null also when the parent is gone, which is what an orphan looks like. */
  readonly parentName: string | null;
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
  /** Its session id; null or absent when unreadable. See {@link ListeningProcessOrigin.sessionId}. */
  readonly sessionId?: number | null;
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
 * How long an OS-level scan may take before it is abandoned.
 *
 * A ceiling, not a delay: a scan that answers fast is unaffected by it, and one
 * that times out is indistinguishable from a free port at the call site — so a
 * budget that is too tight silently disables the whole feature. The native
 * addon answers in milliseconds; the ceiling is for a machine so loaded that
 * the thread pool itself is starved.
 */
export const PROCESS_SCAN_TIMEOUT_MS = 10_000;

/**
 * A process holding a directory (`ProcessRunner.findDirectoryHolders`).
 *
 * The same shape as the deletion dialog's `BlockingProcess`, declared here
 * because a boundary must not depend on the intents layer.
 */
export interface DirectoryHolder {
  readonly pid: number;
  readonly name: string;
  /** Full command line, or the bare name when the OS did not report one. */
  readonly commandLine: string;
  /** Files it holds open in the directory, relative to it (at most 20; Windows only). */
  readonly files: readonly string[];
  /** Its working directory relative to the directory ("." for the directory itself); null if outside. */
  readonly cwd: string | null;
}

/** What `findDirectoryHolders` looks for. */
export interface FindDirectoryHoldersOptions {
  /**
   * Also processes holding files open in the directory, with those files
   * (Restart Manager and the handle table; Windows only, ignored elsewhere).
   * Without it only working directories are matched.
   */
  readonly files?: boolean;
  /** Budget for the whole scan; default `PROCESS_SCAN_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

/**
 * Outcome of `findDirectoryHolders`. `timedOut` keeps "nothing found" apart
 * from "never found out": an empty list alone would report a clean bill of
 * health on a scan that gave up.
 */
export interface DirectoryHolderScan {
  readonly holders: readonly DirectoryHolder[];
  readonly timedOut: boolean;
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
   * on `PortManager`: the work is the socket table and the process list, like
   * every other process scan in this codebase (the native addon), and
   * `PortManager` would have to reach across into the process boundary to do it.
   *
   * Normally one entry — Node marks sockets close-on-exec, so a server's
   * children do not inherit its listener — but a list because the socket table
   * can legitimately name several (fork-inherited descriptors, `SO_REUSEPORT`).
   *
   * Best-effort: returns an empty array when the scan fails or times out. A
   * caller must treat "nothing found" as "could not tell", never as "the port
   * is free". Sockets of processes the OS will not describe to us (another
   * user's on macOS) are not found.
   *
   * @param port - TCP port to look up on localhost.
   */
  findListeningProcesses(port: number): Promise<ListeningProcess[]>;

  /**
   * Every process on the machine, with parent, working directory, command
   * line, memory and CPU time — what the process monitor attributes to
   * workspaces.
   *
   * Read in process by the native addon (sysinfo), without spawning anything.
   * Other users' processes may come back with little more than a name: macOS
   * withholds their details from a non-root caller, and Windows its protected
   * processes' command lines.
   *
   * Null when the scan failed or timed out — never an empty list, so a caller
   * cannot mistake a failed scan for a machine running nothing.
   */
  listProcesses(options?: ListProcessesOptions): Promise<ProcessSnapshot | null>;

  /**
   * The TCP ports each of `pids` listens on, ascending. A pid listening on
   * nothing, or one the OS would not tell about, is absent from the map.
   * Best-effort like `findListeningProcesses`: an empty map when the scan failed.
   */
  findListeningPorts(pids: readonly number[]): Promise<ReadonlyMap<number, readonly number[]>>;

  /**
   * The processes holding directory `dir`: those whose working directory is
   * in it and, with `files` on Windows, those holding files open in it — what
   * keeps a workspace from being removed. Never this process.
   *
   * Throws when the scan cannot run at all; a scan that ran out of time
   * resolves with `timedOut`.
   */
  findDirectoryHolders(
    dir: string,
    options?: FindDirectoryHoldersOptions
  ): Promise<DirectoryHolderScan>;

  /**
   * Raise `pid` to above-normal scheduling priority (Windows
   * `ABOVE_NORMAL_PRIORITY_CLASS`), so it is scheduled ahead of everything at
   * normal priority.
   *
   * Windows only: raising a priority needs privileges on Linux and macOS, so
   * there nothing is changed. Windows does not pass it on — a process the
   * raised one starts afterwards runs at normal priority.
   *
   * @returns Whether the priority was raised: false off Windows, or when the
   *   OS refused (the process exited, or is not ours to change).
   */
  increasePriority(pid: number): boolean;
}

/**
 * Type alias for execa subprocess - using ReturnType to get the exact type.
 */
type ExecaSubprocess = ReturnType<typeof execa>;

/** The descendants of a pid alive right now (from a process snapshot). */
type DescendantLookup = (pid: number) => Promise<readonly number[]>;

/**
 * Every descendant of `pid` in `processes`, following parent links level by
 * level. A "child" that started before its parent is not one: its parent pid
 * belonged to a process that exited, and the number was reused since.
 *
 * Direct children are not enough. A shell command line is `sh` → the script →
 * whatever the script started, and a grandchild left running keeps the
 * inherited stdout/stderr pipes open, so the spawn it belongs to never
 * finishes even though its own process is gone.
 */
export function descendantsIn(processes: readonly ProcessSnapshotEntry[], pid: number): number[] {
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
  const children = new Map<number, ProcessSnapshotEntry[]>();
  for (const entry of processes) {
    if (entry.ppid <= 0 || entry.ppid === entry.pid) continue;
    const siblings = children.get(entry.ppid) ?? [];
    siblings.push(entry);
    children.set(entry.ppid, siblings);
  }
  const seen = new Set([pid]);
  const found: number[] = [];
  let frontier = [pid];
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const parent of frontier) {
      const parentStart = byPid.get(parent)?.startedAt ?? null;
      for (const child of children.get(parent) ?? []) {
        if (seen.has(child.pid)) continue;
        if (parentStart !== null && child.startedAt !== null && child.startedAt < parentStart) {
          continue;
        }
        seen.add(child.pid);
        found.push(child.pid);
        next.push(child.pid);
      }
    }
    frontier = next;
  }
  return found;
}

/**
 * Kill a process and its descendants: signal every descendant (`descendants`,
 * from the process list), then the process itself.
 *
 * On Windows every signal is `TerminateProcess` — the forceful kill
 * `taskkill /t /f` did, and the only one that works: WM_CLOSE is ignored by
 * console applications, and CTRL_C_EVENT cannot reach a detached process.
 *
 * Works on any PID, not just one we spawned — the tree-kill mechanics are
 * identical either way, and `ProcessRunner.kill` needs them for foreign PIDs.
 *
 * @param pid - Process ID to kill
 * @param force - If true, SIGKILL; else SIGTERM. Windows: both terminate.
 * @param tree - Descendants seen by an earlier call for the same kill.
 *   Pass the same set to the SIGTERM and the SIGKILL pass: a descendant whose
 *   parent died of the SIGTERM is re-parented and can no longer be found from
 *   `pid`, so the forced pass must remember it rather than look for it again.
 * @param descendants - How to find them; omitted, only `pid` is signalled.
 */
async function killProcessTree(
  pid: number,
  force: boolean,
  logger: Logger,
  tree: Set<number> = new Set(),
  descendants?: DescendantLookup
): Promise<void> {
  const signal = force ? "SIGKILL" : "SIGTERM";
  // Descendants first: once the parent is gone, they are re-parented and
  // can no longer be found from it.
  for (const descendant of (await descendants?.(pid)) ?? []) tree.add(descendant);
  for (const descendant of tree) signalProcess(descendant, signal, logger);
  signalProcess(pid, signal, logger);
}

/**
 * Signal a process that may have exited already (ESRCH). Any other refusal is
 * logged: EPERM is what another user's process answers, and the caller only
 * sees that the process is still alive afterwards.
 */
function signalProcess(pid: number, signal: NodeJS.Signals, logger: Logger): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    const code = errorCode(error);
    if (code !== "ESRCH") logger.warn("Kill refused", { pid, signal, code: code ?? "unknown" });
  }
}

/** Where a listener came from, read from the snapshot it was found in. */
function listeningProcessOrigin(
  entry: ProcessSnapshotEntry,
  processes: readonly ProcessSnapshotEntry[]
): ListeningProcessOrigin {
  const sessionId = entry.sessionId ?? null;
  const ownSessionId = processes.find((p) => p.pid === process.pid)?.sessionId ?? null;
  return {
    sessionId,
    sameSession: sessionId === null || ownSessionId === null ? null : sessionId === ownSessionId,
    detailsReadable: entry.cwd !== null || entry.commandLine !== entry.name,
    cwd: entry.cwd,
    startedAt: entry.startedAt === null ? null : new Date(entry.startedAt).toISOString(),
    parentPid: entry.ppid === 0 ? null : entry.ppid,
    parentName: processes.find((p) => p.pid === entry.ppid)?.name ?? null,
  };
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
  private readonly descendants: DescendantLookup;

  constructor(
    subprocess: ExecaSubprocess,
    logger: Logger,
    command: string,
    descendants: DescendantLookup,
    redactBy?: string
  ) {
    this.subprocess = subprocess;
    this.logger = logger;
    this.descendants = descendants;
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
      // Windows: only a forceful kill works (TerminateProcess — see
      // killProcessTree), so there is no graceful phase to wait out.
      await this.killProcess(pid, true);
      this.logger.warn("Killed", { command: this.loggableCommand, pid, signal: "TERMINATE" });

      // Wait for termTimeout (combined wait since we only do one kill)
      const timeout = (termTimeout ?? 0) + (killTimeout ?? 0);
      if (timeout > 0 && (await this.waitForTreeExit(timeout))) {
        return { success: true, reason: "SIGKILL" }; // Report as SIGKILL for consistency
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
    return killProcessTree(pid, force, this.logger, this.killTree, this.descendants);
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

export interface ExecaProcessRunnerOptions {
  /**
   * The native addon (`native-addon.ts`): every OS query below goes through
   * it. Without it, `listProcesses` returns null, the port lookups find
   * nothing and `findDirectoryHolders` throws.
   */
  readonly native?: NativeAddon;
}

/** Most files a `DirectoryHolder` lists. */
const MAX_HOLDER_FILES = 20;

/**
 * `path` relative to `dir` when it is `dir` or inside it ("." for `dir`
 * itself), with its own spelling kept; null otherwise. `Path` decides
 * containment (case-insensitive on Windows, trailing separators ignored).
 */
function relativeInside(path: string, dir: string): string | null {
  if (!new Path(path).startsWith(new Path(dir))) return null;
  const rest = path
    .slice(dir.replace(/[\\/]+$/, "").length)
    .replace(/^[\\/]+/, "")
    .replace(/[\\/]+$/, "");
  return rest === "" ? "." : rest;
}

/**
 * Process runner implementation using execa; OS queries through the native addon.
 * Returns a SpawnedProcess handle for controlling the spawned process.
 */
export class ExecaProcessRunner implements ProcessRunner {
  constructor(
    private readonly logger: Logger,
    private readonly options: ExecaProcessRunnerOptions = {}
  ) {}

  /**
   * A process's descendants, from the process list: what a tree kill signals.
   * Without the addon (or when the scan fails) none are found, and a kill
   * reaches only the process itself.
   */
  private readonly descendantsOf: DescendantLookup = async (pid) => {
    if (this.options.native === undefined) return [];
    const snapshot = await this.listProcesses();
    return snapshot === null ? [] : descendantsIn(snapshot.processes, pid);
  };

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

    const spawned = new ExecaSpawnedProcess(
      subprocess,
      this.logger,
      command,
      this.descendantsOf,
      options?.redactBy
    );

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
      const tree = new Set<number>();
      await killProcessTree(pid, true, this.logger, tree, this.descendantsOf);
      this.logger.warn("Killed foreign process", { pid, signal: "TERMINATE" });

      const timeout = (termTimeout ?? 0) + (killTimeout ?? 0);
      if (timeout > 0 && (await waitForPidsExit([pid, ...tree], timeout))) {
        return { success: true, reason: "SIGKILL" };
      }
      if (timeout === 0) return { success: false };

      this.logger.warn("Foreign process survived termination", { pid, timeout });
      return { success: false };
    }

    const tree = new Set<number>();
    await killProcessTree(pid, false, this.logger, tree, this.descendantsOf);
    this.logger.info("Killed foreign process", { pid, signal: "SIGTERM" });
    // The whole tree, not just `pid` — see ExecaSpawnedProcess.waitForTreeExit.
    if (termTimeout !== undefined && (await waitForPidsExit([pid, ...tree], termTimeout))) {
      return { success: true, reason: "SIGTERM" };
    }

    await killProcessTree(pid, true, this.logger, tree, this.descendantsOf);
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
    // Best-effort by contract: a caller must not read "none found" as "port
    // free", so a failed scan is indistinguishable from an empty one.
    const sockets = await this.listeningSockets();
    const pids = [...new Set(sockets.filter((s) => s.port === port).map((s) => s.pid))];
    this.logger.debug("Scanned port for listeners", { port, count: pids.length });
    if (pids.length === 0) return [];

    // The socket table knows the pid; the process list knows what it is. A
    // failed process scan still names the holder by pid rather than hiding it.
    const snapshot = await this.listProcesses();
    const processes = snapshot?.processes ?? [];
    return pids.map((pid) => {
      const entry = processes.find((candidate) => candidate.pid === pid);
      return entry === undefined
        ? { pid, name: "unknown", commandLine: "unknown" }
        : {
            pid,
            name: entry.name,
            commandLine: entry.commandLine,
            origin: listeningProcessOrigin(entry, processes),
          };
    });
  }

  async findListeningPorts(
    pids: readonly number[]
  ): Promise<ReadonlyMap<number, readonly number[]>> {
    if (pids.length === 0) return new Map();
    const wanted = new Set(pids);
    const ports = new Map<number, number[]>();
    // The addon filters too (on Linux it then reads only these pids' fds);
    // the check here keeps the contract whatever it returns.
    for (const { pid, port } of await this.listeningSockets([...wanted])) {
      if (!wanted.has(pid)) continue;
      const list = ports.get(pid) ?? [];
      if (!list.includes(port)) list.push(port);
      ports.set(pid, list);
    }
    for (const list of ports.values()) list.sort((a, b) => a - b);
    return ports;
  }

  async findDirectoryHolders(
    dir: string,
    options: FindDirectoryHoldersOptions = {}
  ): Promise<DirectoryHolderScan> {
    const native = this.options.native;
    if (native === undefined) {
      throw new Error("Directory scan unavailable: no native addon configured");
    }
    const deadline = Date.now() + (options.timeoutMs ?? PROCESS_SCAN_TIMEOUT_MS);
    const within = <T>(work: Promise<T>): Promise<T | typeof TIMED_OUT> =>
      raceTimeout(work, Math.max(0, deadline - Date.now()));
    const timedOut: DirectoryHolderScan = { holders: [], timedOut: true };

    const processes = await within(native.listProcessesAsync(null));
    if (processes === TIMED_OUT) return timedOut;
    const byPid = new Map(processes.map((entry) => [entry.pid, entry]));

    // Never this process: whatever the scan finds is about to be killed.
    const holders = new Map<number, { name: string; cwd: string | null }>();
    for (const entry of processes) {
      if (entry.pid === process.pid || entry.cwd === null) continue;
      const cwd = relativeInside(entry.cwd, dir);
      if (cwd !== null) holders.set(entry.pid, { name: entry.name, cwd });
    }

    const files = new Map<number, string[]>();
    if (options.files === true && isWindows) {
      const locking = await within(native.restartManagerHoldersAsync(dir));
      if (locking === TIMED_OUT) return timedOut;
      for (const { pid, name } of locking) {
        if (pid === process.pid || holders.has(pid)) continue;
        holders.set(pid, { name: byPid.get(pid)?.name ?? name, cwd: null });
      }
      if (holders.size > 0) {
        const open = await within(native.openFilesUnderAsync(dir, [...holders.keys()]));
        if (open === TIMED_OUT) return timedOut;
        for (const { pid, path } of open) {
          const relative = relativeInside(path, dir);
          const list = files.get(pid) ?? [];
          if (relative === null || relative === "." || list.includes(relative)) continue;
          if (list.length < MAX_HOLDER_FILES) list.push(relative);
          files.set(pid, list);
        }
      }
    }

    return {
      timedOut: false,
      holders: [...holders].map(([pid, { name, cwd }]) => ({
        pid,
        name,
        commandLine: byPid.get(pid)?.commandLine ?? name,
        files: files.get(pid) ?? [],
        cwd,
      })),
    };
  }

  /**
   * Every listening TCP socket — with `pids`, only theirs; empty when the
   * addon is missing, failed or hung.
   */
  private async listeningSockets(
    pids?: number[]
  ): Promise<readonly { pid: number; port: number }[]> {
    const native = this.options.native;
    if (native === undefined) {
      this.logger.warn("Listening socket scan unavailable: no native addon configured");
      return [];
    }
    try {
      const sockets = await raceTimeout(
        native.listeningSocketsAsync(pids ?? null),
        PROCESS_SCAN_TIMEOUT_MS
      );
      if (sockets === TIMED_OUT) {
        this.logger.warn("Listening socket scan timed out");
        return [];
      }
      return sockets;
    } catch (error) {
      this.logger.warn("Listening socket scan failed", { error: getErrorMessage(error) });
      return [];
    }
  }

  increasePriority(pid: number): boolean {
    if (!isWindows) return false;
    // An exited process can outlive its exit as a kernel object while any
    // handle to it is open — and the native addon's process list (sysinfo)
    // keeps one until its next scan drops the dead. The OS then still accepts
    // a priority change, so liveness is asked first.
    if (!pidExists(pid)) return false;
    try {
      setPriority(pid, osConstants.priority.PRIORITY_ABOVE_NORMAL);
      return true;
    } catch (error) {
      this.logger.debug("Could not raise process priority", {
        pid,
        error: getErrorMessage(error),
      });
      return false;
    }
  }

  async listProcesses(options?: ListProcessesOptions): Promise<ProcessSnapshot | null> {
    const native = this.options.native;
    if (native === undefined) {
      this.logger.warn("Process snapshot unavailable: no native addon configured");
      return null;
    }
    try {
      // The addon cannot be cancelled once it runs; the deadline only keeps a
      // caller from waiting on a scan that never answers.
      const processes = await raceTimeout(
        native.listProcessesAsync(options?.envVar ?? null),
        PROCESS_SCAN_TIMEOUT_MS
      );
      if (processes === TIMED_OUT) {
        this.logger.warn("Process snapshot timed out");
        return null;
      }
      return { takenAt: Date.now(), processes };
    } catch (error) {
      this.logger.warn("Process snapshot failed", { error: getErrorMessage(error) });
      return null;
    }
  }
}
