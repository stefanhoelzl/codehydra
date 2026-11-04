/**
 * The release-time process sweep shared by the per-platform cleanup modules
 * (posix-process-cleanup-module, windows-file-lock-module): before a workspace
 * is hibernated or removed, stop what is still running in it.
 *
 * What runs in it is the process monitor's answer (`teardownProcesses`, the
 * same attribution as the Processes view): every process the workspace
 * started — by `_CH_WORKSPACE`, working directory or ancestry, wherever it runs
 * now — and, for a deletion, also every process whose working directory is in
 * the worktree, whoever started it: the directory is going away, and on
 * Windows such a process keeps it from being removed. Only termination differs
 * per platform; the flow and its error policy are here, once.
 */

import type { Logger } from "../boundaries/platform/logging-types";
import type { HookOutput } from "../intents/lib/operation";
import type { HookHandlerOf } from "../intents/declarations";
import type { DELETE_WORKSPACE_OPERATION_ID, ReleaseHookResult } from "../intents/delete-workspace";
import type {
  HIBERNATE_WORKSPACE_OPERATION_ID,
  HibernateReleaseHookResult,
} from "../intents/hibernate-workspace";
import type { WorkspaceRef } from "../intents/contract";
import type { ProcessMonitorModule } from "./process-monitor/process-monitor-module";
import { getErrorMessage } from "../shared/error-utils";

/** What the sweep needs: the processes to stop, and how to stop them. */
export interface ReleaseSweepDeps {
  readonly processMonitor: Pick<ProcessMonitorModule, "teardownProcesses">;
  /** Terminate `pids` and wait for them to be gone; resolves with the survivors. */
  kill(pids: readonly number[]): Promise<number[]>;
}

/**
 * Find what still runs in the workspace and kill it.
 *
 * Returns a message when something went wrong, rather than swallowing it. The
 * failure is still non-fatal — the caller reports it and carries on — but a
 * process we could not kill is the single most actionable thing we can put in
 * front of a user whose deletion then fails on a locked directory.
 */
export async function runReleaseSweep(
  deps: ReleaseSweepDeps,
  workspace: { readonly ref: WorkspaceRef; readonly path: string },
  phase: "deletion" | "hibernation",
  logger: Logger
): Promise<string | undefined> {
  try {
    const processes = await deps.processMonitor.teardownProcesses(workspace, {
      cwdInside: phase === "deletion",
    });
    if (processes === null) {
      return "Could not determine which processes run in the workspace (process scan failed)";
    }
    if (processes.length === 0) {
      return undefined;
    }

    logger.scoped({ path: workspace.path }).info(`Killing workspace processes before ${phase}`, {
      pids: processes.map((p) => p.pid).join(","),
    });
    const survivors = await deps.kill(processes.map((p) => p.pid));
    if (survivors.length > 0) {
      const named = survivors
        .map((pid) => {
          const proc = processes.find((p) => p.pid === pid);
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
export function createReleaseSweepHandlers(
  deps: ReleaseSweepDeps,
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
        // agent terminal that ignored its close), and without this sweep it
        // keeps the directory locked and the removal fails — or, where the
        // removal succeeds regardless, the process outlives its workspace.
        const workspace = { ref: ctx.workspaceRef, path: ctx.workspacePath };
        const error = await runReleaseSweep(deps, workspace, "deletion", logger);
        return { result: error === undefined ? {} : { error } };
      },
    },
    hibernateRelease: {
      handler: async (ctx): Promise<HookOutput<HibernateReleaseHookResult>> => {
        const workspace = { ref: ctx.workspaceRef, path: ctx.workspacePath };
        const error = await runReleaseSweep(deps, workspace, "hibernation", logger);
        if (error !== undefined) {
          logger
            .scoped({ path: ctx.workspacePath })
            .warn("Workspace process cleanup failed", { error });
        }
        return { result: {} };
      },
    },
  };
}
