/**
 * DeleteWorkspaceOperation - Orchestrates workspace deletion.
 *
 * Runs three hook points in sequence:
 * 1. "shutdown" - ViewModule (switch + destroy view), AgentModule (kill terminals, stop server, clear MCP/TUI)
 * 2. "release" - WindowsLockModule (detect + kill/close blockers) [Windows-only]
 * 3. "delete" - WorktreeModule (remove git worktree), CodeServerModule (delete .code-workspace file)
 *
 * Emits progress after each hook point, mapping hook context results to DeletionOperationId values.
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
// Hook Context
// =============================================================================

export const DELETE_WORKSPACE_OPERATION_ID = "delete-workspace";

/**
 * Extended hook context for delete-workspace.
 *
 * Fields are populated by hook modules across three hook points:
 * - "shutdown": shutdownResults (ViewModule + AgentModule)
 * - "release": releaseResults (WindowsLockModule)
 * - "delete": deleteResults (WorktreeModule + CodeServerModule)
 */
export interface DeleteWorkspaceHookContext extends HookContext {
  readonly intent: DeleteWorkspaceIntent;
  readonly projectId: ProjectId;
  readonly projectPath: string;
  readonly workspacePath: string;
  readonly workspaceName: WorkspaceName;
  readonly keepBranch: boolean;
  readonly force: boolean;
  readonly removeWorktree: boolean;
  readonly skipSwitch?: boolean;
  readonly unblock?: "kill" | "close" | "ignore";
  readonly isRetry?: boolean;

