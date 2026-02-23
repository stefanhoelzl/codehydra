/**
 * CloseProjectOperation - Orchestrates project closing.
 *
 * Steps:
 * 1. Dispatches project:resolve to get projectId from projectPath
 * 2. "resolve" hook - Loads config (remoteUrl), gets workspace list
 * 3. Dispatches workspace:delete per workspace (removeWorktree=false, skipSwitch=true)
 * 4. "close" - Disposes provider, removes state + store, clears active workspace
 *
 * Emits project:closed after close hook completes.
 *
 * No provider dependencies - hook handlers do the actual work.
 */

import type { Intent, DomainEvent } from "../intents/infrastructure/types";
import type { Operation, OperationContext, HookContext } from "../intents/infrastructure/operation";
import type { ProjectId } from "../../shared/api/types";
import { INTENT_DELETE_WORKSPACE, type DeleteWorkspaceIntent } from "./delete-workspace";
import { EVENT_WORKSPACE_SWITCHED, type WorkspaceSwitchedEvent } from "./switch-workspace";
import { INTENT_RESOLVE_PROJECT, type ResolveProjectIntent } from "./resolve-project";

// =============================================================================
// Intent Types
// =============================================================================

export interface CloseProjectPayload {
  readonly projectPath: string;
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
 * Per-handler result contract for the "resolve" hook point.
 */
export interface CloseResolveHookResult {
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
    const projectPath = payload.projectPath;

    // 1. Dispatch project:resolve to get projectId from projectPath
    const projResolved = await ctx.dispatch({
      type: INTENT_RESOLVE_PROJECT,
      payload: { projectPath },
    } as ResolveProjectIntent);
    const projectId = projResolved.projectId;

    // 2. Run "resolve" hook -- returns remoteUrl, workspaces
    const hookCtx: HookContext = {
      intent: ctx.intent,
    };
    const { results: resolveResults, errors: resolveErrors } =
      await ctx.hooks.collect<CloseResolveHookResult>("resolve", hookCtx);
    if (resolveErrors.length > 0) {
      throw resolveErrors[0]!;
    }

    // Merge resolve results — last-write-wins
    let remoteUrl: string | undefined;
    const removeLocalRepo = payload.removeLocalRepo ?? false;
    let workspaces: ReadonlyArray<{ path: string }> = [];
    for (const result of resolveResults) {
      if (result.remoteUrl !== undefined) remoteUrl = result.remoteUrl;
      if (result.workspaces !== undefined) workspaces = result.workspaces;
    }

    // 3. Dispatch workspace:delete per workspace (removeWorktree=false, skipSwitch=true)
    for (const workspace of workspaces) {
      try {
        const deleteIntent: DeleteWorkspaceIntent = {
          type: INTENT_DELETE_WORKSPACE,
          payload: {
            workspacePath: workspace.path,
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

    // 4. Run "close" hook (dispose provider, remove state + store, clear active workspace)
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

    // 5. Emit workspace:switched(null) if no other projects remain
    if (otherProjectsExist === false) {
      const nullEvent: WorkspaceSwitchedEvent = {
        type: EVENT_WORKSPACE_SWITCHED,
        payload: null,
      };
      ctx.emit(nullEvent);
    }

    // 6. Emit project:closed event
    const event: ProjectClosedEvent = {
      type: EVENT_PROJECT_CLOSED,
      payload: { projectId },
    };
    ctx.emit(event);
  }
}
