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
 * - the API server asks the agent to exit and waits for it,
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
 * - delete-workspace → release: kill what the workspace started and what has
 *   its CWD inside it (best-effort; flow and error policy shared with
 *   posix-process-cleanup-module, see release-sweep)
 * - delete-workspace → detect: full handle detection, after a failed removal
 * - delete-workspace → flush: kill PIDs collected by detect
 * - hibernate-workspace → release: kill what the workspace started (best-effort)
 *
 * The release sweep's processes come from the process monitor's attribution
 * (`teardownProcesses`); detect is `ProcessRunner.findDirectoryHolders` with
 * `files` (the native addon: working directories from the process list,
 * Restart Manager and the system handle table for the files held open);
 * termination is `ProcessRunner.kill`.
 */

import type { IntentModule } from "../intents/lib/module";
import type { HookOutput } from "../intents/lib/operation";
import type { Logger } from "../boundaries/platform/logging-types";
import type { ProcessRunner } from "../boundaries/platform/process";
import type { BlockingProcess } from "../shared/api/types";
import {
  DELETE_WORKSPACE_OPERATION_ID,
  type DetectHookResult,
  type FlushHookResult,
} from "../intents/delete-workspace";
import { HIBERNATE_WORKSPACE_OPERATION_ID } from "../intents/hibernate-workspace";
import type { ProcessMonitorModule } from "./process-monitor/process-monitor-module";
import { createReleaseSweepHandlers } from "./release-sweep";
import { Path } from "../utils/path/path";
import { getErrorMessage } from "../shared/error-utils";
import { defineHooks } from "../intents/declarations";

// =============================================================================
// Constants
// =============================================================================

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

/** Wait after signalling a blocking process before declaring it a survivor. */
const KILL_TIMEOUT_MS = 5_000;

// =============================================================================
// Exported Functions (for testing and boundary tests)
// =============================================================================

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
 * Find the processes holding the workspace directory: open files and working
 * directories.
 *
 * A scan that cannot run throws, so its hook reports it rather than mistaking
 * it for a workspace nothing holds.
 * Exported for boundary tests.
 */
export async function runDetectAction(
  processRunner: Pick<ProcessRunner, "findDirectoryHolders">,
  path: Path,
  logger: Logger,
  timeoutMs: number
): Promise<DetectScanResult> {
  const scan = await processRunner.findDirectoryHolders(path.toNative(), {
    files: true,
    timeoutMs,
  });
  if (scan.timedOut) {
    logger
      .scoped({ path: path.toString() })
      .warn("Blocking process detection timed out", { timeoutMs });
    return { processes: [], timedOut: true };
  }
  return { processes: [...scan.holders], timedOut: false };
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
  pids: readonly number[],
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
  readonly processMonitor: Pick<ProcessMonitorModule, "teardownProcesses">;
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

  const { deleteRelease, hibernateRelease } = createReleaseSweepHandlers(
    {
      processMonitor: deps.processMonitor,
      kill: (pids) => killBlockingProcesses(deps.processRunner, pids, deps.logger),
    },
    deps.logger
  );

  return {
    name: "windows-file-lock",
    requires: { platform: "win32" },
    hooks: defineHooks({
      [DELETE_WORKSPACE_OPERATION_ID]: {
        release: deleteRelease,
        detect: {
          handler: async (ctx): Promise<HookOutput<DetectHookResult>> => {
            const { workspacePath } = ctx;

            try {
              const scan = await runDetectAction(
                deps.processRunner,
                new Path(workspacePath),
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
              deps.logger
                .scoped({ path: workspacePath })
                .warn("Detection failed", { error: getErrorMessage(error) });
              return { result: { blockingProcesses: [], error: getErrorMessage(error) } };
            }
          },
        },
        flush: {
          handler: async (ctx): Promise<HookOutput<FlushHookResult>> => {
            const { blockingPids } = ctx;
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
      [HIBERNATE_WORKSPACE_OPERATION_ID]: { release: hibernateRelease },
    }),
  };
}
