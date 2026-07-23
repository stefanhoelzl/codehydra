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
 *
 * Contract schemas (item 2): zod is the single source of truth. The payload/result/hook/event
 * schemas are declared once and hung on the operation's `schemas` field; the `Intent`, result,
 * and event-payload types are **derived** from that bundle via `IntentOf`/`z.infer`.
 */

import { z } from "zod/v4";
import type { DomainEvent } from "./lib/types";
import type { OperationSchemas, HookContext } from "./lib/operation";
import { type IntentOf } from "./lib/operation";
import {
  hookCtxSchema,
  projectIdSchema,
  workspaceNameSchema,
  workspacePathSchema,
} from "./contract";
import { WorkspaceHookOperation } from "./lib/workspace-operation";
import { lastDefined, requireResult } from "./lib/hook-helpers";

export const INTENT_RESTART_AGENT = "agent:restart" as const;

export const RESTART_AGENT_OPERATION_ID = "restart-agent";

const EVENT_AGENT_RESTARTED = "agent:restarted" as const;

// =============================================================================
// Contract schemas (single source of truth)
// =============================================================================

export const restartAgentPayloadSchema = z
  .object({
    workspacePath: workspacePathSchema,
  })
  .readonly();

/** Operation return value — the port the restarted agent server listens on. */
export const restartAgentResultSchema = z.number();

export const agentRestartedPayloadSchema = z
  .object({
    projectId: projectIdSchema,
    workspaceName: workspaceNameSchema,
    path: workspacePathSchema,
    port: z.number(),
  })
  .readonly();

/**
 * Per-handler result contract for the "restart" hook point.
 * Each handler returns its contribution — the operation merges them.
 */
export const restartAgentHookResultSchema = z
  .object({
    port: z.number().optional(),
  })
  .readonly();

/** Operation-added enrichment for the "restart" hook point (beyond the base HookContext). */
const restartEnrichmentSchema = z.object({ workspacePath: workspacePathSchema });

/** Runtime whole-context validation schema for "restart". */
export const restartAgentHookInputSchema = hookCtxSchema(
  restartAgentPayloadSchema,
  restartEnrichmentSchema.shape
);

/**
 * This operation's contract bundle. Exported so consumers (and tests) can take a typed view
 * of its hook points and events via `ResolvedHooks<typeof schemas>` / `EventOf<typeof schemas>`.
 */
export const schemas = {
  type: INTENT_RESTART_AGENT,
  payload: restartAgentPayloadSchema,
  result: restartAgentResultSchema,
  hooks: {
    restart: { input: restartAgentHookInputSchema, result: restartAgentHookResultSchema },
  },
  events: {
    [EVENT_AGENT_RESTARTED]: agentRestartedPayloadSchema,
  },
} satisfies OperationSchemas;

// =============================================================================
// Types derived from the schemas
// =============================================================================

export type RestartAgentPayload = z.infer<typeof restartAgentPayloadSchema>;
export type RestartAgentIntent = IntentOf<typeof schemas>;
export type RestartAgentHookResult = z.infer<typeof restartAgentHookResultSchema>;
export type AgentRestartedPayload = z.infer<typeof agentRestartedPayloadSchema>;

export interface AgentRestartedEvent extends DomainEvent {
  readonly type: "agent:restarted";
  readonly payload: AgentRestartedPayload;
}

/** Input context for the "restart" hook point: base envelope + inferred enrichment. */
export type RestartAgentHookInput = HookContext & z.infer<typeof restartEnrichmentSchema>;

// =============================================================================
// Operation
// =============================================================================

export class RestartAgentOperation extends WorkspaceHookOperation<typeof schemas> {
  readonly schemas = schemas;

  constructor() {
    super(RESTART_AGENT_OPERATION_ID, {
      hookPoint: "restart",
      buildInput: (intent, workspacePath) => ({ intent, workspacePath }),
      resolveProject: true,
      errorLabel: "restart-agent restart hooks failed",
      extract: (results) =>
        requireResult(
          lastDefined(results, (r) => r.port),
          "Restart agent hook did not provide port result"
        ),
      onSuccess: ({ intent, resolved, project, result }) =>
        ({
          type: EVENT_AGENT_RESTARTED,
          payload: {
            projectId: project!.projectId,
            workspaceName: resolved.workspaceName,
            path: intent.payload.workspacePath,
            port: result,
          },
        }) satisfies AgentRestartedEvent,
    });
  }
}
