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
 *    keepBranch=false, ignoreWarnings=true) when removeAll holds
 *
 * removeLocalRepo implies removeAll (step 4's invariant): deleting the
 * project's directory orphans every worktree, and `git worktree remove` can
 * only run while the repository still exists. A non-interactive dispatch has
 * no confirm hook to establish removeAll, so removeLocalRepo with any
 * workspace present is rejected outright rather than silently orphaning them.
 * 5. "close" - Disposes provider, removes state + store, clears active workspace
 *
 * Emits project:closed after close hook completes. A canceled confirm or a
 * thrown error emits project:close-failed instead ("the dispatch ended
 * without closing") so the per-key idempotency guard resets.
 *
 * No provider dependencies - hook handlers do the actual work.
 *
 * Contract schemas (item 2): zod is the single source of truth. The payload/hook/event
 * schemas are declared once and hung on the operation's `schemas` field; the `Intent` and
 * result types are **derived** from that bundle via `IntentOf`/`z.infer` — never restated.
 */

import { z } from "zod/v4";
import type { DomainEvent } from "./lib/types";
import type { Operation, OperationContext, OperationSchemas, HookContext } from "./lib/operation";
import { type IntentOf } from "./lib/operation";
import {
  hookCtxSchema,
  projectIdSchema,
  projectPathSchema,
  projectRefSchema,
  workspaceTargetShape,
} from "./contract";
import type { ProjectRef } from "./contract";
import { INTENT_DELETE_WORKSPACE, type DeleteWorkspaceIntent } from "./delete-workspace";
import { INTENT_SWITCH_WORKSPACE, type SwitchWorkspaceIntent } from "./switch-workspace";
import { INTENT_RESOLVE_PROJECT, type ResolveProjectIntent } from "./resolve-project";
import { throwHookErrors, onlyDefined } from "./lib/hook-helpers";

export const INTENT_CLOSE_PROJECT = "project:close" as const;
export const CLOSE_PROJECT_OPERATION_ID = "close-project";

export const EVENT_PROJECT_CLOSED = "project:closed" as const;

/**
 * Emitted when a project:close dispatch ends without closing the project —
 * an error (before rethrow) or a canceled interactive confirm. Sole consumer
 * is the idempotency module: it resets the per-projectPath guard so the
 * project can be close-requested again.
 */
export const EVENT_PROJECT_CLOSE_FAILED = "project:close-failed" as const;

// =============================================================================
// Contract schemas (single source of truth)
// =============================================================================

export const closeProjectPayloadSchema = z
  .object({
    projectRef: projectRefSchema,
    /**
     * Delete the project's own directory from disk — the clone for a project
     * opened from a URL, the user's own working copy for a local one. Implies
     * removeAll; see the file header for why, and for why a non-interactive
     * dispatch rejects it while workspaces exist.
     */
    removeLocalRepo: z.boolean().optional(),
    /**
     * The dispatch is user-interactive: the "confirm" hook point runs after
     * resolve, parking the dispatch on a confirmation dialog that contributes
     * removeAll/removeLocalRepo or cancels. Programmatic callers omit it and
     * never see a dialog.
     */
    interactive: z.boolean().optional(),
  })
  .readonly();

// -----------------------------------------------------------------------------
// Event payload schemas (events this file owns)
// -----------------------------------------------------------------------------

export const projectClosedPayloadSchema = z
  .object({
    projectId: projectIdSchema,
    /**
     * The closed project's ref. Carried so the per-project idempotency guard
     * (keyed by projectRef) resets on this success event — not just on
     * project:close-failed. Without it, getKey(payload) is undefined and a
     * successfully-closed-then-reopened project can never be closed again.
     */
    projectRef: projectRefSchema,
  })
  .readonly();

export const projectCloseFailedPayloadSchema = z
  .object({
    projectRef: projectRefSchema,
  })
  .readonly();

// -----------------------------------------------------------------------------
// Hook result schemas
// -----------------------------------------------------------------------------

/** The project a close's hook points act on: its ref, and the path it resolved to. */
const projectTargetShape = { projectRef: projectRefSchema, projectPath: projectPathSchema };

/** A workspace of the project being closed. */
const closingWorkspaceSchema = z.object(workspaceTargetShape).readonly();

/** Per-handler result contract for the "resolve" hook point. */
export const closeResolveHookResultSchema = z
  .object({
    remoteUrl: z.string().optional(),
    workspaces: z.array(closingWorkspaceSchema).readonly().optional(),
  })
  .readonly();

/**
 * Per-handler result for the "confirm" hook point. canceled aborts the
 * dispatch (project:close-failed is emitted so the idempotency guard resets);
 * otherwise removeAll upgrades the per-workspace teardown to full deletion
 * and removeLocalRepo overrides the payload.
 */
export const closeConfirmHookResultSchema = z
  .object({
    canceled: z.boolean().optional(),
    removeAll: z.boolean().optional(),
    removeLocalRepo: z.boolean().optional(),
  })
  .readonly();

/**
 * Per-handler result contract for the "close" hook point.
 * Side-effect handlers return `{}`.
 */
export const closeHookResultSchema = z
  .object({
    otherProjectsExist: z.boolean().optional(),
  })
  .readonly();

// -----------------------------------------------------------------------------
// Hook input enrichment + whole-context schemas
// -----------------------------------------------------------------------------

/** Operation-added enrichment for the "confirm" hook point (interactive dispatches only). */
const closeConfirmEnrichmentSchema = z.object({
  ...projectTargetShape,
  remoteUrl: z.string().optional(),
  workspaces: z.array(closingWorkspaceSchema).readonly(),
});

/** Runtime whole-context validation schema for "confirm". */
export const closeConfirmHookInputSchema = hookCtxSchema(
  closeProjectPayloadSchema,
  closeConfirmEnrichmentSchema.shape
);

/** Operation-added enrichment for the "close" hook point. */
const closeEnrichmentSchema = z.object({
  ...projectTargetShape,
  remoteUrl: z.string().optional(),
  removeLocalRepo: z.boolean(),
});

/** Runtime whole-context validation schema for "close". */
export const closeHookInputSchema = hookCtxSchema(
  closeProjectPayloadSchema,
  closeEnrichmentSchema.shape
);

/** Operation-added enrichment for the "resolve" hook point. */
const closeResolveEnrichmentSchema = z.object(projectTargetShape);

/** Runtime whole-context validation schema for "resolve". */
const closeResolveHookInputSchema = hookCtxSchema(
  closeProjectPayloadSchema,
  closeResolveEnrichmentSchema.shape
);

/**
 * This operation's contract bundle. Exported so consumers (and tests) can take a typed view
 * of its hook points and events via `ResolvedHooks<typeof schemas>` / `EventOf<typeof schemas>`.
 */
export const schemas = {
  type: INTENT_CLOSE_PROJECT,
  payload: closeProjectPayloadSchema,
  hooks: {
    resolve: { input: closeResolveHookInputSchema, result: closeResolveHookResultSchema },
    confirm: { input: closeConfirmHookInputSchema, result: closeConfirmHookResultSchema },
    close: { input: closeHookInputSchema, result: closeHookResultSchema },
  },
  events: {
    [EVENT_PROJECT_CLOSED]: projectClosedPayloadSchema,
    [EVENT_PROJECT_CLOSE_FAILED]: projectCloseFailedPayloadSchema,
  },
} satisfies OperationSchemas;

// =============================================================================
// Types derived from the schemas
// =============================================================================

export type CloseProjectPayload = z.infer<typeof closeProjectPayloadSchema>;
export type CloseProjectIntent = IntentOf<typeof schemas>;

export type ProjectClosedPayload = z.infer<typeof projectClosedPayloadSchema>;
export type ProjectCloseFailedPayload = z.infer<typeof projectCloseFailedPayloadSchema>;

export type CloseResolveHookResult = z.infer<typeof closeResolveHookResultSchema>;
export type CloseConfirmHookResult = z.infer<typeof closeConfirmHookResultSchema>;
export type CloseHookResult = z.infer<typeof closeHookResultSchema>;

/** Input context for "resolve" handlers: the project, resolved. */
export type CloseResolveHookInput = HookContext & z.infer<typeof closeResolveEnrichmentSchema>;

/**
 * Input context for the "confirm" hook handler (interactive dispatches only)
 * — built by the operation from resolve results, carrying what the
 * confirmation dialog renders.
 */
export type CloseConfirmHookInput = HookContext & z.infer<typeof closeConfirmEnrichmentSchema>;

/**
 * Input context for "close" hook handlers — built by the operation from resolve results.
 */
export type CloseHookInput = HookContext & z.infer<typeof closeEnrichmentSchema>;

export interface ProjectClosedEvent extends DomainEvent {
  readonly type: typeof EVENT_PROJECT_CLOSED;
  readonly payload: ProjectClosedPayload;
}

export interface ProjectCloseFailedEvent extends DomainEvent {
  readonly type: typeof EVENT_PROJECT_CLOSE_FAILED;
  readonly payload: ProjectCloseFailedPayload;
}

// =============================================================================
// Operation
// =============================================================================

export class CloseProjectOperation implements Operation<typeof schemas> {
  readonly id = CLOSE_PROJECT_OPERATION_ID;
  readonly schemas = schemas;

  async execute(ctx: OperationContext<CloseProjectIntent, typeof schemas>): Promise<void> {
    const { payload } = ctx.intent;
    const projectRef = payload.projectRef;

    try {
      await this.run(ctx);
    } catch (error) {
      // The dispatch ended without closing — reset the idempotency guard.
      this.emitCloseFailed(ctx, projectRef);
      throw error;
    }
  }

  private emitCloseFailed(
    ctx: OperationContext<CloseProjectIntent, typeof schemas>,
    projectRef: ProjectRef
  ): void {
    const event: ProjectCloseFailedEvent = {
      type: EVENT_PROJECT_CLOSE_FAILED,
      payload: { projectRef },
    };
    ctx.emit(event);
  }

  private async run(ctx: OperationContext<CloseProjectIntent, typeof schemas>): Promise<void> {
    const { payload } = ctx.intent;
    const projectRef = payload.projectRef;

    // 1. Dispatch project:resolve to get projectId and the project's path
    const projResolved = await ctx.dispatch<ResolveProjectIntent>({
      type: INTENT_RESOLVE_PROJECT,
      payload: { projectRef },
    });
    const { projectId, projectPath } = projResolved;

    // 2. Run "resolve" hook -- returns remoteUrl, workspaces
    const hookCtx: CloseResolveHookInput = { intent: ctx.intent, projectRef, projectPath };
    const { results: resolveResults, errors: resolveErrors } = await ctx.hooks.collect(
      "resolve",
      hookCtx
    );
    throwHookErrors(resolveErrors, "close-project resolve hooks failed");

    // Merge resolve results — one handler provides each field
    let removeLocalRepo = payload.removeLocalRepo ?? false;
    const remoteUrl = onlyDefined(resolveResults, "remoteUrl", "project:close resolve");
    const workspaces = onlyDefined(resolveResults, "workspaces", "project:close resolve") ?? [];

    // A non-interactive dispatch has no confirm hook, so nothing can raise
    // removeAll — deleting the directory would leave every worktree orphaned
    // (its .git file pointing into a repository that no longer exists) with
    // no way for CodeHydra to clean them up afterwards. Refuse instead.
    if (!payload.interactive && removeLocalRepo && workspaces.length > 0) {
      throw new Error(
        `Cannot remove the directory of a project that still has ${
          workspaces.length === 1 ? "1 workspace" : `${workspaces.length} workspaces`
        }: their worktrees would be left behind. Delete its workspaces first, ` +
          "or close the project from the app's Close Project dialog."
      );
    }

    // 3. Confirm (interactive dispatches only): park on the confirmation
    // dialog. Canceled = clean abort; the close-failed emission resets the
    // idempotency guard.
    let removeAll = false;
    if (payload.interactive) {
      const confirmCtx: CloseConfirmHookInput = {
        intent: ctx.intent,
        projectRef,
        projectPath,
        ...(remoteUrl !== undefined && { remoteUrl }),
        workspaces,
      };
      const { results: confirmResults, errors: confirmErrors } = await ctx.hooks.collect(
        "confirm",
        confirmCtx
      );
      throwHookErrors(confirmErrors, "close-project confirm hooks failed");
      if (confirmResults.some((r) => r.canceled)) {
        this.emitCloseFailed(ctx, projectRef);
        return;
      }
      removeAll = onlyDefined(confirmResults, "removeAll", "project:close confirm") ?? false;
      removeLocalRepo =
        onlyDefined(confirmResults, "removeLocalRepo", "project:close confirm") ?? removeLocalRepo;
    }

    // The invariant, enforced here rather than left to the dialog: a confirm
    // handler that contributes removeLocalRepo without removeAll cannot
    // reintroduce orphaned worktrees. The dialog's forced-checked, disabled
    // remove-all box displays this rule; it is not its only source.
    removeAll = removeAll || removeLocalRepo;

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
                workspaceRef: workspace.workspaceRef,
                keepBranch: false,
                force: false,
                removeWorktree: true,
                skipSwitch: true,
                ignoreWarnings: true,
              }
            : {
                workspaceRef: workspace.workspaceRef,
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
      projectRef,
      projectPath,
      removeLocalRepo,
      ...(remoteUrl !== undefined && { remoteUrl }),
    };
    const { results: closeResults, errors: closeErrors } = await ctx.hooks.collect(
      "close",
      closeHookInput
    );
    throwHookErrors(closeErrors, "close-project close hooks failed");

    // Merge close results — one handler provides otherProjectsExist
    const otherProjectsExist = onlyDefined(
      closeResults,
      "otherProjectsExist",
      "project:close close"
    );

    // 5. Deselect if no other projects remain.
    //
    // Dispatches workspace:switch(null) rather than emitting workspace:switched(null)
    // directly. `workspace:switched` is switch-workspace's event — an operation emits only
    // events it declares, and the dispatcher rejects a duplicate event-schema registration,
    // so this operation cannot own it. The switch operation's null path is the proper route
    // and is documented as idempotent: it runs the `activate` hooks with a null target (so
    // main-side active-workspace bookkeeping clears) and then announces. The extra handler
    // that runs is view-module's `activate`, which clears the same state the
    // `workspace:switched` event handler already clears — so the end state is unchanged.
    if (otherProjectsExist === false) {
      await ctx.dispatch<SwitchWorkspaceIntent>({
        type: INTENT_SWITCH_WORKSPACE,
        payload: { workspaceRef: null },
      });
    }

    // 6. Emit project:closed event
    const event: ProjectClosedEvent = {
      type: EVENT_PROJECT_CLOSED,
      payload: { projectId, projectRef },
    };
    ctx.emit(event);
  }
}
