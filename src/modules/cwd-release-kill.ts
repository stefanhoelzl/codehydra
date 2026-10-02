/**
 * The release-time process sweep shared by the per-platform cleanup modules
 * (posix-process-cleanup-module, windows-file-lock-module): before a workspace
 * is removed or hibernated, find the processes whose CWD is inside it and kill
 * them. Only detection and termination differ per platform; the flow and its
 * error policy are here, once.
 */

import type { Logger } from "../boundaries/platform/logging-types";
import type { HookOutput } from "../intents/lib/operation";
import type { HookHandlerOf } from "../intents/declarations";
import type { DELETE_WORKSPACE_OPERATION_ID, ReleaseHookResult } from "../intents/delete-workspace";
import type {
  HIBERNATE_WORKSPACE_OPERATION_ID,
  HibernateReleaseHookResult,
} from "../intents/hibernate-workspace";
import { getErrorMessage } from "../shared/error-utils";

/** A process found with its CWD inside the workspace. */
export interface CwdProcess {
  readonly pid: number;
  readonly name: string;
}

/**
 * Outcome of a CWD scan. `timedOut` keeps "nothing found" apart from "never
 * found out": an empty list alone would report a clean bill of health on a scan
 * that gave up.
 */
export interface CwdScan {
  readonly processes: readonly CwdProcess[];
  readonly timedOut: boolean;
}

/** The per-platform half of the sweep. */
export interface CwdReleaseKiller {
  /** Find processes whose CWD is under `workspacePath`. */
  detect(workspacePath: string): Promise<CwdScan>;
  /** Terminate `pids` and wait for them to be gone; resolves with the survivors. */
  kill(pids: readonly number[]): Promise<number[]>;
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
export async function runCwdReleaseKill(
  killer: CwdReleaseKiller,
  workspacePath: string,
  phase: "deletion" | "hibernation",
  logger: Logger
): Promise<string | undefined> {
  try {
    const scan = await killer.detect(workspacePath);
    if (scan.timedOut) {
      return "Could not determine which processes hold the workspace (scan timed out)";
    }
    if (scan.processes.length === 0) {
      return undefined;
    }

    logger.scoped({ path: workspacePath }).info(`Killing CWD-blocking processes before ${phase}`, {
      pids: scan.processes.map((p) => p.pid).join(","),
    });
    const survivors = await killer.kill(scan.processes.map((p) => p.pid));
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

/**
 * The delete-workspace and hibernate-workspace `release` handlers running the
 * sweep. A deletion reports a failure on its release result; hibernation has no
 * error channel there and no removal to explain, so its failure is logged.
 */
export function createCwdReleaseHandlers(
  killer: CwdReleaseKiller,
  logger: Logger
): {
  readonly deleteRelease: HookHandlerOf<typeof DELETE_WORKSPACE_OPERATION_ID, "release">;
  readonly hibernateRelease: HookHandlerOf<typeof HIBERNATE_WORKSPACE_OPERATION_ID, "release">;
} {
  return {
    deleteRelease: {
      handler: async (ctx): Promise<HookOutput<ReleaseHookResult>> => {
        // Runs in force mode too. Force skips the gates that can refuse
        // (pre-delete) and ignores errors — it must not skip the cleanup.
        // The one force deletion that removes the worktree is Dismiss, and
        // it follows an attempt that stopped before this hook: a refused
        // pre-delete leaves behind whatever the shutdown could not stop (an
        // agent terminal that ignored its close), and without this scan it
        // keeps the directory locked and the removal fails — or, where the
        // removal succeeds regardless, the process outlives its workspace.
        const { workspacePath } = ctx;
        const error = await runCwdReleaseKill(killer, workspacePath, "deletion", logger);
        return { result: error === undefined ? {} : { error } };
      },
    },
    hibernateRelease: {
      handler: async (ctx): Promise<HookOutput<HibernateReleaseHookResult>> => {
        const { workspacePath } = ctx;
        const error = await runCwdReleaseKill(killer, workspacePath, "hibernation", logger);
        if (error !== undefined) {
          logger.scoped({ path: workspacePath }).warn("CWD process cleanup failed", { error });
        }
        return { result: {} };
      },
    },
  };
}
