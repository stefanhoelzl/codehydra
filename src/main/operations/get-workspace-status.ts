/**
 * GetWorkspaceStatusOperation - Orchestrates workspace status queries.
 *
 * Runs two hook points in sequence:
 * 1. "resolve" - Validates workspacePath is tracked, returns projectPath + workspaceName
 * 2. "get" - Each handler contributes a piece of the status
 *
 * No provider dependencies - hook handlers do the actual work.
 * No domain events - this is a query operation.
 */

import type { Intent } from "../intents/infrastructure/types";
import type { Operation, OperationContext, HookContext } from "../intents/infrastructure/operation";
import type { WorkspaceName, WorkspaceStatus } from "../../shared/api/types";
import type { AggregatedAgentStatus } from "../../shared/ipc";

// =============================================================================
// Intent Types
// =============================================================================

export interface GetWorkspaceStatusPayload {
  readonly workspacePath: string;
}

export interface GetWorkspaceStatusIntent extends Intent<WorkspaceStatus> {
  readonly type: "workspace:get-status";
  readonly payload: GetWorkspaceStatusPayload;
}

export const INTENT_GET_WORKSPACE_STATUS = "workspace:get-status" as const;

// =============================================================================
// Hook Types
// =============================================================================

export const GET_WORKSPACE_STATUS_OPERATION_ID = "get-workspace-status";

/** Input context for "resolve" handlers. */
export interface ResolveHookInput extends HookContext {
  readonly workspacePath: string;
}

/** Per-handler result for "resolve" hook point. */
export interface ResolveHookResult {
  readonly projectPath?: string;
  readonly workspaceName?: WorkspaceName;
}

/**
 * Input context for "get" handlers — built from resolve results.
 */
export interface GetStatusHookInput extends HookContext {
  readonly workspacePath: string;
}

/**
 * Per-handler result contract for the "get" hook point.
 * Each handler returns its contribution — the operation merges them.
 */
export interface GetStatusHookResult {
  readonly isDirty?: boolean;
  readonly agentStatus?: AggregatedAgentStatus;
}

// =============================================================================
// Operation
// =============================================================================

export class GetWorkspaceStatusOperation implements Operation<
  GetWorkspaceStatusIntent,
  WorkspaceStatus
> {
  readonly id = GET_WORKSPACE_STATUS_OPERATION_ID;

  async execute(ctx: OperationContext<GetWorkspaceStatusIntent>): Promise<WorkspaceStatus> {
    const { payload } = ctx.intent;

    // 1. resolve — validate workspacePath is tracked
    const resolveCtx: ResolveHookInput = {
      intent: ctx.intent,
      workspacePath: payload.workspacePath,
    };
    const { results: resolveResults, errors: resolveErrors } =
      await ctx.hooks.collect<ResolveHookResult>("resolve", resolveCtx);
    if (resolveErrors.length > 0) {
      throw new AggregateError(resolveErrors, "get-workspace-status resolve failed");
    }

    let found = false;
    for (const result of resolveResults) {
      if (result.projectPath !== undefined) found = true;
    }
    if (!found) {
      throw new Error(`Workspace not found: ${payload.workspacePath}`);
    }

    // 2. get — each handler contributes its piece
    const getCtx: GetStatusHookInput = {
      intent: ctx.intent,
      workspacePath: payload.workspacePath,
    };
    const { results, errors } = await ctx.hooks.collect<GetStatusHookResult>("get", getCtx);
    if (errors.length > 0) {
      throw new AggregateError(errors, "get-workspace-status get hooks failed");
    }

    // Merge results — isDirty uses OR (any hook says dirty = dirty)
    let isDirty = false;
    let agentStatus: AggregatedAgentStatus | undefined;

    for (const result of results) {
      if (result.isDirty) isDirty = true;
      if (result.agentStatus !== undefined) agentStatus = result.agentStatus;
    }

    const finalAgentStatus = agentStatus ?? {
      status: "none" as const,
      counts: { idle: 0, busy: 0 },
    };

    return {
      isDirty,
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
