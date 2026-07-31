/**
 * WindowsFileLockModule — last-resort process cleanup before a workspace
 * directory is removed on Windows.
 *
 * ## This is a backstop, not the teardown
 *
 * Scanning for processes and `taskkill /f`-ing them is inherently racy in both
 * directions: the scan takes seconds and its results are stale by the time they
 * are used (a real user log shows all four detected PIDs already gone by the
 * time taskkill ran), and `TerminateProcess` returns before the OS has torn the
 * process down and released its handles (another log shows the delete hook
 * starting 3ms after taskkill exited, and failing).
 *
 * So it cannot be how we stop our OWN processes, and it no longer is:
 * - workspace-lifecycle-module claims the workspace, and the git and sidekick
 *   paths refuse to start new work in it,
 * - the plugin server asks the agent to exit and waits for it,
 * - the presenter releases the IDE frame so the IDE server lets go — but only
 *   AFTER the above, gated on the "agent-stopped" capability. Releasing it
 *   earlier disconnects the IDE client out from under the agent exit, which
 *   orphans the agent in the workspace and is what this module then cannot fix.
 *
 * What is left for this module is what none of that can reach: processes we do
 * not own — a user's own shell sitting in the workspace, an external editor,
 * antivirus, the search indexer.
 *
 * Two things follow from "backstop", and both were got wrong before:
 * - Being cheap is not the goal; being *bounded* is. A scan that gives up early
 *   returns nothing, and nothing is indistinguishable from "all clear" — which
 *   is how a deletion came to fail while the dialog reported no blockers. The
 *   budgets below are ceilings, not delays: a scan that finishes fast is
 *   unaffected by a generous one, so the pre-removal scan gets room to finish
 *   and only the post-failure scan (where a user waits on a dialog) starts
 *   short, escalating once it has proven the short budget insufficient.
 * - A kill is not done when the kill *command* returns. Termination is
 *   asynchronous, so every kill here goes through ProcessRunner.kill, which
 *   waits for the process to actually be gone and reports the ones that aren't.
 *
 * Hooks:
 * - delete-workspace → release: CWD-only scan + kill blocking processes (best-effort)
 * - delete-workspace → detect: full handle detection, after a failed removal
 * - delete-workspace → flush: kill PIDs collected by detect
 * - hibernate-workspace → release: CWD-only scan + kill blocking processes (best-effort)
 *
 * Detection uses blocking-processes.ps1 (Restart Manager API for file handles,
 * PEB reads for CWD); termination goes through the ProcessRunner boundary.
 */

import type { IntentModule } from "../intents/lib/module";
import type { HookContext, HookOutput } from "../intents/lib/operation";
import type { Logger } from "../boundaries/platform/logging-types";
import type { ProcessRunner } from "../boundaries/platform/process";
import type { BlockingProcess } from "../shared/api/types";
import {
  DELETE_WORKSPACE_OPERATION_ID,
  type DeleteWorkspaceIntent,
  type DeletePipelineHookInput,
  type ReleaseHookResult,
  type DetectHookResult,
  type FlushHookResult,
  type FlushHookInput,
} from "../intents/delete-workspace";
import {
  HIBERNATE_WORKSPACE_OPERATION_ID,
  type HibernatePipelineHookInput,
  type HibernateReleaseHookResult,
} from "../intents/hibernate-workspace";
import { Path } from "../utils/path/path";
import { getErrorMessage } from "../shared/error-utils";

// =============================================================================
// JSON Output Types
// =============================================================================

/** JSON output from the unified PowerShell script for -Action Detect mode. */
interface DetectOutput {
  blocking: Array<{
    pid: number;
    name: string;
    commandLine: string;
    files: string[];
    cwd: string | null;
  }>;
  error?: string;
}

// =============================================================================
// Constants
// =============================================================================

/** Max files per process in detect output */
const MAX_FILES_PER_PROCESS = 20;

