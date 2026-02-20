/**
 * UpdateAgentStatusOperation - Resolves workspace context and emits agent:status-updated.
 *
 * Dispatches shared resolution intents:
 * 1. workspace:resolve — projectPath + workspaceName from workspacePath
 * 2. project:resolve — projectId from projectPath
 *
 * If resolution is incomplete (unknown workspace), silently returns without emitting.
 */

import type { Intent, DomainEvent } from "../intents/infrastructure/types";
import type { Operation, OperationContext } from "../intents/infrastructure/operation";
import type { WorkspacePath, AggregatedAgentStatus } from "../../shared/ipc";
import type { ProjectId, WorkspaceName } from "../../shared/api/types";
import { INTENT_RESOLVE_WORKSPACE, type ResolveWorkspaceIntent } from "./resolve-workspace";
import { INTENT_RESOLVE_PROJECT, type ResolveProjectIntent } from "./resolve-project";

// =============================================================================
// Intent Types
// =============================================================================

export interface UpdateAgentStatusPayload {
  readonly workspacePath: WorkspacePath;
  readonly status: AggregatedAgentStatus;
}

export interface UpdateAgentStatusIntent extends Intent<void> {
  readonly type: "agent:update-status";
  readonly payload: UpdateAgentStatusPayload;
}

export const INTENT_UPDATE_AGENT_STATUS = "agent:update-status" as const;

// =============================================================================
// Event Types
// =============================================================================

export interface AgentStatusUpdatedPayload {
  readonly workspacePath: WorkspacePath;
  readonly projectId: ProjectId;
  readonly workspaceName: WorkspaceName;
  readonly status: AggregatedAgentStatus;
}

export interface AgentStatusUpdatedEvent extends DomainEvent {
  readonly type: "agent:status-updated";
  readonly payload: AgentStatusUpdatedPayload;
}

export const EVENT_AGENT_STATUS_UPDATED = "agent:status-updated" as const;

// =============================================================================
// Operation
// =============================================================================

export const UPDATE_AGENT_STATUS_OPERATION_ID = "update-agent-status";

export class UpdateAgentStatusOperation implements Operation<UpdateAgentStatusIntent, void> {
  readonly id = UPDATE_AGENT_STATUS_OPERATION_ID;

  async execute(ctx: OperationContext<UpdateAgentStatusIntent>): Promise<void> {
    const { payload } = ctx.intent;

    // Resolve workspace + project, silently bail if unknown
    let projectPath: string;
    let workspaceName: WorkspaceName;
    let projectId: ProjectId;
    try {
      ({ projectPath, workspaceName } = await ctx.dispatch({
        type: INTENT_RESOLVE_WORKSPACE,
        payload: { workspacePath: payload.workspacePath },
      } as ResolveWorkspaceIntent));
      ({ projectId } = await ctx.dispatch({
        type: INTENT_RESOLVE_PROJECT,
        payload: { projectPath },
      } as ResolveProjectIntent));
    } catch {
      return; // silently bail — unknown workspace/project
    }

    // Emit domain event with fully resolved context
    const event: AgentStatusUpdatedEvent = {
      type: EVENT_AGENT_STATUS_UPDATED,
      payload: {
        workspacePath: payload.workspacePath,
        projectId,
        workspaceName,
        status: payload.status,
      },
    };
    ctx.emit(event);
  }
}
