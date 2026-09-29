/**
 * PosixProcessCleanupModule — Kills processes whose CWD is under the workspace path during deletion or hibernation.
 *
 * Hooks:
 * - delete-workspace → release: Use lsof to find CWD matches, terminate them (best-effort)
 * - hibernate-workspace → release: Same CWD scan + terminate, runs after shutdown (best-effort)
 *
 * Detection uses `lsof -a -d cwd +c 0 -Fpnc +D <path>` for machine-parseable output
 * scoped to the workspace directory tree. The -a flag ANDs the -d and +D selections
 * (lsof defaults to OR).
 * lsof exit code 1 means "no files found" and is not treated as an error.
 */

import type { IntentModule } from "../intents/lib/module";
import type { HookContext, HookOutput } from "../intents/lib/operation";
import type { Logger } from "../boundaries/platform/logging-types";
import type { ProcessRunner, ProcessResult } from "../boundaries/platform/process";
import {
  DELETE_WORKSPACE_OPERATION_ID,
  type DeletePipelineHookInput,
  type ReleaseHookResult,
} from "../intents/delete-workspace";
import {
  HIBERNATE_WORKSPACE_OPERATION_ID,
  type HibernatePipelineHookInput,
  type HibernateReleaseHookResult,
} from "../intents/hibernate-workspace";

/** Detected process info from lsof. */
export interface DetectedProcess {
  readonly pid: number;
  readonly name: string;
  readonly cwd: string;
}

const DETECT_TIMEOUT_MS = 10_000;
const KILL_TIMEOUT_MS = 5_000;

/**
 * Parse lsof -Fpnc output into DetectedProcess array.
 * Format: lines starting with p=PID, c=command, n=path.
 * Each process entry starts with a 'p' line.
 * Primary path filtering is handled by lsof's -a +D flags.
 * The workspacePath check here is defense-in-depth.
 */
function parseLsofOutput(stdout: string, workspacePath: string): DetectedProcess[] {
  const results: DetectedProcess[] = [];
  let currentPid: number | undefined;
  let currentName = "unknown";

  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;

    const prefix = line[0];
    const value = line.slice(1);

    switch (prefix) {
      case "p":
        currentPid = Number(value);
        currentName = "unknown";
        break;
      case "c":
        currentName = value;
        break;
      case "n":
        if (
          currentPid !== undefined &&
          !Number.isNaN(currentPid) &&
          (value === workspacePath || value.startsWith(workspacePath + "/"))
        ) {
          results.push({ pid: currentPid, name: currentName, cwd: value });
        }
        break;
    }
  }

  return results;
}

/**
 * Detect processes whose CWD is under the given workspace path using lsof.
 * Exported for testing.
 */
export async function detectCwdProcesses(
  processRunner: ProcessRunner,
  workspacePath: string,
  logger: Logger
): Promise<DetectedProcess[]> {
  const proc = processRunner.run("lsof", [
    "-a",
    "-d",
    "cwd",
    "+c",
    "0",
    "-Fpnc",
    "+D",
    workspacePath,
  ]);
  const result: ProcessResult = await proc.wait(DETECT_TIMEOUT_MS);

  if (result.running) {
    logger.scoped({ path: workspacePath }).warn("Process detection timed out");
    await proc.kill(1000, 1000);
    return [];
  }

  // lsof exit code 1 = "no files found" (not an error)
  if (result.exitCode !== null && result.exitCode !== 0 && result.exitCode !== 1) {
    logger
      .scoped({ path: workspacePath })
      .warn("Process detection failed", { exitCode: result.exitCode, stderr: result.stderr });
    return [];
  }

  return parseLsofOutput(result.stdout, workspacePath);
}

/**
 * Terminate a list of PIDs and wait until they are gone.
 *
 * Goes through `ProcessRunner.kill` (SIGTERM → wait → SIGKILL → wait, children
 * included) rather than spawning `kill`: that tool exits 1 both for a process
 * that already exited and for one we may not signal, and tells them apart only
 * in localized stderr. `ProcessRunner.kill` works from `process.kill`'s error
 * codes and reports whether each process actually died.
 *
 * @returns the PIDs still running afterwards
 * Exported for testing.
 */
export async function killPosixProcesses(
  processRunner: ProcessRunner,
  pids: readonly number[]
): Promise<number[]> {
  const outcomes = await Promise.all(
    pids.map(async (pid) => ({
      pid,
      result: await processRunner.kill(pid, KILL_TIMEOUT_MS, KILL_TIMEOUT_MS),
    }))
  );
  return outcomes.filter((o) => !o.result.success).map((o) => o.pid);
}

interface PosixProcessCleanupModuleDeps {
  readonly processRunner: ProcessRunner;
  readonly logger: Logger;
}

export function createPosixProcessCleanupModule(deps: PosixProcessCleanupModuleDeps): IntentModule {
  return {
    name: "posix-process-cleanup",
    requires: { posix: true },
    hooks: {
      [DELETE_WORKSPACE_OPERATION_ID]: {
        release: {
          handler: async (ctx: HookContext): Promise<HookOutput<ReleaseHookResult>> => {
            // Runs in force mode too — see windows-file-lock-module. Here the
            // removal succeeds regardless, but a process left in the worktree
            // would otherwise outlive the workspace it belonged to.
            const { workspacePath } = ctx as DeletePipelineHookInput;
            await runCwdReleaseKill(deps, workspacePath, "deletion");
            return { result: {} };
          },
        },
      },
      [HIBERNATE_WORKSPACE_OPERATION_ID]: {
        release: {
          handler: async (ctx: HookContext): Promise<HookOutput<HibernateReleaseHookResult>> => {
            const { workspacePath } = ctx as HibernatePipelineHookInput;
            await runCwdReleaseKill(deps, workspacePath, "hibernation");
            return { result: {} };
          },
        },
      },
    },
  };
}

async function runCwdReleaseKill(
  deps: PosixProcessCleanupModuleDeps,
  workspacePath: string,
  phase: "deletion" | "hibernation"
): Promise<void> {
  try {
    const detected = await detectCwdProcesses(deps.processRunner, workspacePath, deps.logger);

    if (detected.length > 0) {
      deps.logger
        .scoped({ path: workspacePath })
        .info(`Killing CWD-blocking processes before ${phase}`, {
          pids: detected.map((p) => p.pid).join(","),
        });
      const survivors = await killPosixProcesses(
        deps.processRunner,
        detected.map((p) => p.pid)
      );
      if (survivors.length > 0) {
        deps.logger
          .scoped({ path: workspacePath })
          .warn(`CWD-blocking processes survived ${phase} cleanup`, {
            pids: survivors.join(","),
          });
      }
    }
  } catch {
    // Non-fatal: detection/kill failure shouldn't block the operation
  }
}
