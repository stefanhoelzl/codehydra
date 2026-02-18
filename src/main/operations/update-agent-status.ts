/**
 * UpdateAgentStatusOperation - Resolves workspace context and emits agent:status-updated.
 *
 * Follows the standard two-step resolution pattern:
 * 1. "resolve" — gitWorktreeWorkspaceModule provides projectPath + workspaceName
 * 2. "resolve-project" — localProjectModule provides projectId
 *
 * If resolution is incomplete (unknown workspace), silently returns without emitting.
 */

import type { Intent, DomainEvent } from "../intents/infrastructure/types";
import type { Operation, OperationContext, HookContext } from "../intents/infrastructure/operation";
import type { WorkspacePath, AggregatedAgentStatus } from "../../shared/ipc";
import type { ProjectId, WorkspaceName } from "../../shared/api/types";

// =============================================================================
// Intent Types
// =============================================================================

export interface UpdateAgentStatusPayload {
  readonly workspacePath: WorkspacePath;
  readonly status: AggregatedAgentStatus;
}

export interface UpdateAgentStatusIntent extends Intent<void> {
  readonly type: "agent:update-status";
  readonly payload: UpdateAgentStatusPayload;
}

export const INTENT_UPDATE_AGENT_STATUS = "agent:update-status" as const;

// =============================================================================
// Hook Types
// =============================================================================

/** Input context for "resolve" handlers. */
export interface ResolveHookInput extends HookContext {
  readonly workspacePath: WorkspacePath;
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

// =============================================================================
// Event Types
// =============================================================================

export interface AgentStatusUpdatedPayload {
  readonly workspacePath: WorkspacePath;
  readonly projectId: ProjectId;
  readonly workspaceName: WorkspaceName;
  readonly status: AggregatedAgentStatus;
}

export interface AgentStatusUpdatedEvent extends DomainEvent {
  readonly type: "agent:status-updated";
  readonly payload: AgentStatusUpdatedPayload;
}

export const EVENT_AGENT_STATUS_UPDATED = "agent:status-updated" as const;

// =============================================================================
// Operation
// =============================================================================

export const UPDATE_AGENT_STATUS_OPERATION_ID = "update-agent-status";

export class UpdateAgentStatusOperation implements Operation<UpdateAgentStatusIntent, void> {
  readonly id = UPDATE_AGENT_STATUS_OPERATION_ID;

  async execute(ctx: OperationContext<UpdateAgentStatusIntent>): Promise<void> {
    const { payload } = ctx.intent;

    // 1. resolve — get projectPath + workspaceName from workspacePath
    const resolveCtx: ResolveHookInput = {
      intent: ctx.intent,
      workspacePath: payload.workspacePath,
    };
    const { results: resolveResults } = await ctx.hooks.collect<ResolveHookResult>(
      "resolve",
      resolveCtx
    );

    let projectPath: string | undefined;
    let workspaceName: WorkspaceName | undefined;
    for (const result of resolveResults) {
      if (result.projectPath !== undefined) projectPath = result.projectPath;
      if (result.workspaceName !== undefined) workspaceName = result.workspaceName;
    }

    if (!projectPath || !workspaceName) return;

    // 2. resolve-project — get projectId from projectPath
    const resolveProjectCtx: ResolveProjectHookInput = {
      intent: ctx.intent,
      projectPath,
    };
    const { results: resolveProjectResults } = await ctx.hooks.collect<ResolveProjectHookResult>(
      "resolve-project",
      resolveProjectCtx
    );

    let projectId: ProjectId | undefined;
    for (const result of resolveProjectResults) {
      if (result.projectId !== undefined) projectId = result.projectId;
    }

    if (!projectId) return;

    // 3. Emit domain event with fully resolved context
    const event: AgentStatusUpdatedEvent = {
      type: EVENT_AGENT_STATUS_UPDATED,
      payload: {
        workspacePath: payload.workspacePath,
        projectId,
        workspaceName,
        status: payload.status,
      },
    };
    ctx.emit(event);
  }
}
