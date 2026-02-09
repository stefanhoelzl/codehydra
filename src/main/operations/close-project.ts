/**
 * CloseProjectOperation - Orchestrates project closing.
 *
 * Runs two hook points in sequence:
 * 1. "resolve" - Resolves projectId to projectPath, loads config, gets workspace list
 * 2. Dispatches workspace:delete per workspace (removeWorktree=false, skipSwitch=true)
 * 3. "close" - Disposes provider, removes state + store, clears active workspace
 *
 * Emits project:closed after close hook completes.
 *
 * No provider dependencies - hook handlers do the actual work.
 */

import type { Intent, DomainEvent } from "../intents/infrastructure/types";
import type { Operation, OperationContext, HookContext } from "../intents/infrastructure/operation";
import type { ProjectId } from "../../shared/api/types";
import type { WorkspaceName } from "../../shared/api/types";
import { INTENT_DELETE_WORKSPACE, type DeleteWorkspaceIntent } from "./delete-workspace";
import { extractWorkspaceName } from "../api/id-utils";

// =============================================================================
// Intent Types
// =============================================================================

export interface CloseProjectPayload {
  readonly projectId: ProjectId;
  readonly removeLocalRepo?: boolean;
}

export interface CloseProjectIntent extends Intent<void> {
  readonly type: "project:close";
  readonly payload: CloseProjectPayload;
}

export const INTENT_CLOSE_PROJECT = "project:close" as const;

// =============================================================================
// Event Types
// =============================================================================

export interface ProjectClosedPayload {
  readonly projectId: ProjectId;
}

export interface ProjectClosedEvent extends DomainEvent {
  readonly type: "project:closed";
  readonly payload: ProjectClosedPayload;
}

export const EVENT_PROJECT_CLOSED = "project:closed" as const;

// =============================================================================
// Hook Context
// =============================================================================

export const CLOSE_PROJECT_OPERATION_ID = "close-project";

/**
 * Extended hook context for close-project.
 *
 * Fields are populated across hook points:
 * - "resolve" hook: projectPath, remoteUrl, removeLocalRepo, workspaces
 * - "close" hook: consumed by manager and registry modules
 */
export interface CloseProjectHookContext extends HookContext {
  /** Resolved project path (set by resolve hook) */
  projectPath?: string;
  /** Remote URL if this is a cloned project (set by resolve hook) */
  remoteUrl?: string;
  /** Whether to delete the local repo (set by resolve hook) */
  removeLocalRepo?: boolean;
  /** Workspaces to tear down (set by resolve hook) */
  workspaces?: ReadonlyArray<{ path: string }>;
}

// =============================================================================
// Operation
// =============================================================================

export class CloseProjectOperation implements Operation<CloseProjectIntent, void> {
  readonly id = CLOSE_PROJECT_OPERATION_ID;

  async execute(ctx: OperationContext<CloseProjectIntent>): Promise<void> {
    const { payload } = ctx.intent;

    const hookCtx: CloseProjectHookContext = {
      intent: ctx.intent,
    };

    // 1. Run "resolve" hook -- populates projectPath, remoteUrl, workspaces
    await ctx.hooks.run("resolve", hookCtx);

    if (hookCtx.error) {
      throw hookCtx.error;
    }

    // Validate required fields from resolve hook
    if (!hookCtx.projectPath) {
      throw new Error("Resolve hook did not provide projectPath");
    }

    const workspaces = hookCtx.workspaces ?? [];

    // 2. Dispatch workspace:delete per workspace (removeWorktree=false, skipSwitch=true)
    for (const workspace of workspaces) {
      try {
        const deleteIntent: DeleteWorkspaceIntent = {
          type: INTENT_DELETE_WORKSPACE,
          payload: {
            projectId: payload.projectId,
            workspaceName: extractWorkspaceName(workspace.path) as WorkspaceName,
            workspacePath: workspace.path,
            projectPath: hookCtx.projectPath,
            keepBranch: true,
            force: true,
            removeWorktree: false,
            skipSwitch: true,
          },
        };
        await ctx.dispatch(deleteIntent);
      } catch {
        // Best-effort: individual workspace:delete failures don't fail the project close
      }
    }

    // 3. Run "close" hook (dispose provider, remove state + store, clear active workspace)
    await ctx.hooks.run("close", hookCtx);

    if (hookCtx.error) {
      throw hookCtx.error;
    }

    // 4. Emit project:closed event
    const event: ProjectClosedEvent = {
      type: EVENT_PROJECT_CLOSED,
      payload: { projectId: payload.projectId },
    };
    ctx.emit(event);
  }
}
