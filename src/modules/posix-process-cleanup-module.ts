/**
 * PosixProcessCleanupModule — Kills processes whose CWD is under the workspace path during deletion or hibernation.
 *
 * Hooks (flow and error policy shared with windows-file-lock-module, see cwd-release-kill):
 * - delete-workspace → release: find the processes whose CWD is inside the
 *   workspace, terminate them; a timed-out scan, a failure or a survivor is
 *   reported on the release result
 * - hibernate-workspace → release: Same CWD scan + terminate, runs after shutdown;
 *   failures are logged
 *
 * Detection is `ProcessRunner.findDirectoryHolders` (the native addon's process
 * list, filtered by working directory): no `lsof`, which may be missing, and
 * no walk of the workspace tree, which `lsof +D` did and node_modules made slow.
 */

import type { IntentModule } from "../intents/lib/module";
import type { Logger } from "../boundaries/platform/logging-types";
import type { ProcessRunner } from "../boundaries/platform/process";
import { DELETE_WORKSPACE_OPERATION_ID } from "../intents/delete-workspace";
import { HIBERNATE_WORKSPACE_OPERATION_ID } from "../intents/hibernate-workspace";
import { createCwdReleaseHandlers, type CwdScan } from "./cwd-release-kill";
import { defineHooks } from "../intents/declarations";

/** A process with its working directory inside the workspace. */
export interface DetectedProcess {
  readonly pid: number;
  readonly name: string;
  /** Relative to the workspace ("." for the workspace itself). */
  readonly cwd: string;
}

const DETECT_TIMEOUT_MS = 10_000;
const KILL_TIMEOUT_MS = 5_000;

/**
 * Detect processes whose CWD is under the given workspace path.
 *
 * A scan that cannot run throws, so the release reports it rather than
 * mistaking it for a workspace nothing holds.
 * Exported for testing.
 */
export async function detectCwdProcesses(
  processRunner: ProcessRunner,
  workspacePath: string,
  logger: Logger
): Promise<CwdScan & { readonly processes: readonly DetectedProcess[] }> {
  const scan = await processRunner.findDirectoryHolders(workspacePath, {
    timeoutMs: DETECT_TIMEOUT_MS,
  });
  if (scan.timedOut) {
    logger.scoped({ path: workspacePath }).warn("Process detection timed out");
    return { processes: [], timedOut: true };
  }
  return {
    processes: scan.holders.flatMap(({ pid, name, cwd }) =>
      cwd === null ? [] : [{ pid, name, cwd }]
    ),
    timedOut: false,
  };
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
  const { deleteRelease, hibernateRelease } = createCwdReleaseHandlers(
    {
      detect: (workspacePath) => detectCwdProcesses(deps.processRunner, workspacePath, deps.logger),
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
