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
 *
 * Contract schemas (item 2): zod is the single source of truth. The payload/hook/event
 * schemas are declared once and hung on the operation's `schemas` field; the `Intent` and
 * result types are **derived** from that bundle via `IntentOf`/`z.infer` — never restated.
 */

import { z } from "zod/v4";
import type { DomainEvent } from "./lib/types";
import type { Operation, OperationContext, OperationSchemas, HookContext } from "./lib/operation";
import { type IntentOf } from "./lib/operation";
import { hookCtxSchema, projectIdSchema, projectPathSchema, workspacePathSchema } from "./contract";
import type { ProjectPath } from "./contract";
import { INTENT_DELETE_WORKSPACE, type DeleteWorkspaceIntent } from "./delete-workspace";
import { INTENT_SWITCH_WORKSPACE, type SwitchWorkspaceIntent } from "./switch-workspace";
import { INTENT_RESOLVE_PROJECT, type ResolveProjectIntent } from "./resolve-project";
import { throwHookErrors, lastDefined } from "./lib/hook-helpers";

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
    projectPath: projectPathSchema,
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
     * The closed project's path. Carried so the per-projectPath idempotency
     * guard (keyed by projectPath) resets on this success event — not just on
     * project:close-failed. Without it, getKey(payload) is undefined and a
     * successfully-closed-then-reopened project can never be closed again.
     */
    projectPath: projectPathSchema,
  })
  .readonly();

export const projectCloseFailedPayloadSchema = z
  .object({
    projectPath: projectPathSchema,
  })
  .readonly();

// -----------------------------------------------------------------------------
// Hook result schemas
// -----------------------------------------------------------------------------

/** Per-handler result contract for the "resolve" hook point. */
export const closeResolveHookResultSchema = z
  .object({
    remoteUrl: z.string().optional(),
    workspaces: z
      .array(z.object({ path: workspacePathSchema }))
      .readonly()
      .optional(),
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
  projectPath: projectPathSchema,
  remoteUrl: z.string().optional(),
  workspaces: z.array(z.object({ path: workspacePathSchema })).readonly(),
});

/** Runtime whole-context validation schema for "confirm". */
export const closeConfirmHookInputSchema = hookCtxSchema(
  closeProjectPayloadSchema,
  closeConfirmEnrichmentSchema.shape
);

/** Operation-added enrichment for the "close" hook point. */
const closeEnrichmentSchema = z.object({
  projectPath: projectPathSchema,
  remoteUrl: z.string().optional(),
  removeLocalRepo: z.boolean(),
});

/** Runtime whole-context validation schema for "close". */
export const closeHookInputSchema = hookCtxSchema(
  closeProjectPayloadSchema,
  closeEnrichmentSchema.shape
);

/** The resolve hook point receives the bare intent. */
const bareCloseHookInputSchema = hookCtxSchema(closeProjectPayloadSchema, {});

/**
 * This operation's contract bundle. Exported so consumers (and tests) can take a typed view
 * of its hook points and events via `ResolvedHooks<typeof schemas>` / `EventOf<typeof schemas>`.
 */
export const schemas = {
  type: INTENT_CLOSE_PROJECT,
  payload: closeProjectPayloadSchema,
  hooks: {
    resolve: { input: bareCloseHookInputSchema, result: closeResolveHookResultSchema },
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
    const projectPath = payload.projectPath;

    try {
      await this.run(ctx);
    } catch (error) {
      // The dispatch ended without closing — reset the idempotency guard.
      this.emitCloseFailed(ctx, projectPath);
      throw error;
    }
  }

  private emitCloseFailed(
    ctx: OperationContext<CloseProjectIntent, typeof schemas>,
    projectPath: ProjectPath
  ): void {
    const event: ProjectCloseFailedEvent = {
      type: EVENT_PROJECT_CLOSE_FAILED,
      payload: { projectPath },
    };
    ctx.emit(event);
  }

  private async run(ctx: OperationContext<CloseProjectIntent, typeof schemas>): Promise<void> {
    const { payload } = ctx.intent;
    const projectPath = payload.projectPath;

    // 1. Dispatch project:resolve to get projectId from projectPath
    const projResolved = await ctx.dispatch<ResolveProjectIntent>({
      type: INTENT_RESOLVE_PROJECT,
      payload: { projectPath },
    });
    const projectId = projResolved.projectId;

    // 2. Run "resolve" hook -- returns remoteUrl, workspaces
    const hookCtx: HookContext = {
      intent: ctx.intent,
    };
    const { results: resolveResults, errors: resolveErrors } = await ctx.hooks.collect(
      "resolve",
      hookCtx
    );
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
      const { results: confirmResults, errors: confirmErrors } = await ctx.hooks.collect(
        "confirm",
        confirmCtx
      );
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
    const { results: closeResults, errors: closeErrors } = await ctx.hooks.collect(
      "close",
      closeHookInput
    );
    throwHookErrors(closeErrors, "close-project close hooks failed");

    // Merge close results — last-write-wins for otherProjectsExist
    const otherProjectsExist = lastDefined(closeResults, (r) => r.otherProjectsExist);

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
        payload: { workspacePath: null },
      });
    }

    // 6. Emit project:closed event
    const event: ProjectClosedEvent = {
      type: EVENT_PROJECT_CLOSED,
      payload: { projectId, projectPath },
    };
    ctx.emit(event);
  }
}
