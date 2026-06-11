/**
 * GetActiveWorkspaceOperation - Orchestrates active workspace queries.
 *
 * Runs the "get" hook point where the handler retrieves the current active
 * workspace from the ViewManager and resolves it to a WorkspaceRef.
 *
 * No provider dependencies - the hook handler does the actual work.
 * No domain events - this is a query operation.
 */

import type { Intent } from "./lib/types";
import type { Operation, OperationContext, HookContext } from "./lib/operation";
import type { WorkspaceRef } from "../shared/api/types";
import { throwHookErrors, lastDefined, requireResult } from "./lib/hook-helpers";

// =============================================================================
// Intent Types
// =============================================================================

export interface GetActiveWorkspaceIntent extends Intent<WorkspaceRef | null> {
  readonly type: "ui:get-active-workspace";
  readonly payload: Record<string, never>;
}

export const INTENT_GET_ACTIVE_WORKSPACE = "ui:get-active-workspace" as const;

// =============================================================================
// Operation
// =============================================================================

export const GET_ACTIVE_WORKSPACE_OPERATION_ID = "get-active-workspace";

/**
 * Per-handler result contract for the "get" hook point.
 * Each handler returns its contribution — the operation merges them.
 * `null` is a valid result (no active workspace).
 */
export interface GetActiveWorkspaceHookResult {
  readonly workspaceRef: WorkspaceRef | null;
}

export class GetActiveWorkspaceOperation implements Operation<
  GetActiveWorkspaceIntent,
  WorkspaceRef | null
> {
  readonly id = GET_ACTIVE_WORKSPACE_OPERATION_ID;

  async execute(ctx: OperationContext<GetActiveWorkspaceIntent>): Promise<WorkspaceRef | null> {
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
