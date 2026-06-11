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

import type { Intent } from "./lib/types";
import type { HookContext } from "./lib/operation";
import type { AgentSession } from "../shared/api/types";
import { WorkspaceHookOperation } from "./lib/workspace-operation";
import { lastDefined, requireResult } from "./lib/hook-helpers";

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

export class GetAgentSessionOperation extends WorkspaceHookOperation<
  GetAgentSessionIntent,
  GetAgentSessionHookResult,
  AgentSession | null
> {
  constructor() {
    super(GET_AGENT_SESSION_OPERATION_ID, {
      hookPoint: "get",
      errorLabel: "get-agent-session get hooks failed",
      extract: (results) =>
        requireResult(
          lastDefined(results, (r) => r.session),
          "Get agent session hook did not provide session result"
        ),
    });
  }
}
