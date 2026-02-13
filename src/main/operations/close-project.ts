/**
 * CloseProjectOperation - Orchestrates project closing.
 *
 * Runs two hook points in sequence:
 * 1. "resolve-project" - Resolves projectId to projectPath, loads config, gets workspace list
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
import { EVENT_WORKSPACE_SWITCHED, type WorkspaceSwitchedEvent } from "./switch-workspace";
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
 * Per-handler result contract for the "resolve-project" hook point.
 */
export interface CloseResolveHookResult {
  readonly projectPath?: string;
  readonly remoteUrl?: string;
  readonly workspaces?: ReadonlyArray<{ path: string }>;
}

/**
 * Input context for "close" hook handlers — built by the operation from resolve results.
 */
export interface CloseHookInput extends HookContext {
  readonly projectPath: string;
  readonly remoteUrl?: string;
  readonly removeLocalRepo: boolean;
}

/**
 * Per-handler result contract for the "close" hook point.
 * Side-effect handlers return `{}`.
 */
export interface CloseHookResult {
  readonly otherProjectsExist?: boolean;
}

// =============================================================================
// Operation
// =============================================================================

export class CloseProjectOperation implements Operation<CloseProjectIntent, void> {
  readonly id = CLOSE_PROJECT_OPERATION_ID;

  async execute(ctx: OperationContext<CloseProjectIntent>): Promise<void> {
    const { payload } = ctx.intent;

    const hookCtx: HookContext = {
      intent: ctx.intent,
    };

    // 1. Run "resolve-project" hook -- returns projectPath, remoteUrl, workspaces
    const { results: resolveResults, errors: resolveErrors } =
      await ctx.hooks.collect<CloseResolveHookResult>("resolve-project", hookCtx);
    if (resolveErrors.length > 0) {
      throw resolveErrors[0]!;
    }

    // Merge resolve results — last-write-wins
    let projectPath: string | undefined;
    let remoteUrl: string | undefined;
    const removeLocalRepo = payload.removeLocalRepo ?? false;
    let workspaces: ReadonlyArray<{ path: string }> = [];
    for (const result of resolveResults) {
      if (result.projectPath !== undefined) projectPath = result.projectPath;
      if (result.remoteUrl !== undefined) remoteUrl = result.remoteUrl;
      if (result.workspaces !== undefined) workspaces = result.workspaces;
    }

    if (!projectPath) {
      throw new Error("Resolve hook did not provide projectPath");
    }

    // 2. Dispatch workspace:delete per workspace (removeWorktree=false, skipSwitch=true)
    for (const workspace of workspaces) {
      try {
        const deleteIntent: DeleteWorkspaceIntent = {
          type: INTENT_DELETE_WORKSPACE,
          payload: {
            projectId: payload.projectId,
            workspaceName: extractWorkspaceName(workspace.path) as WorkspaceName,
            workspacePath: workspace.path,
            projectPath,
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
    const closeHookInput: CloseHookInput = {
      intent: ctx.intent,
      projectPath,
      removeLocalRepo,
      ...(remoteUrl !== undefined && { remoteUrl }),
    };
    const { results: closeResults, errors: closeErrors } = await ctx.hooks.collect<CloseHookResult>(
      "close",
      closeHookInput
    );
    if (closeErrors.length > 0) {
      throw new AggregateError(closeErrors, "close-project close hooks failed");
    }

    // Merge close results — last-write-wins for otherProjectsExist
    let otherProjectsExist: boolean | undefined;
    for (const result of closeResults) {
      if (result.otherProjectsExist !== undefined) otherProjectsExist = result.otherProjectsExist;
    }

    // 4. Emit workspace:switched(null) if no other projects remain
    if (otherProjectsExist === false) {
      const nullEvent: WorkspaceSwitchedEvent = {
        type: EVENT_WORKSPACE_SWITCHED,
        payload: null,
      };
      ctx.emit(nullEvent);
    }

    // 5. Emit project:closed event
    const event: ProjectClosedEvent = {
      type: EVENT_PROJECT_CLOSED,
      payload: { projectId: payload.projectId },
    };
    ctx.emit(event);
  }
}
