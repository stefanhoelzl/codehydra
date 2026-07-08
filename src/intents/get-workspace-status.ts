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
import { workspaceStatusSchema, hookCtxSchema } from "./contract";
import type { WorkspaceStatus } from "../shared/api/types";
import type { AggregatedAgentStatus } from "../shared/ipc";
import { INTENT_RESOLVE_WORKSPACE, type ResolveWorkspaceIntent } from "./resolve-workspace";
import { INTENT_GET_PROJECT_BASES, type GetProjectBasesIntent } from "./get-project-bases";
import { throwHookErrors } from "./lib/hook-helpers";

export const INTENT_GET_WORKSPACE_STATUS = "workspace:get-status" as const;
export const GET_WORKSPACE_STATUS_OPERATION_ID = "get-workspace-status";

// =============================================================================
// Contract schemas (single source of truth)
// =============================================================================

export const getWorkspaceStatusPayloadSchema = z
  .object({
    workspacePath: z.string(),
    /**
     * If true, fetch remotes (via project:get-bases with refresh+wait) before
     * reading status. Best-effort: fetch failures are swallowed and the status
     * is read against possibly-stale local refs.
     */
    refresh: z.boolean().optional(),
  })
  .readonly();

/**
 * Local schema for AggregatedAgentStatus (from shared/ipc) — not in contract.ts.
 * The discriminated union of internal agent-status shapes with `{ idle, busy }` counts.
 */
const internalAgentCountsSchema = z.object({ idle: z.number(), busy: z.number() }).readonly();
const aggregatedAgentStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("none"), counts: internalAgentCountsSchema }),
  z.object({ status: z.literal("idle"), counts: internalAgentCountsSchema }),
  z.object({ status: z.literal("busy"), counts: internalAgentCountsSchema }),
  z.object({ status: z.literal("mixed"), counts: internalAgentCountsSchema }),
]);

/**
 * Per-handler result contract for the "get" hook point.
 * Each handler returns its contribution — the operation merges them.
 */
export const getStatusHookResultSchema = z
  .object({
    isDirty: z.boolean().optional(),
    unmergedCommits: z.number().optional(),
    agentStatus: aggregatedAgentStatusSchema.optional(),
  })
  .readonly();

/** Operation-added enrichment for the "get" hook point (beyond the base HookContext). */
const getStatusEnrichmentSchema = z.object({ workspacePath: z.string() });

/** Runtime whole-context validation schema for "get". */
export const getStatusHookInputSchema = hookCtxSchema(
  getWorkspaceStatusPayloadSchema,
  getStatusEnrichmentSchema.shape
);

const schemas = {
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

  async execute(ctx: OperationContext<GetWorkspaceStatusIntent>): Promise<WorkspaceStatus> {
    const { payload } = ctx.intent;

    // 1. Dispatch shared workspace resolution
    const { projectPath } = await ctx.dispatch({
      type: INTENT_RESOLVE_WORKSPACE,
      payload: { workspacePath: payload.workspacePath },
    } as ResolveWorkspaceIntent);

    // 2. Optional refresh — fetch remotes so unmerged-commit counts reflect
    // server-merged branches. Best-effort; errors are swallowed.
    if (payload.refresh) {
      try {
        await ctx.dispatch({
          type: INTENT_GET_PROJECT_BASES,
          payload: { projectPath, refresh: true, wait: true },
        } as GetProjectBasesIntent);
      } catch {
        // Fall through to status read with possibly-stale refs.
      }
    }

    // 3. get — each handler contributes its piece
    const getCtx: GetStatusHookInput = {
      intent: ctx.intent,
      workspacePath: payload.workspacePath,
    };
    const { results, errors } = await ctx.hooks.collect<GetStatusHookResult>("get", getCtx);
    throwHookErrors(errors, "get-workspace-status get hooks failed");

    // Merge results — isDirty uses OR, unmergedCommits uses max
    let isDirty = false;
    let unmergedCommits = 0;
    let agentStatus: AggregatedAgentStatus | undefined;

    for (const result of results) {
      if (result.isDirty) isDirty = true;
      if (result.unmergedCommits !== undefined && result.unmergedCommits > unmergedCommits) {
        unmergedCommits = result.unmergedCommits;
      }
      if (result.agentStatus !== undefined) agentStatus = result.agentStatus;
    }

    const finalAgentStatus = agentStatus ?? {
      status: "none" as const,
      counts: { idle: 0, busy: 0 },
    };

    return {
      isDirty,
      unmergedCommits,
      agent:
        finalAgentStatus.status === "none"
          ? { type: "none" }
          : {
              type: finalAgentStatus.status,
              counts: {
                idle: finalAgentStatus.counts.idle,
                busy: finalAgentStatus.counts.busy,
                total: finalAgentStatus.counts.idle + finalAgentStatus.counts.busy,
              },
            },
    };
  }
}
