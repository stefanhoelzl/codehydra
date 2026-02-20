/**
 * GetAgentSessionOperation - Orchestrates agent session queries.
 *
 * Runs two steps:
 * 1. Dispatch workspace:resolve to validate workspacePath
 * 2. "get" hook — retrieve session info from enriched context
 *
 * No provider dependencies - the hook handlers do the actual work.
 * No domain events - this is a query operation.
 */

import type { Intent } from "../intents/infrastructure/types";
import type { Operation, OperationContext, HookContext } from "../intents/infrastructure/operation";
import type { AgentSession } from "../../shared/api/types";
import { INTENT_RESOLVE_WORKSPACE, type ResolveWorkspaceIntent } from "./resolve-workspace";

// =============================================================================
// Intent Types
// =============================================================================

export interface GetAgentSessionPayload {
  readonly workspacePath: string;
}

export interface GetAgentSessionIntent extends Intent<AgentSession | null> {
  readonly type: "agent:get-session";
  readonly payload: GetAgentSessionPayload;
}

export const INTENT_GET_AGENT_SESSION = "agent:get-session" as const;

// =============================================================================
// Hook Result & Input Types
// =============================================================================

export const GET_AGENT_SESSION_OPERATION_ID = "get-agent-session";

/** Input context for the "get" hook point. */
export interface GetAgentSessionHookInput extends HookContext {
  readonly workspacePath: string;
}

/**
 * Per-handler result contract for the "get" hook point.
 * Each handler returns its contribution — the operation merges them.
 * `null` is a valid result (no session exists).
 */
export interface GetAgentSessionHookResult {
  readonly session: AgentSession | null;
}

// =============================================================================
// Operation
// =============================================================================

export class GetAgentSessionOperation implements Operation<
  GetAgentSessionIntent,
  AgentSession | null
> {
  readonly id = GET_AGENT_SESSION_OPERATION_ID;

  async execute(ctx: OperationContext<GetAgentSessionIntent>): Promise<AgentSession | null> {
    const { payload } = ctx.intent;

    // 1. Dispatch shared workspace resolution
    await ctx.dispatch({
      type: INTENT_RESOLVE_WORKSPACE,
      payload: { workspacePath: payload.workspacePath },
    } as ResolveWorkspaceIntent);

    // 2. get — handler retrieves session info
    const getCtx: GetAgentSessionHookInput = {
      intent: ctx.intent,
      workspacePath: payload.workspacePath,
    };
    const { results, errors } = await ctx.hooks.collect<GetAgentSessionHookResult>("get", getCtx);
    if (errors.length === 1) {
      throw errors[0]!;
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "get-agent-session get hooks failed");
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
