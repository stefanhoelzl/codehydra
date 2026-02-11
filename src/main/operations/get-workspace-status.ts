/**
 * GetWorkspaceStatusOperation - Orchestrates workspace status queries.
 *
 * Runs the "get" hook point where multiple handlers each contribute
 * a piece of the status (dirty flag, agent status). The operation
 * assembles the final WorkspaceStatus from the extended hook context.
 *
 * No provider dependencies - hook handlers do the actual work.
 * No domain events - this is a query operation.
 */

import type { Intent } from "../intents/infrastructure/types";
import type { Operation, OperationContext, HookContext } from "../intents/infrastructure/operation";
import type { ProjectId, WorkspaceName, WorkspaceStatus } from "../../shared/api/types";
import type { AggregatedAgentStatus } from "../../shared/ipc";

// =============================================================================
// Intent Types
// =============================================================================

export interface GetWorkspaceStatusPayload {
  readonly projectId: ProjectId;
  readonly workspaceName: WorkspaceName;
}

export interface GetWorkspaceStatusIntent extends Intent<WorkspaceStatus> {
  readonly type: "workspace:get-status";
  readonly payload: GetWorkspaceStatusPayload;
}

export const INTENT_GET_WORKSPACE_STATUS = "workspace:get-status" as const;

// =============================================================================
// Operation
// =============================================================================

export const GET_WORKSPACE_STATUS_OPERATION_ID = "get-workspace-status";

/**
 * Per-handler result contract for the "get" hook point.
 * Each handler returns its contribution — the operation merges them.
 */
export interface GetStatusHookResult {
  readonly isDirty?: boolean;
  readonly agentStatus?: AggregatedAgentStatus;
}

export class GetWorkspaceStatusOperation implements Operation<
  GetWorkspaceStatusIntent,
  WorkspaceStatus
> {
  readonly id = GET_WORKSPACE_STATUS_OPERATION_ID;

  async execute(ctx: OperationContext<GetWorkspaceStatusIntent>): Promise<WorkspaceStatus> {
    const hookCtx: HookContext = { intent: ctx.intent };

    const { results, errors } = await ctx.hooks.collect<GetStatusHookResult>("get", hookCtx);
    if (errors.length > 0) {
      throw new AggregateError(errors, "get-workspace-status hooks failed");
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
