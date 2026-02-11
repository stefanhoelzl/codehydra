/**
 * DeleteWorkspaceOperation - Orchestrates workspace deletion.
 *
 * Runs three hook points in sequence using collect():
 * 1. "shutdown" - ViewModule (switch + destroy view), AgentModule (kill terminals, stop server, clear MCP/TUI)
 * 2. "release" - WindowsLockModule (detect + kill/close blockers) [Windows-only]
 * 3. "delete" - WorktreeModule (remove git worktree), CodeServerModule (delete .code-workspace file)
 *
 * Each handler returns a typed result; the operation merges results and tracks errors.
 * On success (or force=true), emits a workspace:deleted domain event for state cleanup.
 *
 * No provider dependencies - hook handlers do the actual work.
 */

import type { Intent, DomainEvent } from "../intents/infrastructure/types";
import type { Operation, OperationContext, HookContext } from "../intents/infrastructure/operation";
import type {
  ProjectId,
  WorkspaceName,
  DeletionProgress,
  DeletionOperation,
  BlockingProcess,
} from "../../shared/api/types";
import type { WorkspacePath } from "../../shared/ipc";
import {
  INTENT_SWITCH_WORKSPACE,
  EVENT_WORKSPACE_SWITCHED,
  type SwitchWorkspaceIntent,
  type WorkspaceSwitchedEvent,
} from "./switch-workspace";

// =============================================================================
// Intent Types
// =============================================================================

export interface DeleteWorkspacePayload {
  readonly projectId: ProjectId;
  readonly workspaceName: WorkspaceName;
  readonly workspacePath: string;
  readonly projectPath: string;
  readonly keepBranch: boolean;
  readonly force: boolean;
  /** Whether to remove the git worktree. true = full pipeline, false = shutdown only (runtime teardown). */
  readonly removeWorktree: boolean;
  readonly skipSwitch?: boolean;
  readonly unblock?: "kill" | "close" | "ignore";
  readonly isRetry?: boolean;
}

export interface DeleteWorkspaceIntent extends Intent<{ started: true }> {
  readonly type: "workspace:delete";
  readonly payload: DeleteWorkspacePayload;
}

export const INTENT_DELETE_WORKSPACE = "workspace:delete" as const;

// =============================================================================
// Event Types
// =============================================================================

export interface WorkspaceDeletedPayload {
  readonly projectId: ProjectId;
  readonly workspaceName: WorkspaceName;
  readonly workspacePath: string;
  readonly projectPath: string;
}

export interface WorkspaceDeletedEvent extends DomainEvent {
  readonly type: "workspace:deleted";
  readonly payload: WorkspaceDeletedPayload;
}

export const EVENT_WORKSPACE_DELETED = "workspace:deleted" as const;

// =============================================================================
// Hook Result Types (returned by handlers via collect())
// =============================================================================

export const DELETE_WORKSPACE_OPERATION_ID = "delete-workspace";

/**
 * Per-handler result for the "shutdown" hook point.
 * ViewModule provides wasActive/nextSwitch; AgentModule may provide error.
 */
export interface ShutdownHookResult {
  readonly wasActive?: boolean;
  readonly nextSwitch?: { projectId: ProjectId; workspaceName: WorkspaceName } | null;
  readonly error?: string;
}

/**
 * Per-handler result for the "release" hook point.
 * blockingProcesses field present = detection was attempted.
 */
export interface ReleaseHookResult {
  readonly blockingProcesses?: readonly BlockingProcess[];
  readonly unblockPerformed?: boolean;
  readonly error?: string;
}

/**
 * Per-handler result for the "delete" hook point.
 * reactiveBlockingProcesses = detected after worktree removal failure (Windows).
 */
export interface DeleteHookResult {
  readonly reactiveBlockingProcesses?: readonly BlockingProcess[];
  readonly error?: string;
}

// =============================================================================
// Merged Result Types (internal to operation)
// =============================================================================

interface MergedShutdown {
  readonly wasActive: boolean;
  readonly nextSwitch?: { projectId: ProjectId; workspaceName: WorkspaceName } | null;
  readonly errors: readonly string[];
}

interface MergedRelease {
  readonly blockingProcesses?: readonly BlockingProcess[];
  readonly unblockPerformed?: boolean;
  readonly errors: readonly string[];
}

interface MergedDelete {
  readonly reactiveBlockingProcesses?: readonly BlockingProcess[];
  readonly errors: readonly string[];
}

// =============================================================================
// Merge Functions
// =============================================================================

function mergeShutdown(
  results: readonly ShutdownHookResult[],
  collectErrors: readonly Error[]
): MergedShutdown {
  let wasActive = false;
  let nextSwitch: { projectId: ProjectId; workspaceName: WorkspaceName } | null | undefined;
  const errors: string[] = [];

  for (const e of collectErrors) errors.push(e.message);
  for (const r of results) {
    if (r.wasActive) wasActive = true;
    if (r.nextSwitch !== undefined) nextSwitch = r.nextSwitch;
    if (r.error) errors.push(r.error);
  }

  return {
    wasActive,
    ...(nextSwitch !== undefined && { nextSwitch }),
    errors,
  };
}

