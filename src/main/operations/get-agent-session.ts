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
 * Extended hook context for get-agent-session.
 * The "get" hook handler populates `session` with the result.
 * `undefined` means the hook didn't run (error).
 * `null` is a valid result (no session exists).
 */
export interface GetAgentSessionHookContext extends HookContext {
  session?: AgentSession | null;
}

export class GetAgentSessionOperation implements Operation<
  GetAgentSessionIntent,
  AgentSession | null
> {
  readonly id = GET_AGENT_SESSION_OPERATION_ID;

  async execute(ctx: OperationContext<GetAgentSessionIntent>): Promise<AgentSession | null> {
    const hookCtx: GetAgentSessionHookContext = {
      intent: ctx.intent,
    };

    // Run "get" hook -- handler retrieves session info
    await ctx.hooks.run("get", hookCtx);

    // Check for errors from hook handlers
    if (hookCtx.error) {
      throw hookCtx.error;
    }

    if (hookCtx.session === undefined) {
      throw new Error("Get agent session hook did not provide session result");
    }

    return hookCtx.session;
  }
}
