/**
 * Runs one plugin script: the single place a plugin's code meets a process.
 *
 * Every contribution kind — a hook, an automation, whatever comes next — hands
 * this a script body, the shell it is written for, the JSON to put on stdin and
 * where to run it. The body goes to a temp file with the shell's extension and
 * runs with GitHub-Actions-style flags (see shells.ts), with:
 *
 * - `ch` on PATH, so a script can call back into CodeHydra (from a worktree,
 *   `ch` acts on that workspace without being told which);
 * - `CH_PLUGIN_DIR` for a plugin that is a directory, so it can reach the files
 *   it bundles, and `CH_WORKSPACE_DIR` wherever a worktree applies;
 * - the rest of CodeHydra's own environment, deliberately: a script wants the
 *   user's toolchain, proxy settings and credential helpers.
 *
 * The exchange is JSON on stdin, JSON (or nothing) on stdout; stderr is human
 * output. All of it lands in the run's own log file (run-log.ts), never in the
 * app log, and the result carries that file's path for whoever reports a failure.
 */

import { randomBytes } from "node:crypto";
import type { FileSystemBoundary } from "../../boundaries/platform/filesystem";
import {
  PROCESS_KILL_FORCE_TIMEOUT_MS,
  PROCESS_KILL_GRACEFUL_TIMEOUT_MS,
  type ProcessResult,
  type ProcessRunner,
  type SpawnedProcess,
} from "../../boundaries/platform/process";
import type { Logger } from "../../boundaries/platform/logging-types";
import { Path } from "../../utils/path/path";
import { getErrorMessage } from "../../shared/error-utils";
import { writeRunLog, type RunOutcome } from "./run-log";
import type { ShellName, ShellResolver } from "./shells";

// =============================================================================
// Types
// =============================================================================

export interface ScriptRunnerDeps {
  readonly fileSystem: Pick<
    FileSystemBoundary,
    "mkdir" | "writeFile" | "readdir" | "rm" | "makeExecutable"
  >;
  readonly processRunner: ProcessRunner;
  readonly shells: ShellResolver;
  readonly logger: Logger;
  /** Directory for the temp script files (cleaned at startup and shutdown). */
  readonly tempDir: Path;
  /** Directory holding the `ch` CLI, prepended to every script's PATH. */
  readonly binDir: Path;
  /** Base environment. Default: this process's. */
  readonly env?: NodeJS.ProcessEnv;
  /** Default: this process's. */
  readonly platform?: NodeJS.Platform;
}

export interface ScriptRequest {
  /** The plugin's display id (`local:github`), for the log and the log header. */
  readonly plugin: string;
  /** Hook entry or automation name. */
  readonly entry: string;
  readonly shell: ShellName;
  readonly script: string;
  readonly cwd: Path;
  /** Serialized to stdin. */
  readonly input: unknown;
  /** Where this entry's run logs go. */
  readonly logDir: Path;
  /** `CH_PLUGIN_DIR`, for a plugin that is a directory. */
  readonly pluginDir?: Path;
  /** `CH_WORKSPACE_DIR`, when the script is about one worktree. */
  readonly workspaceDir?: Path;
  /** Aborting it kills the script's process tree; the run counts as failed. */
  readonly signal?: AbortSignal;
  /** Kill the script after this long. Absent = no limit. */
  readonly timeoutMs?: number;
}

export type ScriptStatus = "exited" | "canceled" | "timed-out";

export interface ScriptResult {
  readonly status: ScriptStatus;
  /** Null when the process was killed or could not start. */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** The run's log file. Absent only when writing it failed. */
  readonly logPath?: Path;
}

/** The outcome a caller records in the run log once it has judged the result. */
export interface RunJudgement {
  readonly outcome: RunOutcome;
  readonly reason?: string;
}

/** A script handed to {@link ScriptRunner.run}, before its log is written. */
export interface PendingRun {
  readonly result: Omit<ScriptResult, "logPath">;
  /**
   * Write the run's log with the caller's verdict and return its path.
   *
   * Split from the run itself because only the caller knows whether an exit-0
   * run succeeded: a hook that printed JSON of the wrong shape failed, and its
   * log belongs with the failures.
   */
  finish(judgement: RunJudgement): Promise<Path | undefined>;
}

export interface ScriptRunner {
  /**
   * Run a script to completion (or cancel/timeout). Throws `ShellUnavailableError`
   * when its shell is missing — nothing ran, so there is no log to write.
   */
  run(request: ScriptRequest): Promise<PendingRun>;
}

// =============================================================================
// Implementation
// =============================================================================

