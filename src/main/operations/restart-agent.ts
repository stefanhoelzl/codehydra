/**
 * RestartAgentOperation - Orchestrates agent server restarts.
 *
 * Runs three sequential hook points:
 * 1. "resolve" - Validates workspacePath is tracked, returns projectPath + workspaceName
 * 2. "resolve-project" - Resolves projectPath to projectId (for domain events)
 * 3. "restart" - Restart the agent server using enriched context
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

/** Input context for "resolve" handlers. */
export interface ResolveHookInput extends HookContext {
  readonly workspacePath: string;
}

/** Per-handler result for "resolve" hook point. */
export interface ResolveHookResult {
  readonly projectPath?: string;
  readonly workspaceName?: WorkspaceName;
}

/** Input context for "resolve-project" handlers. */
export interface ResolveProjectHookInput extends HookContext {
  readonly projectPath: string;
}

/** Per-handler result for "resolve-project" hook point. */
export interface ResolveProjectHookResult {
  readonly projectId?: ProjectId;
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

    // 1. resolve — validate workspacePath is tracked, get projectPath + workspaceName
    const resolveCtx: ResolveHookInput = {
      intent: ctx.intent,
      workspacePath: payload.workspacePath,
    };
    const { results: resolveResults, errors: resolveErrors } =
      await ctx.hooks.collect<ResolveHookResult>("resolve", resolveCtx);
    if (resolveErrors.length === 1) {
      throw resolveErrors[0]!;
    }
    if (resolveErrors.length > 1) {
      throw new AggregateError(resolveErrors, "restart-agent resolve hooks failed");
    }

    let projectPath: string | undefined;
    let workspaceName: WorkspaceName | undefined;
    for (const r of resolveResults) {
      if (r.projectPath !== undefined) projectPath = r.projectPath;
      if (r.workspaceName !== undefined) workspaceName = r.workspaceName;
    }
    if (!projectPath || !workspaceName) {
      throw new Error(`Workspace not found: ${payload.workspacePath}`);
    }

    // 2. resolve-project — get projectId from projectPath (for domain events)
    const resolveProjectCtx: ResolveProjectHookInput = {
      intent: ctx.intent,
      projectPath,
    };
    const { results: resolveProjectResults, errors: resolveProjectErrors } =
      await ctx.hooks.collect<ResolveProjectHookResult>("resolve-project", resolveProjectCtx);
    if (resolveProjectErrors.length === 1) {
      throw resolveProjectErrors[0]!;
    }
    if (resolveProjectErrors.length > 1) {
      throw new AggregateError(resolveProjectErrors, "restart-agent resolve-project hooks failed");
    }

    let projectId: ProjectId | undefined;
    for (const r of resolveProjectResults) {
      if (r.projectId !== undefined) projectId = r.projectId;
    }
    if (!projectId) {
      throw new Error(`Project not found for path: ${projectPath}`);
    }

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
