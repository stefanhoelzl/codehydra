/**
 * CloseProjectOperation - Orchestrates project closing.
 *
 * Steps:
 * 1. Dispatches project:resolve to get projectId from projectPath
 * 2. "resolve" hook - Loads config (remoteUrl), gets workspace list
 * 3. "confirm" hook (interactive dispatches only) - parks on a confirmation
 *    dialog that may cancel or contribute removeAll/removeLocalRepo
 * 4. Dispatches workspace:delete per workspace — runtime teardown
 *    (removeWorktree=false) by default; full deletion (removeWorktree=true,
 *    keepBranch=false, ignoreWarnings=true) when the user confirmed removeAll
 * 5. "close" - Disposes provider, removes state + store, clears active workspace
 *
 * Emits project:closed after close hook completes. A canceled confirm or a
 * thrown error emits project:close-failed instead ("the dispatch ended
 * without closing") so the per-key idempotency guard resets.
 *
 * No provider dependencies - hook handlers do the actual work.
 */

import type { Intent, DomainEvent } from "./lib/types";
import type { Operation, OperationContext, HookContext } from "./lib/operation";
import type { ProjectId } from "../shared/api/types";
import { INTENT_DELETE_WORKSPACE, type DeleteWorkspaceIntent } from "./delete-workspace";
import { EVENT_WORKSPACE_SWITCHED, type WorkspaceSwitchedEvent } from "./switch-workspace";
import { INTENT_RESOLVE_PROJECT, type ResolveProjectIntent } from "./resolve-project";
import { throwHookErrors, lastDefined } from "./lib/hook-helpers";

// =============================================================================
// Intent Types
// =============================================================================

export interface CloseProjectPayload {
  readonly projectPath: string;
  readonly removeLocalRepo?: boolean;
  /**
   * The dispatch is user-interactive: the "confirm" hook point runs after
   * resolve, parking the dispatch on a confirmation dialog that contributes
   * removeAll/removeLocalRepo or cancels. Programmatic callers omit it and
   * never see a dialog.
   */
  readonly interactive?: boolean;
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

/**
 * Emitted when a project:close dispatch ends without closing the project —
 * an error (before rethrow) or a canceled interactive confirm. Sole consumer
 * is the idempotency module: it resets the per-projectPath guard so the
 * project can be close-requested again.
 */
export const EVENT_PROJECT_CLOSE_FAILED = "project:close-failed" as const;

export interface ProjectCloseFailedPayload {
  readonly projectPath: string;
}

export interface ProjectCloseFailedEvent extends DomainEvent {
  readonly type: typeof EVENT_PROJECT_CLOSE_FAILED;
  readonly payload: ProjectCloseFailedPayload;
}

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
 * Input context for the "confirm" hook handler (interactive dispatches only)
 * — built by the operation from resolve results, carrying what the
 * confirmation dialog renders.
 */
export interface CloseConfirmHookInput extends HookContext {
  readonly projectPath: string;
  readonly remoteUrl?: string;
  readonly workspaces: ReadonlyArray<{ path: string }>;
}

/**
 * Per-handler result for the "confirm" hook point. canceled aborts the
 * dispatch (project:close-failed is emitted so the idempotency guard resets);
 * otherwise removeAll upgrades the per-workspace teardown to full deletion
 * and removeLocalRepo overrides the payload.
 */
export interface CloseConfirmHookResult {
  readonly canceled?: boolean;
  readonly removeAll?: boolean;
  readonly removeLocalRepo?: boolean;
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

    try {
      await this.run(ctx);
    } catch (error) {
      // The dispatch ended without closing — reset the idempotency guard.
      this.emitCloseFailed(ctx, projectPath);
      throw error;
    }
  }

  private emitCloseFailed(ctx: OperationContext<CloseProjectIntent>, projectPath: string): void {
    const event: ProjectCloseFailedEvent = {
      type: EVENT_PROJECT_CLOSE_FAILED,
      payload: { projectPath },
    };
    ctx.emit(event);
  }

  private async run(ctx: OperationContext<CloseProjectIntent>): Promise<void> {
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
    throwHookErrors(resolveErrors, "close-project resolve hooks failed");

    // Merge resolve results — last-write-wins
    let removeLocalRepo = payload.removeLocalRepo ?? false;
    const remoteUrl = lastDefined(resolveResults, (r) => r.remoteUrl);
    const workspaces = lastDefined(resolveResults, (r) => r.workspaces) ?? [];

    // 3. Confirm (interactive dispatches only): park on the confirmation
    // dialog. Canceled = clean abort; the close-failed emission resets the
    // idempotency guard.
    let removeAll = false;
    if (payload.interactive) {
      const confirmCtx: CloseConfirmHookInput = {
        intent: ctx.intent,
        projectPath,
        ...(remoteUrl !== undefined && { remoteUrl }),
        workspaces,
      };
      const { results: confirmResults, errors: confirmErrors } =
        await ctx.hooks.collect<CloseConfirmHookResult>("confirm", confirmCtx);
      throwHookErrors(confirmErrors, "close-project confirm hooks failed");
      if (confirmResults.some((r) => r.canceled)) {
        this.emitCloseFailed(ctx, projectPath);
        return;
      }
      removeAll = lastDefined(confirmResults, (r) => r.removeAll) ?? false;
      removeLocalRepo = lastDefined(confirmResults, (r) => r.removeLocalRepo) ?? removeLocalRepo;
    }

    // 4. Dispatch workspace:delete per workspace. Default: runtime teardown
    // (removeWorktree=false). removeAll: full deletion including branches —
    // the user confirmed a dialog that says uncommitted changes are removed
    // too, so warnings are ignored.
    for (const workspace of workspaces) {
      try {
        const deleteIntent: DeleteWorkspaceIntent = {
          type: INTENT_DELETE_WORKSPACE,
          payload: removeAll
            ? {
                workspacePath: workspace.path,
                keepBranch: false,
                force: false,
                removeWorktree: true,
                skipSwitch: true,
                ignoreWarnings: true,
              }
            : {
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
    throwHookErrors(closeErrors, "close-project close hooks failed");

    // Merge close results — last-write-wins for otherProjectsExist
    const otherProjectsExist = lastDefined(closeResults, (r) => r.otherProjectsExist);

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