export function createScriptRunner(deps: ScriptRunnerDeps): ScriptRunner {
  const platform = deps.platform ?? process.platform;
  const baseEnv = deps.env ?? process.env;

  function scriptEnv(request: ScriptRequest): NodeJS.ProcessEnv {
    const pathKey = Object.keys(baseEnv).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
    const current = baseEnv[pathKey];
    const bin = deps.binDir.toNative();
    const delimiter = platform === "win32" ? ";" : ":";
    return {
      ...baseEnv,
      [pathKey]: current ? `${bin}${delimiter}${current}` : bin,
      ...(request.pluginDir !== undefined && { CH_PLUGIN_DIR: request.pluginDir.toNative() }),
      ...(request.workspaceDir !== undefined && {
        CH_WORKSPACE_DIR: request.workspaceDir.toNative(),
      }),
    };
  }

  async function writeScriptFile(extension: string, body: string): Promise<Path> {
    await deps.fileSystem.mkdir(deps.tempDir);
    const file = new Path(deps.tempDir, `${randomBytes(8).toString("hex")}${extension}`);
    await deps.fileSystem.writeFile(file, body);
    await deps.fileSystem.makeExecutable(file);
    return file;
  }

  return {
    async run(request: ScriptRequest): Promise<PendingRun> {
      const shell = await deps.shells.resolve(request.shell);
      // Newline-terminated: under `-e`, bash's `read` fails on a last line
      // without one, and every JSON parser ignores it.
      const input = `${JSON.stringify(request.input)}\n`;
      const startedAt = new Date();
      const scriptFile = await writeScriptFile(shell.extension, shell.prelude + request.script);

      let result: Omit<ScriptResult, "logPath">;
      try {
        const invocation = shell.invocation(scriptFile);
        deps.logger.debug("Running plugin script", {
          plugin: request.plugin,
          entry: request.entry,
          shell: shell.name,
        });
        const proc = deps.processRunner.run(invocation.command, invocation.args, {
          ...(invocation.shell === true && { shell: true }),
          cwd: request.cwd.toNative(),
          env: scriptEnv(request),
          input,
          // The output may carry whatever the script inlines; the run log has it.
          redactBy: `plugin ${request.plugin} ${request.entry}`,
        });
        result = await waitFor(proc, request.signal, request.timeoutMs);
      } finally {
        await deps.fileSystem.rm(scriptFile, { force: true }).catch(() => undefined);
      }

      return {
        result,
        finish: async (judgement) => {
          try {
            return await writeRunLog(deps.fileSystem, request.logDir, {
              plugin: request.plugin,
              entry: request.entry,
              shell: shell.name,
              cwd: request.cwd.toNative(),
              startedAt,
              endedAt: new Date(),
              exitCode: result.exitCode,
              outcome: judgement.outcome,
              ...(judgement.reason !== undefined && { reason: judgement.reason }),
              input,
              stdout: result.stdout,
              stderr: result.stderr,
            });
          } catch (error) {
            deps.logger.warn("Could not write a plugin run log", {
              plugin: request.plugin,
              entry: request.entry,
              error: getErrorMessage(error),
            });
            return undefined;
          }
        },
      };
    },
  };
}

/**
 * Wait for a script to exit, or kill it when the signal aborts or the timeout
 * passes first.
 *
 * Once canceled the run is over from the caller's point of view, whether or
 * not the kill landed: the tree kill is as thorough as the platform allows, and
 * a process that survives it must not hold a workspace open forever — the very
 * thing Cancel exists to end.
 */
async function waitFor(
  proc: SpawnedProcess,
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined
): Promise<Omit<ScriptResult, "logPath">> {
  const done = (status: ScriptStatus, result: ProcessResult): Omit<ScriptResult, "logPath"> => ({
    status,
    exitCode: status === "exited" ? result.exitCode : null,
    stdout: result.stdout,
    stderr: result.stderr,
  });
  const kill = async (status: ScriptStatus): Promise<Omit<ScriptResult, "logPath">> => {
    await proc.kill(PROCESS_KILL_GRACEFUL_TIMEOUT_MS, PROCESS_KILL_FORCE_TIMEOUT_MS);
    // What it printed before it died is what explains a hang; a process that
    // survived the kill gets a short wait, not a chance to hold the run open.
    const partial = await proc.wait(PROCESS_KILL_FORCE_TIMEOUT_MS);
    return { status, exitCode: null, stdout: partial.stdout, stderr: partial.stderr };
  };

  if (signal?.aborted) return kill("canceled");

  return new Promise((resolve) => {
    // Set once a kill starts: the process then exits on its way down, and that
    // exit must not be reported as an ordinary one ahead of the kill's verdict.
    let killing = false;
    let settled = false;
    const settle = (value: Omit<ScriptResult, "logPath">): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (timer !== undefined) clearTimeout(timer);
      resolve(value);
    };
    const stop = (status: ScriptStatus): void => {
      if (killing || settled) return;
      killing = true;
      void kill(status).then(settle);
    };
    const onAbort = (): void => stop("canceled");
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer =
      timeoutMs === undefined ? undefined : setTimeout(() => stop("timed-out"), timeoutMs);

    void proc.wait().then((result) => {
      if (!killing) settle(done("exited", result));
    });
  });
}

/** The exit code, with the shell's two conventional codes spelled out. */
export function exitReason(exitCode: number | null): string {
  switch (exitCode) {
    case null:
      return "no exit code (killed)";
    case 126:
      return "exit 126: a file could not be executed";
    case 127:
      return "exit 127: a command was not found";
    default:
      return `exit ${exitCode}`;
  }
}

/** Why a run failed, in the words a notification or `ch plugin errors` uses. */
export function describeStatus(result: Pick<ScriptResult, "status" | "exitCode">): string {
  switch (result.status) {
    case "canceled":
      return "canceled";
    case "timed-out":
      return "timed out";
    case "exited":
      return exitReason(result.exitCode);
  }
}
