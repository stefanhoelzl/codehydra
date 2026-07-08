/**
 * GetActiveWorkspaceOperation - Orchestrates active workspace queries.
 *
 * Runs the "get" hook point where the handler retrieves the current active
 * workspace from the ViewManager and resolves it to a WorkspaceRef.
 *
 * No provider dependencies - the hook handler does the actual work.
 * No domain events - this is a query operation.
 *
 * Contract schemas (item 2): zod is the single source of truth. The payload/result/hook
 * schemas are declared once and hung on the operation's `schemas` field; the `Intent` and
 * result types are **derived** from that bundle via `IntentOf`/`z.infer`.
 */

import { z } from "zod/v4";
import type { Operation, OperationContext, OperationSchemas, HookContext } from "./lib/operation";
import { type IntentOf } from "./lib/operation";
import { workspaceRefSchema } from "./contract";
import { throwHookErrors, lastDefined, requireResult } from "./lib/hook-helpers";

export const INTENT_GET_ACTIVE_WORKSPACE = "ui:get-active-workspace" as const;
export const GET_ACTIVE_WORKSPACE_OPERATION_ID = "get-active-workspace";

// =============================================================================
// Contract schemas (single source of truth)
// =============================================================================

export const getActiveWorkspacePayloadSchema = z.object({}).readonly();

export const getActiveWorkspaceResultSchema = workspaceRefSchema.nullable();

/**
 * Per-handler result contract for the "get" hook point.
 * Each handler returns its contribution — the operation merges them.
 * `null` is a valid result (no active workspace).
 */
export const getActiveWorkspaceHookResultSchema = z
  .object({
    workspaceRef: workspaceRefSchema.nullable().optional(),
  })
  .readonly();

const schemas = {
  type: INTENT_GET_ACTIVE_WORKSPACE,
  payload: getActiveWorkspacePayloadSchema,
  result: getActiveWorkspaceResultSchema,
  hooks: {
    get: { result: getActiveWorkspaceHookResultSchema },
  },
} satisfies OperationSchemas;

// =============================================================================
// Types derived from the schemas
// =============================================================================

export type GetActiveWorkspacePayload = z.infer<typeof getActiveWorkspacePayloadSchema>;
export type GetActiveWorkspaceResult = z.infer<typeof getActiveWorkspaceResultSchema>;
export type GetActiveWorkspaceIntent = IntentOf<typeof schemas>;
export type GetActiveWorkspaceHookResult = z.infer<typeof getActiveWorkspaceHookResultSchema>;

// =============================================================================
// Operation
// =============================================================================

export class GetActiveWorkspaceOperation implements Operation<typeof schemas> {
  readonly id = GET_ACTIVE_WORKSPACE_OPERATION_ID;
  readonly schemas = schemas;

  async execute(
    ctx: OperationContext<GetActiveWorkspaceIntent>
  ): Promise<GetActiveWorkspaceResult> {
    const hookCtx: HookContext = {
      intent: ctx.intent,
    };

    // Run "get" hook -- handler retrieves active workspace ref
    const { results, errors } = await ctx.hooks.collect<GetActiveWorkspaceHookResult>(
      "get",
      hookCtx
    );
    throwHookErrors(errors, "get-active-workspace get hooks failed");

    // Merge results — last-write-wins for workspaceRef
    return requireResult(
      lastDefined(results, (r) => r.workspaceRef),
      "Get active workspace hook did not provide workspaceRef result"
    );
  }
}
