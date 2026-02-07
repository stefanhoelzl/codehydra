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
 * Extended hook context for get-workspace-status.
 * Each hook handler populates its own entry:
 * - Git handler sets `isDirty`
 * - Agent handler sets `agentStatus`
 *
 * The operation assembles WorkspaceStatus from both fields.
 */
export interface GetWorkspaceStatusHookContext extends HookContext {
  isDirty?: boolean;
  agentStatus?: AggregatedAgentStatus;
}

export class GetWorkspaceStatusOperation implements Operation<
  GetWorkspaceStatusIntent,
  WorkspaceStatus
> {
  readonly id = GET_WORKSPACE_STATUS_OPERATION_ID;

  async execute(ctx: OperationContext<GetWorkspaceStatusIntent>): Promise<WorkspaceStatus> {
    const hookCtx: GetWorkspaceStatusHookContext = {
      intent: ctx.intent,
    };

    // Run "get" hook -- handlers populate isDirty and agentStatus
    await ctx.hooks.run("get", hookCtx);

    // Check for errors from hook handlers
    if (hookCtx.error) {
      throw hookCtx.error;
    }

    if (hookCtx.isDirty === undefined) {
      throw new Error("Get workspace status hook did not provide isDirty result");
    }

    // Assemble WorkspaceStatus from handler contributions
    const agentStatus = hookCtx.agentStatus ?? {
      status: "none" as const,
      counts: { idle: 0, busy: 0 },
    };

    return {
      isDirty: hookCtx.isDirty,
      agent:
        agentStatus.status === "none"
          ? { type: "none" }
          : {
              type: agentStatus.status,
              counts: {
                idle: agentStatus.counts.idle,
                busy: agentStatus.counts.busy,
                total: agentStatus.counts.idle + agentStatus.counts.busy,
              },
            },
    };
  }
}
