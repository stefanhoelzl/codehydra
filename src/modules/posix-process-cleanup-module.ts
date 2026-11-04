/**
 * PosixProcessCleanupModule — stops what still runs in a workspace when it is
 * deleted or hibernated.
 *
 * Hooks (flow and error policy shared with windows-file-lock-module, see release-sweep):
 * - delete-workspace → release: terminate every process the workspace started
 *   and every process whose CWD is inside it; a failed scan or a survivor is
 *   reported on the release result
 * - hibernate-workspace → release: terminate every process the workspace
 *   started, after shutdown; failures are logged
 *
 * What the workspace started is the process monitor's attribution
 * (`teardownProcesses`); termination is `ProcessRunner.kill`.
 */

import type { IntentModule } from "../intents/lib/module";
import type { Logger } from "../boundaries/platform/logging-types";
import type { ProcessRunner } from "../boundaries/platform/process";
import type { ProcessMonitorModule } from "./process-monitor/process-monitor-module";
import { DELETE_WORKSPACE_OPERATION_ID } from "../intents/delete-workspace";
import { HIBERNATE_WORKSPACE_OPERATION_ID } from "../intents/hibernate-workspace";
import { createReleaseSweepHandlers } from "./release-sweep";
import { defineHooks } from "../intents/declarations";

const KILL_TIMEOUT_MS = 5_000;

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
  processRunner: Pick<ProcessRunner, "kill">,
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
  readonly processRunner: Pick<ProcessRunner, "kill">;
  readonly processMonitor: Pick<ProcessMonitorModule, "teardownProcesses">;
  readonly logger: Logger;
}

export function createPosixProcessCleanupModule(deps: PosixProcessCleanupModuleDeps): IntentModule {
  const { deleteRelease, hibernateRelease } = createReleaseSweepHandlers(
    {
      processMonitor: deps.processMonitor,
      kill: (pids) => killPosixProcesses(deps.processRunner, pids),
    },
    deps.logger
  );
  return {
    name: "posix-process-cleanup",
    requires: { posix: true },
    hooks: defineHooks({
      [DELETE_WORKSPACE_OPERATION_ID]: { release: deleteRelease },
      [HIBERNATE_WORKSPACE_OPERATION_ID]: { release: hibernateRelease },
    }),
  };
}