function mergeRelease(
  results: readonly ReleaseHookResult[],
  collectErrors: readonly Error[]
): MergedRelease {
  let blockingProcesses: readonly BlockingProcess[] | undefined;
  let unblockPerformed: boolean | undefined;
  const errors: string[] = [];

  for (const e of collectErrors) errors.push(e.message);
  for (const r of results) {
    if (r.blockingProcesses !== undefined) blockingProcesses = r.blockingProcesses;
    if (r.unblockPerformed !== undefined) unblockPerformed = r.unblockPerformed;
    if (r.error) errors.push(r.error);
  }

  return {
    ...(blockingProcesses !== undefined && { blockingProcesses }),
    ...(unblockPerformed !== undefined && { unblockPerformed }),
    errors,
  };
}

function mergeDelete(
  results: readonly DeleteHookResult[],
  collectErrors: readonly Error[]
): MergedDelete {
  let reactiveBlockingProcesses: readonly BlockingProcess[] | undefined;
  const errors: string[] = [];

  for (const e of collectErrors) errors.push(e.message);
  for (const r of results) {
    if (r.reactiveBlockingProcesses) reactiveBlockingProcesses = r.reactiveBlockingProcesses;
    if (r.error) errors.push(r.error);
  }

  return {
    ...(reactiveBlockingProcesses && { reactiveBlockingProcesses }),
    errors,
  };
}

// =============================================================================
// Progress Callback Type
// =============================================================================

/**
 * Callback for emitting deletion progress events.
 */
export type DeletionProgressCallback = (progress: DeletionProgress) => void;

// =============================================================================
// Pipeline State (for progress emission)
// =============================================================================

interface PipelineState {
  readonly shutdown?: MergedShutdown;
  readonly release?: MergedRelease;
  readonly del?: MergedDelete;
}

// =============================================================================
// Operation
// =============================================================================

export class DeleteWorkspaceOperation implements Operation<
  DeleteWorkspaceIntent,
  { started: true }
