/**
 * GetWorkspaceStatusOperation - Orchestrates workspace status queries.
 *
 * Runs two steps:
 * 1. Dispatch workspace:resolve to validate workspacePath
 * 2. "get" hook — each handler contributes a piece of the status
 *
 * No provider dependencies - hook handlers do the actual work.
 * No domain events - this is a query operation.
 *
 * Contract schemas (item 2): zod is the single source of truth; the Intent, result,
 * and hook types are derived from the `schemas` bundle.
 */

import { z } from "zod/v4";
import type { Operation, OperationContext, OperationSchemas, HookContext } from "./lib/operation";
import { type IntentOf } from "./lib/operation";
import {
  agentStatusChangedAtSchema,
  hookCtxSchema,
  workspaceClosingSchema,
  workspaceRefSchema,
  workspaceStatusSchema,
  workspaceTargetShape,
  workspaceWorkStatusShape,
} from "./contract";
import type { WorkspaceStatus } from "../shared/api/types";
import { resolveWorkspaceIdentity } from "./lib/workspace-identity";
import { INTENT_REFRESH_PROJECT, type RefreshProjectIntent } from "./refresh-project";
import { throwHookErrors, onlyDefined } from "./lib/hook-helpers";

export const INTENT_GET_WORKSPACE_STATUS = "workspace:get-status" as const;
export const GET_WORKSPACE_STATUS_OPERATION_ID = "get-workspace-status";

// =============================================================================
// Contract schemas (single source of truth)
// =============================================================================

export const getWorkspaceStatusPayloadSchema = z
  .object({
    workspaceRef: workspaceRefSchema,
    /**
     * If true, bring the project up to date with its upstream first
     * (project:refresh; git: a fetch) before reading status. Best-effort:
     * failures are swallowed and the status is read against what is cached.
     */
    refresh: z.boolean().optional(),
  })
  .readonly();

/**
 * Local schema for AggregatedAgentStatus (from shared/ipc) — not in contract.ts.
 * The discriminated union of internal agent-status shapes with `{ idle, busy }` counts.
 */
const internalAgentCountsSchema = z.object({ idle: z.number(), busy: z.number() }).readonly();
const aggregatedFields = {
  counts: internalAgentCountsSchema,
  changedAt: agentStatusChangedAtSchema,
};
const aggregatedAgentStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("none"), ...aggregatedFields }),
  z.object({ status: z.literal("idle"), ...aggregatedFields }),
  z.object({ status: z.literal("busy"), ...aggregatedFields }),
  z.object({ status: z.literal("mixed"), ...aggregatedFields }),
]);

/**
 * Per-handler result contract for the "get" hook point.
 * Each handler returns its contribution — the operation merges them. The work
 * status (`status`, `statusDescription`, `details`) comes from the workspace's
 * project type alone; the agent status from the agent module.
 */
export const getStatusHookResultSchema = z
  .object({
    ...workspaceWorkStatusShape,
    agentStatus: aggregatedAgentStatusSchema.optional(),
  })
  .readonly();

/**
 * Operation-added enrichment for the "get" hook point (beyond the base HookContext).
 *
 * `closing` is re-read immediately before the hook point runs, not at the start
 * of the operation — see the note in `execute`. Handlers that are about to touch
 * the workspace directory must honour it.
 */
const getStatusEnrichmentSchema = z.object({
  ...workspaceTargetShape,
  closing: workspaceClosingSchema.nullable(),
});

/** Runtime whole-context validation schema for "get". */
export const getStatusHookInputSchema = hookCtxSchema(
  getWorkspaceStatusPayloadSchema,
  getStatusEnrichmentSchema.shape
);

/**
 * This operation's contract bundle. Exported so consumers (and tests) can take a typed view
 * of its hook points and events via `ResolvedHooks<typeof schemas>` / `EventOf<typeof schemas>`.
 */
