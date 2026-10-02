/**
 * GetAgentSessionOperation - Orchestrates agent session queries.
 *
 * Runs two steps:
 * 1. Dispatch workspace:resolve to turn workspaceRef into the workspace
 * 2. "get" hook — retrieve session info from enriched context
 *
 * No provider dependencies - the hook handlers do the actual work.
 * No domain events - this is a query operation.
 *
 * Contract schemas (item 2): zod is the single source of truth; the Intent and hook
 * result/input types are derived from the `schemas` bundle.
 */

import { z } from "zod/v4";
import type { HookContext, OperationSchemas } from "./lib/operation";
import { type IntentOf } from "./lib/operation";
import {
  agentSessionSchema,
  hookCtxSchema,
  workspaceRefSchema,
  workspaceTargetShape,
} from "./contract";
import { WorkspaceHookOperation } from "./lib/workspace-operation";
import { onlyDefined, requireResult } from "./lib/hook-helpers";

export const INTENT_GET_AGENT_SESSION = "agent:get-session" as const;
export const GET_AGENT_SESSION_OPERATION_ID = "get-agent-session";

// =============================================================================
// Contract schemas (single source of truth)
// =============================================================================

export const getAgentSessionPayloadSchema = z
  .object({
    workspaceRef: workspaceRefSchema,
  })
  .readonly();

export const getAgentSessionResultSchema = agentSessionSchema.nullable();

/**
 * Per-handler result contract for the "get" hook point.
 * Each handler returns its contribution — the operation merges them.
 * `null` is a valid result (no session exists).
 */
export const getAgentSessionHookResultSchema = z
  .object({
    session: agentSessionSchema.nullable().optional(),
  })
  .readonly();

/** Operation-added enrichment for the "get" hook point (beyond the base HookContext). */
const getAgentSessionEnrichmentSchema = z.object(workspaceTargetShape);

/** Runtime whole-context validation schema for "get". */
export const getAgentSessionHookInputSchema = hookCtxSchema(
  getAgentSessionPayloadSchema,
  getAgentSessionEnrichmentSchema.shape
);

/**
 * This operation's contract bundle. Exported so consumers (and tests) can take a typed view
 * of its hook points and events via `ResolvedHooks<typeof schemas>` / `EventOf<typeof schemas>`.
 */
export const schemas = {
  type: INTENT_GET_AGENT_SESSION,
  payload: getAgentSessionPayloadSchema,
  result: getAgentSessionResultSchema,
  hooks: {
    get: { input: getAgentSessionHookInputSchema, result: getAgentSessionHookResultSchema },
  },
} satisfies OperationSchemas;

// =============================================================================
// Types derived from the schemas
// =============================================================================

export type GetAgentSessionPayload = z.infer<typeof getAgentSessionPayloadSchema>;
export type GetAgentSessionResult = z.infer<typeof getAgentSessionResultSchema>;
export type GetAgentSessionIntent = IntentOf<typeof schemas>;
export type GetAgentSessionHookResult = z.infer<typeof getAgentSessionHookResultSchema>;

/** Whole input context for "get" handlers: base envelope + inferred enrichment. */
export type GetAgentSessionHookInput = HookContext &
  z.infer<typeof getAgentSessionEnrichmentSchema>;

// =============================================================================
// Operation
// =============================================================================

export class GetAgentSessionOperation extends WorkspaceHookOperation<typeof schemas> {
  readonly schemas = schemas;

  constructor() {
    super(GET_AGENT_SESSION_OPERATION_ID, {
      hookPoint: "get",
      buildInput: (intent, target) => ({ intent, ...target }),
      errorLabel: "get-agent-session get hooks failed",
      extract: (results) =>
        requireResult(
          onlyDefined(results, "session", "agent:get-session get"),
          "Get agent session hook did not provide session result"
        ),
    });
  }
}
