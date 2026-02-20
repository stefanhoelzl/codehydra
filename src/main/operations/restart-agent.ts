/**
 * RestartAgentOperation - Orchestrates agent server restarts.
 *
 * Runs three steps:
 * 1. Dispatch workspace:resolve — validates workspacePath, returns projectPath + workspaceName
 * 2. Dispatch project:resolve — resolves projectPath to projectId (for domain events)
 * 3. "restart" hook — restart the agent server using enriched context
 *
 * On success, emits an agent:restarted domain event.
 *
 * No provider dependencies - the hook handlers do the actual work.
 */

import type { Intent, DomainEvent } from "../intents/infrastructure/types";
import type { Operation, OperationContext, HookContext } from "../intents/infrastructure/operation";
import type { ProjectId, WorkspaceName } from "../../shared/api/types";
import { INTENT_RESOLVE_WORKSPACE, type ResolveWorkspaceIntent } from "./resolve-workspace";
import { INTENT_RESOLVE_PROJECT, type ResolveProjectIntent } from "./resolve-project";

// =============================================================================
// Intent Types
// =============================================================================

export interface RestartAgentPayload {
  readonly workspacePath: string;
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
// Hook Result & Input Types
// =============================================================================

export const RESTART_AGENT_OPERATION_ID = "restart-agent";

/** Input context for the "restart" hook point. */
export interface RestartAgentHookInput extends HookContext {
  readonly workspacePath: string;
}

/**
 * Per-handler result contract for the "restart" hook point.
 * Each handler returns its contribution — the operation merges them.
 */
export interface RestartAgentHookResult {
  readonly port?: number;
}

// =============================================================================
// Operation
// =============================================================================

export class RestartAgentOperation implements Operation<RestartAgentIntent, number> {
  readonly id = RESTART_AGENT_OPERATION_ID;

  async execute(ctx: OperationContext<RestartAgentIntent>): Promise<number> {
    const { payload } = ctx.intent;

    // 1. Dispatch shared workspace resolution
    const { projectPath, workspaceName } = await ctx.dispatch({
      type: INTENT_RESOLVE_WORKSPACE,
      payload: { workspacePath: payload.workspacePath },
    } as ResolveWorkspaceIntent);

    // 2. Dispatch shared project resolution
    const { projectId } = await ctx.dispatch({
      type: INTENT_RESOLVE_PROJECT,
      payload: { projectPath },
    } as ResolveProjectIntent);

    // 3. restart — handler restarts the server
    const restartCtx: RestartAgentHookInput = {
      intent: ctx.intent,
      workspacePath: payload.workspacePath,
    };
    const { results, errors } = await ctx.hooks.collect<RestartAgentHookResult>(
      "restart",
      restartCtx
    );
    if (errors.length === 1) {
      throw errors[0]!;
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "restart-agent restart hooks failed");
    }

    // Merge results — last-write-wins for port
    let port: number | undefined;
    for (const result of results) {
      if (result.port !== undefined) port = result.port;
    }

    if (port === undefined) {
      throw new Error("Restart agent hook did not provide port result");
    }

    // Emit domain event for subscribers (e.g., IpcEventBridge)
    const event: AgentRestartedEvent = {
      type: EVENT_AGENT_RESTARTED,
      payload: {
        projectId,
        workspaceName,
        path: payload.workspacePath,
        port,
      },
    };
    ctx.emit(event);

    return port;
  }
}
