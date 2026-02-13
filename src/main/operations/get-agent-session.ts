/**
 * GetAgentSessionOperation - Orchestrates agent session queries.
 *
 * Runs the "get" hook point where the handler retrieves session info
 * from the AgentStatusManager. The operation reads the result from the
 * extended hook context.
 *
 * No provider dependencies - the hook handler does the actual work.
 * No domain events - this is a query operation.
 */

import type { Intent } from "../intents/infrastructure/types";
import type { Operation, OperationContext, HookContext } from "../intents/infrastructure/operation";
import type { ProjectId, WorkspaceName, AgentSession } from "../../shared/api/types";

// =============================================================================
// Intent Types
// =============================================================================

export interface GetAgentSessionPayload {
  readonly projectId: ProjectId;
  readonly workspaceName: WorkspaceName;
}

export interface GetAgentSessionIntent extends Intent<AgentSession | null> {
  readonly type: "agent:get-session";
  readonly payload: GetAgentSessionPayload;
}

export const INTENT_GET_AGENT_SESSION = "agent:get-session" as const;

// =============================================================================
// Operation
// =============================================================================

export const GET_AGENT_SESSION_OPERATION_ID = "get-agent-session";

/**
 * Per-handler result contract for the "get" hook point.
 * Each handler returns its contribution — the operation merges them.
 * `null` is a valid result (no session exists).
 */
export interface GetAgentSessionHookResult {
  readonly session: AgentSession | null;
}

export class GetAgentSessionOperation implements Operation<
  GetAgentSessionIntent,
  AgentSession | null
> {
  readonly id = GET_AGENT_SESSION_OPERATION_ID;

  async execute(ctx: OperationContext<GetAgentSessionIntent>): Promise<AgentSession | null> {
    const hookCtx: HookContext = {
      intent: ctx.intent,
    };

    // Run "get" hook -- handler retrieves session info
    const { results, errors } = await ctx.hooks.collect<GetAgentSessionHookResult>("get", hookCtx);
    if (errors.length > 0) {
      throw errors[0]!;
    }

    // Merge results — last-write-wins for session
    let session: AgentSession | null | undefined;
    for (const result of results) {
      if (result.session !== undefined) session = result.session;
    }

    if (session === undefined) {
      throw new Error("Get agent session hook did not provide session result");
    }

    return session;
  }
}
