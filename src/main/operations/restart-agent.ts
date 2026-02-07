/**
 * RestartAgentOperation - Orchestrates agent server restarts.
 *
 * Runs the "restart" hook point where the handler calls the server manager
 * to restart the agent for a workspace. On success, emits an agent:restarted
 * domain event.
 *
 * No provider dependencies - the hook handler does the actual work.
 */

import type { Intent, DomainEvent } from "../intents/infrastructure/types";
import type { Operation, OperationContext, HookContext } from "../intents/infrastructure/operation";
import type { ProjectId, WorkspaceName } from "../../shared/api/types";

// =============================================================================
// Intent Types
// =============================================================================

export interface RestartAgentPayload {
  readonly projectId: ProjectId;
  readonly workspaceName: WorkspaceName;
}

export interface RestartAgentIntent extends Intent<number> {
  readonly type: "agent:restart";
  readonly payload: RestartAgentPayload;
}

export const INTENT_RESTART_AGENT = "agent:restart" as const;

// =============================================================================
// Event Types
// =============================================================================

export interface AgentRestartedPayload {
  readonly projectId: ProjectId;
  readonly workspaceName: WorkspaceName;
  readonly path: string;
  readonly port: number;
}

export interface AgentRestartedEvent extends DomainEvent {
  readonly type: "agent:restarted";
  readonly payload: AgentRestartedPayload;
}

export const EVENT_AGENT_RESTARTED = "agent:restarted" as const;

// =============================================================================
// Operation
// =============================================================================

export const RESTART_AGENT_OPERATION_ID = "restart-agent";

/**
 * Extended hook context for restart-agent.
 * The "restart" hook handler populates `port` with the new port on success.
 * `undefined` means the hook didn't run (error).
 */
export interface RestartAgentHookContext extends HookContext {
  port?: number;
  /** Workspace path, set by hook handler for event emission */
  workspacePath?: string;
}

export class RestartAgentOperation implements Operation<RestartAgentIntent, number> {
  readonly id = RESTART_AGENT_OPERATION_ID;

  async execute(ctx: OperationContext<RestartAgentIntent>): Promise<number> {
    const hookCtx: RestartAgentHookContext = {
      intent: ctx.intent,
    };

    // Run "restart" hook -- handler restarts the server
    await ctx.hooks.run("restart", hookCtx);

    // Check for errors from hook handlers
    if (hookCtx.error) {
      throw hookCtx.error;
    }

    if (hookCtx.port === undefined) {
      throw new Error("Restart agent hook did not provide port result");
    }

    // Emit domain event for subscribers (e.g., IpcEventBridge)
    const event: AgentRestartedEvent = {
      type: EVENT_AGENT_RESTARTED,
      payload: {
        projectId: ctx.intent.payload.projectId,
        workspaceName: ctx.intent.payload.workspaceName,
        path: hookCtx.workspacePath ?? "",
        port: hookCtx.port,
      },
    };
    ctx.emit(event);

    return hookCtx.port;
  }
}
