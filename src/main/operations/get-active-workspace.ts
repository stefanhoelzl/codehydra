/**
 * GetActiveWorkspaceOperation - Orchestrates active workspace queries.
 *
 * Runs the "get" hook point where the handler retrieves the current active
 * workspace from ViewManager and resolves it to a WorkspaceRef.
 *
 * No provider dependencies - the hook handler does the actual work.
 * No domain events - this is a query operation.
 */

import type { Intent } from "../intents/infrastructure/types";
import type { Operation, OperationContext, HookContext } from "../intents/infrastructure/operation";
import type { WorkspaceRef } from "../../shared/api/types";

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
 * Extended hook context for get-active-workspace.
 * The "get" hook handler populates `workspaceRef` with the result.
 * `undefined` means the hook didn't run (error).
 * `null` is a valid result (no active workspace).
 */
export interface GetActiveWorkspaceHookContext extends HookContext {
  workspaceRef?: WorkspaceRef | null;
}

export class GetActiveWorkspaceOperation implements Operation<
  GetActiveWorkspaceIntent,
  WorkspaceRef | null
> {
  readonly id = GET_ACTIVE_WORKSPACE_OPERATION_ID;

  async execute(ctx: OperationContext<GetActiveWorkspaceIntent>): Promise<WorkspaceRef | null> {
    const hookCtx: GetActiveWorkspaceHookContext = {
      intent: ctx.intent,
    };

    // Run "get" hook -- handler retrieves active workspace ref
    await ctx.hooks.run("get", hookCtx);

    // Check for errors from hook handlers
    if (hookCtx.error) {
      throw hookCtx.error;
    }

    if (hookCtx.workspaceRef === undefined) {
      throw new Error("Get active workspace hook did not provide workspaceRef result");
    }

    return hookCtx.workspaceRef;
  }
}