/**
 * Timeout for the post-failure "Detect" scan.
 *
 * This runs only after a removal already failed, and the user is sitting in
 * front of a dialog that cannot tell them anything until it returns — 30s of
 * that produced a 63-second failed deletion in one user's logs, and then
 * reported no blockers anyway. So the FIRST attempt gets a short budget: fail
 * fast and say "could not determine" rather than stalling the dialog.
 *
 * When it does time out we escalate (see DETECT_TIMEOUT_ESCALATED_MS): a
 * timeout is a ceiling, not a delay, so a bigger one costs nothing on the runs
 * that finish quickly, and by the time the user is retrying they have already
 * accepted that this is going slowly.
 */
const DETECT_TIMEOUT_MS = 8_000;

/**
 * Budget for "Detect" once a scan has already timed out in this session.
 *
 * A scan blowing its budget is a property of the machine — process count and
 * load — not of the workspace being deleted, which is why the escalation is
 * module-wide rather than keyed by path.
 */
const DETECT_TIMEOUT_ESCALATED_MS = 45_000;

/**
 * Timeout for the pre-emptive CWD scan in the "release" hook.
 *
 * Deliberately generous, and NOT the same budget as the post-failure Detect
 * above. Nothing is waiting on a dialog here — this runs before the removal is
 * attempted, and its whole job is to find the processes that would make that
 * removal fail. Returning empty because the clock ran out doesn't save the user
 * any time; it just moves the failure later and strips the explanation. Since
 * the timeout only bounds a scan that is genuinely stuck, a larger one costs
 * nothing on a machine where the scan completes.
 */
const DETECT_CWD_TIMEOUT_MS = 45_000;

/** Wait after signalling a blocking process before declaring it a survivor. */
const KILL_TIMEOUT_MS = 5_000;

// =============================================================================
// Exported Functions (for testing and boundary tests)
// =============================================================================

/**
 * Parse PowerShell JSON output into BlockingProcess array.
 * Exported for testing.
 */
