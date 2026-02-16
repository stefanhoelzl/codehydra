/**
 * RestartAgentOperation - Orchestrates agent server restarts.
 *
 * Runs three sequential hook points:
 * 1. "resolve-project": resolve projectId -> projectPath
 * 2. "resolve-workspace": resolve workspaceName -> workspacePath
 * 3. "restart": restart the agent server using enriched context
 *
 * On success, emits an agent:restarted domain event.
 *
 * No provider dependencies - the hook handlers do the actual work.
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
// Hook Result & Input Types
// =============================================================================

export const RESTART_AGENT_OPERATION_ID = "restart-agent";

/** Per-handler result for the "resolve-project" hook point. */
export interface ResolveProjectHookResult {
  readonly projectPath?: string;
}

/** Input context for the "resolve-workspace" hook point. */
export interface ResolveWorkspaceHookInput extends HookContext {
  readonly projectPath: string;
  readonly workspaceName: string;
}

/** Per-handler result for the "resolve-workspace" hook point. */
export interface ResolveWorkspaceHookResult {
  readonly workspacePath?: string;
}

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

    // 1. Resolve project: projectId -> projectPath
    const resolveProjectCtx: HookContext = { intent: ctx.intent };
    const { results: resolveProjectResults, errors: resolveProjectErrors } =
      await ctx.hooks.collect<ResolveProjectHookResult>("resolve-project", resolveProjectCtx);
    if (resolveProjectErrors.length === 1) {
      throw resolveProjectErrors[0]!;
    }
    if (resolveProjectErrors.length > 1) {
      throw new AggregateError(resolveProjectErrors, "restart-agent resolve-project hooks failed");
    }
    let projectPath: string | undefined;
    for (const r of resolveProjectResults) {
      if (r.projectPath !== undefined) projectPath = r.projectPath;
    }
    if (!projectPath) {
      throw new Error(`Project not found: ${payload.projectId}`);
    }

    // 2. Resolve workspace: workspaceName -> workspacePath
    const resolveWorkspaceCtx: ResolveWorkspaceHookInput = {
      intent: ctx.intent,
      projectPath,
      workspaceName: payload.workspaceName,
    };
    const { results: resolveWorkspaceResults, errors: resolveWorkspaceErrors } =
      await ctx.hooks.collect<ResolveWorkspaceHookResult>("resolve-workspace", resolveWorkspaceCtx);
    if (resolveWorkspaceErrors.length === 1) {
      throw resolveWorkspaceErrors[0]!;
    }
    if (resolveWorkspaceErrors.length > 1) {
      throw new AggregateError(
        resolveWorkspaceErrors,
        "restart-agent resolve-workspace hooks failed"
      );
    }
    let workspacePath: string | undefined;
    for (const r of resolveWorkspaceResults) {
      if (r.workspacePath !== undefined) workspacePath = r.workspacePath;
    }
    if (!workspacePath) {
      throw new Error(`Workspace not found: ${payload.workspaceName}`);
    }

    // 3. Restart: handler restarts the server
    const restartCtx: RestartAgentHookInput = {
      intent: ctx.intent,
      workspacePath,
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
        projectId: payload.projectId,
        workspaceName: payload.workspaceName,
        path: workspacePath,
        port,
      },
    };
    ctx.emit(event);

    return port;
  }
}