> {
  readonly id = DELETE_WORKSPACE_OPERATION_ID;

  constructor(private readonly emitProgress: DeletionProgressCallback) {}

  async execute(ctx: OperationContext<DeleteWorkspaceIntent>): Promise<{ started: true }> {
    const { payload } = ctx.intent;
    const hookCtx: HookContext = { intent: ctx.intent };

    const emitEvent = (): void => {
      const event: WorkspaceDeletedEvent = {
        type: EVENT_WORKSPACE_DELETED,
        payload: {
          projectId: payload.projectId,
          workspaceName: payload.workspaceName,
          workspacePath: payload.workspacePath,
          projectPath: payload.projectPath,
        },
      };
      ctx.emit(event);
    };

    if (payload.force) {
      try {
        await this.runPipeline(ctx, hookCtx);
      } finally {
        // Force mode: always emit workspace:deleted for state cleanup
        emitEvent();
      }
    } else {
      const hasErrors = await this.runPipeline(ctx, hookCtx);

      // Normal mode: only emit if no errors
      if (!hasErrors) {
        emitEvent();
      }
    }

    return { started: true };
  }

  private async runPipeline(
    ctx: OperationContext<DeleteWorkspaceIntent>,
    hookCtx: HookContext
  ): Promise<boolean> {
    const { payload } = ctx.intent;

    // --- Shutdown ---
    const { results: shutdownResults, errors: shutdownCollectErrors } =
      await ctx.hooks.collect<ShutdownHookResult>("shutdown", hookCtx);
    const shutdown = mergeShutdown(shutdownResults, shutdownCollectErrors);
    this.emitPipelineProgress(payload, { shutdown });

    // Dispatch workspace:switch if deleted workspace was the active one
    if (shutdown.wasActive && !payload.skipSwitch) {
      const next = shutdown.nextSwitch;
      if (next) {
        try {
          const switchIntent: SwitchWorkspaceIntent = {
            type: INTENT_SWITCH_WORKSPACE,
            payload: {
              projectId: next.projectId,
              workspaceName: next.workspaceName,
              focus: true,
            },
          };
          await ctx.dispatch(switchIntent);
        } catch {
          // Best-effort: switch failure doesn't fail the deletion
        }
      } else {
        // No next workspace: emit workspace:switched(null) directly
        const nullEvent: WorkspaceSwitchedEvent = {
          type: EVENT_WORKSPACE_SWITCHED,
          payload: null,
        };
        ctx.emit(nullEvent);
      }
    }

    const shutdownFailed = shutdown.errors.length > 0;
    if (shutdownFailed && !payload.force) {
      this.emitPipelineProgress(payload, { shutdown }, true, true);
      return true;
    }

    // When removeWorktree is false, skip "release" and "delete" hooks (runtime teardown only)
    if (!payload.removeWorktree) {
      this.emitPipelineProgress(payload, { shutdown }, true, false);
      return false;
    }

    // --- Release ---
    const { results: releaseResults, errors: releaseCollectErrors } =
      await ctx.hooks.collect<ReleaseHookResult>("release", hookCtx);
    const release = mergeRelease(releaseResults, releaseCollectErrors);
    this.emitPipelineProgress(payload, { shutdown, release });

    const releaseFailed =
      release.errors.length > 0 ||
      (release.blockingProcesses !== undefined && release.blockingProcesses.length > 0);
    if (releaseFailed && !payload.force) {
      this.emitPipelineProgress(payload, { shutdown, release }, true, true);
      return true;
    }

    // --- Delete ---
    const { results: deleteResults, errors: deleteCollectErrors } =
      await ctx.hooks.collect<DeleteHookResult>("delete", hookCtx);
    const del = mergeDelete(deleteResults, deleteCollectErrors);

    // Merge reactive blocking processes into release for progress display
    const finalRelease =
      del.reactiveBlockingProcesses && del.reactiveBlockingProcesses.length > 0
        ? {
            ...release,
            blockingProcesses: release.blockingProcesses ?? del.reactiveBlockingProcesses,
          }
        : release;

    const deleteFailed = del.errors.length > 0;
    const hasErrors = shutdownFailed || releaseFailed || deleteFailed;
    this.emitPipelineProgress(payload, { shutdown, release: finalRelease, del }, true, hasErrors);
    return hasErrors;
  }

  /**
   * Build DeletionOperation[] from pipeline state and emit progress.
   */
  private emitPipelineProgress(
    payload: DeleteWorkspacePayload,
    state: PipelineState,
    completed = false,
    hasErrors = false
  ): void {
    const operations: DeletionOperation[] = [];

    // Unblock operations (prepended, from release hook)
    if (state.release?.unblockPerformed !== undefined) {
      const unblockType = payload.unblock;
      const hasUnblockError = state.release.errors.length > 0;
      if (unblockType === "kill") {
        operations.push({
          id: "killing-blockers",
          label: "Killing blocking tasks...",
          status: hasUnblockError
            ? "error"
            : state.release.unblockPerformed
              ? "done"
              : "in-progress",
          ...(hasUnblockError && { error: state.release.errors[0] }),
        });
      } else if (unblockType === "close") {
        operations.push({
          id: "closing-handles",
          label: "Closing blocking handles...",
          status: hasUnblockError
            ? "error"
            : state.release.unblockPerformed
              ? "done"
              : "in-progress",
          ...(hasUnblockError && { error: state.release.errors[0] }),
        });
      }
    }

    // Shutdown operations (always present)
    const shutdownStatus = this.hookPointStatus(state.shutdown);
    const shutdownError =
      state.shutdown && state.shutdown.errors.length > 0
        ? state.shutdown.errors.join("; ")
        : undefined;

    operations.push({
      id: "kill-terminals",
      label: "Terminating processes",
      status: shutdownStatus,
    });
    operations.push({
      id: "stop-server",
      label: "Stopping OpenCode server",
      status: shutdownStatus,
      ...(shutdownError && { error: shutdownError }),
    });
    operations.push({
      id: "cleanup-vscode",
      label: "Closing VS Code view",
      status: shutdownStatus,
      ...(shutdownError && { error: shutdownError }),
    });

    // Detection operation (conditional, from release hook)
    if (state.release?.blockingProcesses !== undefined) {
      const blockersFound = state.release.blockingProcesses.length > 0;
      operations.push({
        id: "detecting-blockers",
        label: "Detecting blocking processes...",
        status: blockersFound ? "error" : "done",
        ...(blockersFound && {
          error: `Blocked by ${state.release.blockingProcesses.length} process(es)`,
        }),
      });
    }

    // Delete operation (always present)
    const deleteStatus = this.hookPointStatus(state.del);
    const deleteError =
      state.del && state.del.errors.length > 0 ? state.del.errors.join("; ") : undefined;

    operations.push({
      id: "cleanup-workspace",
      label: "Removing workspace",
      status: deleteStatus,
      ...(deleteError && { error: deleteError }),
    });

    // Build blocking processes from release results
    const blockingProcesses =
      state.release?.blockingProcesses && state.release.blockingProcesses.length > 0
        ? state.release.blockingProcesses
        : undefined;

    this.emitProgress({
      workspacePath: payload.workspacePath as WorkspacePath,
      workspaceName: payload.workspaceName,
      projectId: payload.projectId,
      keepBranch: payload.keepBranch,
      operations,
      completed,
      hasErrors,
      ...(blockingProcesses !== undefined && { blockingProcesses }),
    });
  }

  private hookPointStatus(
    merged: { readonly errors: readonly string[] } | undefined
  ): "pending" | "done" | "error" {
    if (!merged) return "pending";
    return merged.errors.length > 0 ? "error" : "done";
  }
}
