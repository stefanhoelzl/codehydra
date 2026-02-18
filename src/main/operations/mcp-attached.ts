/**
 * McpAttachedOperation - Trivial operation that emits a workspace:mcp-attached domain event.
 *
 * No hooks -- this operation simply relays the "first MCP request received" signal
 * through the intent dispatcher so downstream event subscribers (McpModule temporary
 * handlers for view/agent, future ViewModule and AgentModule) can react.
 */

import type { Intent, DomainEvent } from "../intents/infrastructure/types";
import type { Operation, OperationContext } from "../intents/infrastructure/operation";

// =============================================================================
// Intent Types
// =============================================================================

export interface McpAttachedPayload {
  readonly workspacePath: string;
}

export interface McpAttachedIntent extends Intent<void> {
  readonly type: "workspace:mcp-attached";
  readonly payload: McpAttachedPayload;
}

export const INTENT_MCP_ATTACHED = "workspace:mcp-attached" as const;

// =============================================================================
// Event Types
// =============================================================================

export interface McpAttachedEvent extends DomainEvent {
  readonly type: "workspace:mcp-attached";
  readonly payload: McpAttachedPayload;
}

export const EVENT_MCP_ATTACHED = "workspace:mcp-attached" as const;

// =============================================================================
// Operation
// =============================================================================

export const MCP_ATTACHED_OPERATION_ID = "mcp-attached";

export class McpAttachedOperation implements Operation<McpAttachedIntent, void> {
  readonly id = MCP_ATTACHED_OPERATION_ID;

  async execute(ctx: OperationContext<McpAttachedIntent>): Promise<void> {
    const { payload } = ctx.intent;

    const event: McpAttachedEvent = {
      type: EVENT_MCP_ATTACHED,
      payload: {
        workspacePath: payload.workspacePath,
      },
    };
    ctx.emit(event);
  }
}