export const schemas = {
  type: INTENT_GET_WORKSPACE_STATUS,
  payload: getWorkspaceStatusPayloadSchema,
  result: workspaceStatusSchema,
  hooks: {
    get: { input: getStatusHookInputSchema, result: getStatusHookResultSchema },
  },
} satisfies OperationSchemas;

// =============================================================================
// Types derived from the schemas
// =============================================================================

export type GetWorkspaceStatusPayload = z.infer<typeof getWorkspaceStatusPayloadSchema>;
export type GetWorkspaceStatusIntent = IntentOf<typeof schemas>;
export type GetStatusHookResult = z.infer<typeof getStatusHookResultSchema>;

/** Whole input context for "get" handlers: base envelope + inferred enrichment. */
export type GetStatusHookInput = HookContext & z.infer<typeof getStatusEnrichmentSchema>;

// =============================================================================
// Operation
// =============================================================================

export class GetWorkspaceStatusOperation implements Operation<typeof schemas> {
  readonly id = GET_WORKSPACE_STATUS_OPERATION_ID;
  readonly schemas = schemas;

  async execute(
    ctx: OperationContext<GetWorkspaceStatusIntent, typeof schemas>
  ): Promise<WorkspaceStatus> {
    const { payload } = ctx.intent;

    // 1. Resolve the workspace
    const { projectRef } = await resolveWorkspaceIdentity(ctx.dispatch, payload.workspaceRef, {
      withProject: false,
    });

    // 2. Optional refresh — bring the project up to date with its upstream (git:
    // fetch) so unmerged-commit counts reflect server-merged branches.
    // Best-effort; errors are swallowed.
    if (payload.refresh) {
      try {
        await ctx.dispatch<RefreshProjectIntent>({
          type: INTENT_REFRESH_PROJECT,
          payload: { projectRef },
        });
      } catch {
        // Fall through to status read with possibly-stale refs.
      }
    }

    // 3. get — each handler contributes its piece.
    //
    // Re-resolve first, and deliberately here rather than reusing step 1: a
    // refresh runs `git fetch`, which has been measured at 20+ seconds against
    // a large remote. A workspace can enter teardown during that window, and a
    // handler that then spawns git inside the worktree makes `git worktree
    // remove` fail on Windows with "Permission denied" on the directory. The
    // freshness has to sit here, where the operation knows how long it just
    // spent, rather than being each handler's problem to remember.
    const { workspacePath, closing } = await resolveWorkspaceIdentity(
      ctx.dispatch,
      payload.workspaceRef,
      { withProject: false }
    );

    const getCtx: GetStatusHookInput = {
      intent: ctx.intent,
      workspaceRef: payload.workspaceRef,
      workspacePath,
      closing,
    };
    const { results, errors } = await ctx.hooks.collect("get", getCtx);
    throwHookErrors(errors, "get-workspace-status get hooks failed");

    // The work status is the project type's, whole: one handler answers it.
    const label = "workspace:get-status get";
    const status = onlyDefined(results, "status", label);
    const statusDescription = onlyDefined(results, "statusDescription", label);
    const details = onlyDefined(results, "details", label);
    const agentStatus = onlyDefined(results, "agentStatus", label);

    const finalAgentStatus = agentStatus ?? {
      status: "none" as const,
      counts: { idle: 0, busy: 0 },
    };

    const changedAt =
      finalAgentStatus.changedAt !== undefined ? { changedAt: finalAgentStatus.changedAt } : {};
    return {
      ...(status !== undefined && { status }),
      ...(statusDescription !== undefined && { statusDescription }),
      ...(details !== undefined && { details }),
      agent:
        finalAgentStatus.status === "none"
          ? { type: "none", ...changedAt }
          : {
              type: finalAgentStatus.status,
              counts: {
                idle: finalAgentStatus.counts.idle,
                busy: finalAgentStatus.counts.busy,
                total: finalAgentStatus.counts.idle + finalAgentStatus.counts.busy,
              },
              ...changedAt,
            },
    };
  }
}