  shutdownResults?: {
    terminalsClosed?: boolean;
    serverStopped?: boolean;
    serverError?: string;
    viewDestroyed?: boolean;
    viewError?: string;
    switchedWorkspace?: boolean;
    /** Set by hook: true if deleted workspace was the active one */
    wasActive?: boolean;
    /** Set by hook: next workspace to switch to (projectId + workspaceName) or null if none */
    nextSwitch?: { projectId: ProjectId; workspaceName: WorkspaceName } | null;
  };
  releaseResults?: {
    blockersDetected?: boolean;
    blockingProcesses?: readonly BlockingProcess[];
    unblockPerformed?: boolean;
    unblockError?: string;
  };
  deleteResults?: {
    worktreeRemoved?: boolean;
    worktreeError?: string;
    workspaceFileDeleted?: boolean;
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

    const hookCtx: DeleteWorkspaceHookContext = {
      intent: ctx.intent,
      projectId: payload.projectId,
      projectPath: payload.projectPath,
      workspacePath: payload.workspacePath,
      workspaceName: payload.workspaceName,
      keepBranch: payload.keepBranch,
      force: payload.force,
      removeWorktree: payload.removeWorktree,
      ...(payload.skipSwitch !== undefined && { skipSwitch: payload.skipSwitch }),
      ...(payload.unblock !== undefined && { unblock: payload.unblock }),
      ...(payload.isRetry !== undefined && { isRetry: payload.isRetry }),
    };

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
        await this.executeHooks(ctx, hookCtx);
      } finally {
        // Force mode: always emit workspace:deleted for state cleanup
        emitEvent();
      }
    } else {
      await this.executeHooks(ctx, hookCtx);

      // Normal mode: only emit if no errors
      if (!hookCtx.error) {
        emitEvent();
      }
    }

    return { started: true };
  }

  private async executeHooks(
    ctx: OperationContext<DeleteWorkspaceIntent>,
    hookCtx: DeleteWorkspaceHookContext
  ): Promise<void> {
    const { payload } = ctx.intent;

    // Initialize results
    hookCtx.shutdownResults = {};
    hookCtx.releaseResults = {};
    hookCtx.deleteResults = {};

    // Hook 1: "shutdown" -- ViewModule + AgentModule
    await ctx.hooks.run("shutdown", hookCtx);
    this.emitProgressFromContext(hookCtx);

    // Dispatch workspace:switch if deleted workspace was the active one
    if (hookCtx.shutdownResults?.wasActive && !hookCtx.skipSwitch) {
      const next = hookCtx.shutdownResults.nextSwitch;
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
          hookCtx.shutdownResults.switchedWorkspace = true;
        } catch {
          // Best-effort: switch failure doesn't fail the deletion
          hookCtx.shutdownResults.switchedWorkspace = false;
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

    // Check for error after shutdown (skip remaining hooks in non-force mode)
    if (hookCtx.error && !payload.force) {
      this.emitProgressFromContext(hookCtx, true, true);
      return;
    }
    // Clear error for next hook if force mode
    if (payload.force) {
      delete hookCtx.error;
    }

    // When removeWorktree is false, skip "release" and "delete" hooks (runtime teardown only)
    if (!payload.removeWorktree) {
      this.emitProgressFromContext(hookCtx, true, false);
      return;
    }

    // Hook 2: "release" -- WindowsLockModule
    await ctx.hooks.run("release", hookCtx);
    this.emitProgressFromContext(hookCtx);

    // Check for error after release (skip delete hook)
    if (hookCtx.error && !payload.force) {
      this.emitProgressFromContext(hookCtx, true, true);
      return;
    }
    if (payload.force) {
      delete hookCtx.error;
    }

    // Hook 3: "delete" -- WorktreeModule + CodeServerModule
    await ctx.hooks.run("delete", hookCtx);

    // Final progress
    const hasErrors =
      !!hookCtx.error ||
      !!hookCtx.shutdownResults?.serverError ||
      !!hookCtx.shutdownResults?.viewError ||
      !!hookCtx.releaseResults?.unblockError ||
      !!hookCtx.deleteResults?.worktreeError;
    this.emitProgressFromContext(hookCtx, true, hasErrors);
  }

  /**
   * Build DeletionOperation[] from hook context and emit progress.
   */
  private emitProgressFromContext(
    hookCtx: DeleteWorkspaceHookContext,
    completed = false,
    hasErrors = false
  ): void {
    const operations: DeletionOperation[] = [];

    // Unblock operations (prepended, from release hook)
    if (hookCtx.releaseResults?.unblockPerformed !== undefined) {
      const unblockType = hookCtx.unblock;
      if (unblockType === "kill") {
        operations.push({
          id: "killing-blockers",
          label: "Killing blocking tasks...",
          status: hookCtx.releaseResults.unblockError
            ? "error"
            : hookCtx.releaseResults.unblockPerformed
              ? "done"
              : "in-progress",
          ...(hookCtx.releaseResults.unblockError !== undefined && {
            error: hookCtx.releaseResults.unblockError,
          }),
        });
      } else if (unblockType === "close") {
        operations.push({
          id: "closing-handles",
          label: "Closing blocking handles...",
          status: hookCtx.releaseResults.unblockError
            ? "error"
            : hookCtx.releaseResults.unblockPerformed
              ? "done"
              : "in-progress",
          ...(hookCtx.releaseResults.unblockError !== undefined && {
            error: hookCtx.releaseResults.unblockError,
          }),
        });
      }
    }

    // Shutdown operations (always present)
    operations.push({
      id: "kill-terminals",
      label: "Terminating processes",
      status: this.resolveStatus(hookCtx.shutdownResults?.terminalsClosed),
    });
    operations.push({
      id: "stop-server",
      label: "Stopping OpenCode server",
      status: hookCtx.shutdownResults?.serverError
        ? "error"
        : this.resolveStatus(hookCtx.shutdownResults?.serverStopped),
      ...(hookCtx.shutdownResults?.serverError !== undefined && {
        error: hookCtx.shutdownResults.serverError,
      }),
    });
    operations.push({
      id: "cleanup-vscode",
      label: "Closing VS Code view",
      status: hookCtx.shutdownResults?.viewError
        ? "error"
        : this.resolveStatus(hookCtx.shutdownResults?.viewDestroyed),
      ...(hookCtx.shutdownResults?.viewError !== undefined && {
        error: hookCtx.shutdownResults.viewError,
      }),
    });

    // Detection operation (conditional, after cleanup-vscode)
    if (hookCtx.releaseResults?.blockersDetected !== undefined) {
      const blockersFound =
        hookCtx.releaseResults.blockingProcesses &&
        hookCtx.releaseResults.blockingProcesses.length > 0;
      operations.push({
        id: "detecting-blockers",
        label: "Detecting blocking processes...",
        status: blockersFound
          ? "error"
          : hookCtx.releaseResults.blockersDetected
            ? "done"
            : "in-progress",
        ...(blockersFound && {
          error: `Blocked by ${hookCtx.releaseResults.blockingProcesses!.length} process(es)`,
        }),
      });
    }

    // Delete operation (always present)
    operations.push({
      id: "cleanup-workspace",
      label: "Removing workspace",
      status: hookCtx.deleteResults?.worktreeError
        ? "error"
        : this.resolveStatus(hookCtx.deleteResults?.worktreeRemoved),
      ...(hookCtx.deleteResults?.worktreeError !== undefined && {
        error: hookCtx.deleteResults.worktreeError,
      }),
    });

    // Build blocking processes from release results
    const blockingProcesses =
      hookCtx.releaseResults?.blockingProcesses &&
      hookCtx.releaseResults.blockingProcesses.length > 0
        ? hookCtx.releaseResults.blockingProcesses
        : undefined;

    this.emitProgress({
      workspacePath: hookCtx.workspacePath as WorkspacePath,
      workspaceName: hookCtx.workspaceName,
      projectId: hookCtx.projectId,
      keepBranch: hookCtx.keepBranch,
      operations,
      completed,
      hasErrors,
      ...(blockingProcesses !== undefined && { blockingProcesses }),
    });
  }

  private resolveStatus(value: boolean | undefined): "pending" | "in-progress" | "done" {
    if (value === undefined) {
      return "pending";
    }
    return value ? "done" : "in-progress";
  }
}
