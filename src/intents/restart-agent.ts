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

import type { Intent, DomainEvent } from "./lib/types";
import type { HookContext } from "./lib/operation";
import type { ProjectId, WorkspaceName } from "../shared/api/types";
import { WorkspaceHookOperation } from "./lib/workspace-operation";
import { lastDefined, requireResult } from "./lib/hook-helpers";

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

const EVENT_AGENT_RESTARTED = "agent:restarted" as const;

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

export class RestartAgentOperation extends WorkspaceHookOperation<
  RestartAgentIntent,
  RestartAgentHookResult,
  number
> {
  constructor() {
    super(RESTART_AGENT_OPERATION_ID, {
      hookPoint: "restart",
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
