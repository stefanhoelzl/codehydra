/**
 * UpdateAgentStatusOperation - Trivial operation that emits an agent:status-updated domain event.
 *
 * No hooks -- this operation simply relays status changes from AgentStatusManager
 * through the intent dispatcher so downstream event subscribers (IpcEventBridge, BadgeModule)
 * can react to status changes.
 */

import type { Intent, DomainEvent } from "../intents/infrastructure/types";
import type { Operation, OperationContext } from "../intents/infrastructure/operation";
import type { WorkspacePath, AggregatedAgentStatus } from "../../shared/ipc";

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

    const event: AgentStatusUpdatedEvent = {
      type: EVENT_AGENT_STATUS_UPDATED,
      payload: {
        workspacePath: payload.workspacePath,
        status: payload.status,
      },
    };
    ctx.emit(event);
  }
}