export function parseDetectOutput(stdout: string, logger: Logger): BlockingProcess[] {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed) as DetectOutput | { error: string };

    // Check for error response
    if ("error" in parsed && typeof parsed.error === "string") {
      logger.warn("Blocking process detection returned error", { error: parsed.error });
      return [];
    }

    const detectOutput = parsed as DetectOutput;
    if (!detectOutput.blocking || !Array.isArray(detectOutput.blocking)) {
      return [];
    }

    const result: BlockingProcess[] = [];
    for (const item of detectOutput.blocking) {
      if (isValidBlockingProcess(item)) {
        const files = Array.isArray(item.files)
          ? item.files
              .filter((f): f is string => typeof f === "string")
              .slice(0, MAX_FILES_PER_PROCESS)
          : [];

        result.push({
          pid: item.pid,
          name: String(item.name),
          commandLine: String(item.commandLine),
          files,
          cwd: typeof item.cwd === "string" ? item.cwd : null,
        });
      }
    }

    return result;
  } catch (error) {
    logger.warn("Failed to parse blocking process output", {
      stdout,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/** Type guard for validating parsed JSON structure. */
function isValidBlockingProcess(
  item: unknown
): item is { pid: number; name: unknown; commandLine: unknown; files: unknown; cwd: unknown } {
  return (
    typeof item === "object" &&
    item !== null &&
    "pid" in item &&
    typeof (item as { pid: unknown }).pid === "number" &&
    "name" in item &&
    "commandLine" in item
  );
}

/**
 * Outcome of a scan.
 *
 * `timedOut` exists because an empty `processes` list is otherwise ambiguous:
 * it means either "nothing is holding this directory" or "we never found out".
 * Collapsing the two is what let a deletion fail while the dialog reported
 * "Detecting blocking processes… done" with no blockers — the app asserting a
 * clean bill of health on the one thing that was actually wrong.
 */
export interface DetectScanResult {
  readonly processes: BlockingProcess[];
  readonly timedOut: boolean;
}

/**
 * Run a detect action using the blocking-processes.ps1 script.
 * Exported for boundary tests.
 */
export async function runDetectAction(
  processRunner: ProcessRunner,
  scriptPath: string,
  path: Path,
  action: "Detect" | "DetectCwd",
  logger: Logger,
  timeoutMs: number
): Promise<DetectScanResult> {
  const proc = processRunner.run("powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    "-BasePath",
    path.toNative(),
    "-Action",
    action,
  ]);

  const result = await proc.wait(timeoutMs);

  if (result.running) {
    logger.warn("Blocking process detection timed out", {
      path: path.toString(),
      action,
      timeoutMs,
    });
    await proc.kill(1000, 1000);
    return { processes: [], timedOut: true };
  }

  if (result.exitCode !== 0) {
    logger.warn("Blocking process detection failed", {
      path: path.toString(),
      action,
      exitCode: result.exitCode,
      stderr: result.stderr,
    });
    return { processes: [], timedOut: false };
  }

  return { processes: parseDetectOutput(result.stdout, logger), timedOut: false };
}

/**
 * Terminate blocking processes and wait for each to actually be gone.
 *
 * Returns the PIDs that were still alive afterwards. Exported for boundary tests.
 *
 * This used to shell out to a single `taskkill /pid … /t /f` and check its exit
 * code — which tells you taskkill was *invoked*, not that anything died.
 * Termination is asynchronous: the call returns before the OS has torn the
 * process down, so the worktree removal that follows a few milliseconds later
 * raced the very cleanup it had just requested. `ProcessRunner.kill` waits, and
 * reports per PID, so a process that refuses to die becomes something we can
 * name to the user instead of an unexplained EBUSY.
 */
export async function killBlockingProcesses(
  processRunner: ProcessRunner,
  pids: number[],
  logger: Logger
): Promise<number[]> {
  if (pids.length === 0) {
    return [];
  }

  logger.info("Killing blocking processes", {
    pids: pids.join(","),
  });

  const outcomes = await Promise.all(
    pids.map(async (pid) => ({
      pid,
      result: await processRunner.kill(pid, KILL_TIMEOUT_MS, KILL_TIMEOUT_MS),
    }))
  );

  const survivors = outcomes.filter((o) => !o.result.success).map((o) => o.pid);
  if (survivors.length > 0) {
    logger.warn("Blocking processes survived termination", {
      pids: survivors.join(","),
    });
  }
  return survivors;
}

// =============================================================================
// Module Factory
// =============================================================================

interface WindowsFileLockModuleDeps {
  readonly processRunner: ProcessRunner;
  readonly scriptPath: string;
  readonly logger: Logger;
}

export function createWindowsFileLockModule(deps: WindowsFileLockModuleDeps): IntentModule {
  /**
   * Whether a "Detect" scan has already blown its budget in this session.
   *
   * Module-wide on purpose: a scan that cannot finish in 8s says something
   * about this machine's process count and load, not about the workspace that
   * happened to be deleted first. Never reset — the escalated budget is a
   * ceiling, so carrying it costs nothing on the runs that finish quickly.
   */
  let detectHasTimedOut = false;

  return {
    name: "windows-file-lock",
    requires: { platform: "win32" },
    hooks: {
      [DELETE_WORKSPACE_OPERATION_ID]: {
        release: {
          handler: async (ctx: HookContext): Promise<HookOutput<ReleaseHookResult>> => {
            const { workspacePath } = ctx as DeletePipelineHookInput;
            const { payload } = ctx.intent as DeleteWorkspaceIntent;

            if (payload.force) {
              return { result: {} };
            }

            const error = await runCwdReleaseKill(deps, workspacePath, "deletion");
            return { result: error === undefined ? {} : { error } };
          },
        },
        detect: {
          handler: async (ctx: HookContext): Promise<HookOutput<DetectHookResult>> => {
            const { workspacePath } = ctx as DeletePipelineHookInput;

            try {
              const scan = await runDetectAction(
                deps.processRunner,
                deps.scriptPath,
                new Path(workspacePath),
                "Detect",
                deps.logger,
                detectHasTimedOut ? DETECT_TIMEOUT_ESCALATED_MS : DETECT_TIMEOUT_MS
              );
              if (scan.timedOut) {
                // Escalate so a retry — which the user is about to reach for,
                // since we just told them the removal failed — gets a budget
                // that can actually finish.
                detectHasTimedOut = true;
                return {
                  result: {
                    blockingProcesses: [],
                    error:
                      "Could not determine which processes hold the workspace (scan timed out)",
                  },
                };
              }
              return { result: { blockingProcesses: scan.processes } };
            } catch (error) {
              deps.logger.warn("Detection failed", {
                workspacePath,
                error: getErrorMessage(error),
              });
              return { result: { blockingProcesses: [], error: getErrorMessage(error) } };
            }
          },
        },
        flush: {
          handler: async (ctx: HookContext): Promise<HookOutput<FlushHookResult>> => {
            const { blockingPids } = ctx as FlushHookInput;
            if (blockingPids.length > 0) {
              try {
                const survivors = await killBlockingProcesses(
                  deps.processRunner,
                  [...blockingPids],
                  deps.logger
                );
                if (survivors.length > 0) {
                  return {
                    result: { error: `Could not terminate pid ${survivors.join(", ")}` },
                  };
                }
              } catch (error) {
                return { result: { error: getErrorMessage(error) } };
              }
            }
            return { result: {} };
          },
        },
      },
      [HIBERNATE_WORKSPACE_OPERATION_ID]: {
        release: {
          handler: async (ctx: HookContext): Promise<HookOutput<HibernateReleaseHookResult>> => {
            const { workspacePath } = ctx as HibernatePipelineHookInput;
            // Hibernation has no error channel on its release result and no
            // removal to explain, so the outcome is logged (inside
            // runCwdReleaseKill) rather than reported.
            await runCwdReleaseKill(deps, workspacePath, "hibernation");
            return { result: {} };
          },
        },
      },
    },
  };
}

/**
 * Scan for processes with a CWD under the workspace and kill them.
 *
 * Returns a message when something went wrong, rather than swallowing it. The
 * failure is still non-fatal — the caller reports it and carries on — but a
 * process we could not kill is the single most actionable thing we can put in
 * front of a user whose deletion then fails on a locked directory, and it used
 * to be discarded by a bare `catch {}`.
 */
async function runCwdReleaseKill(
  deps: WindowsFileLockModuleDeps,
  workspacePath: string,
  phase: "deletion" | "hibernation"
): Promise<string | undefined> {
  try {
    const scan = await runDetectAction(
      deps.processRunner,
      deps.scriptPath,
      new Path(workspacePath),
      "DetectCwd",
      deps.logger,
      DETECT_CWD_TIMEOUT_MS
    );
    if (scan.timedOut) {
      return "Could not determine which processes hold the workspace (scan timed out)";
    }
    if (scan.processes.length === 0) {
      return undefined;
    }

    deps.logger.info(`Killing CWD-blocking processes before ${phase}`, {
      workspacePath,
      pids: scan.processes.map((p) => p.pid).join(","),
    });
    const survivors = await killBlockingProcesses(
      deps.processRunner,
      scan.processes.map((p) => p.pid),
      deps.logger
    );
    if (survivors.length > 0) {
      const named = survivors
        .map((pid) => {
          const proc = scan.processes.find((p) => p.pid === pid);
          return proc ? `${proc.name} (pid ${pid})` : `pid ${pid}`;
        })
        .join(", ");
      return `Could not terminate: ${named}`;
    }
    return undefined;
  } catch (error) {
    return getErrorMessage(error);
  }
}
