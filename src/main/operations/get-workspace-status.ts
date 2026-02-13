/**
 * GetWorkspaceStatusOperation - Orchestrates workspace status queries.
 *
 * Runs three hook points in sequence:
 * 1. "resolve-project" - Resolves projectId to projectPath
 * 2. "resolve-workspace" - Resolves workspaceName to workspacePath
 * 3. "get" - Each handler contributes a piece of the status
 *
 * No provider dependencies - hook handlers do the actual work.
 * No domain events - this is a query operation.
 */

import type { Intent } from "../intents/infrastructure/types";
import type { Operation, OperationContext, HookContext } from "../intents/infrastructure/operation";
import type { ProjectId, WorkspaceName, WorkspaceStatus } from "../../shared/api/types";
import type { AggregatedAgentStatus } from "../../shared/ipc";

// =============================================================================
// Intent Types
// =============================================================================

export interface GetWorkspaceStatusPayload {
  readonly projectId: ProjectId;
  readonly workspaceName: WorkspaceName;
}

export interface GetWorkspaceStatusIntent extends Intent<WorkspaceStatus> {
  readonly type: "workspace:get-status";
  readonly payload: GetWorkspaceStatusPayload;
}

export const INTENT_GET_WORKSPACE_STATUS = "workspace:get-status" as const;

// =============================================================================
// Hook Types
// =============================================================================

export const GET_WORKSPACE_STATUS_OPERATION_ID = "get-workspace-status";

/**
 * Per-handler result contract for the "resolve-project" hook point.
 * Each handler returns projectPath if it owns the project, or `{}` to skip.
 */
export interface ResolveProjectHookResult {
  readonly projectPath?: string;
}

/**
 * Per-handler result contract for the "resolve-workspace" hook point.
 * Each handler returns workspacePath if it can resolve, or `{}` to skip.
 */
export interface ResolveWorkspaceHookResult {
  readonly workspacePath?: string;
}

/**
 * Input context for "resolve-workspace" handlers — built from resolve-project results.
 */
export interface ResolveWorkspaceHookInput extends HookContext {
  readonly projectPath: string;
  readonly workspaceName: string;
}

/**
 * Input context for "get" handlers — built from resolve-workspace results.
 */
export interface GetStatusHookInput extends HookContext {
  readonly workspacePath: string;
}

/**
 * Per-handler result contract for the "get" hook point.
 * Each handler returns its contribution — the operation merges them.
 */
export interface GetStatusHookResult {
  readonly isDirty?: boolean;
  readonly agentStatus?: AggregatedAgentStatus;
}

// =============================================================================
// Operation
// =============================================================================

export class GetWorkspaceStatusOperation implements Operation<
  GetWorkspaceStatusIntent,
  WorkspaceStatus
> {
  readonly id = GET_WORKSPACE_STATUS_OPERATION_ID;

  async execute(ctx: OperationContext<GetWorkspaceStatusIntent>): Promise<WorkspaceStatus> {
    const { payload } = ctx.intent;

    // 1. resolve-project — resolve projectId to projectPath
    const { results: resolveProjectResults, errors: resolveProjectErrors } =
      await ctx.hooks.collect<ResolveProjectHookResult>("resolve-project", {
        intent: ctx.intent,
      });
    if (resolveProjectErrors.length > 0) {
      throw new AggregateError(resolveProjectErrors, "get-workspace-status resolve-project failed");
    }

    let projectPath: string | undefined;
    for (const result of resolveProjectResults) {
      if (result.projectPath !== undefined) projectPath = result.projectPath;
    }
    if (!projectPath) {
      throw new Error(`Project not found: ${payload.projectId}`);
    }

    // 2. resolve-workspace — resolve workspaceName to workspacePath
    const resolveWorkspaceCtx: ResolveWorkspaceHookInput = {
      intent: ctx.intent,
      projectPath,
      workspaceName: payload.workspaceName,
    };
    const { results: resolveWorkspaceResults, errors: resolveWorkspaceErrors } =
      await ctx.hooks.collect<ResolveWorkspaceHookResult>("resolve-workspace", resolveWorkspaceCtx);
    if (resolveWorkspaceErrors.length > 0) {
      throw new AggregateError(
        resolveWorkspaceErrors,
        "get-workspace-status resolve-workspace failed"
      );
    }

    let workspacePath: string | undefined;
    for (const result of resolveWorkspaceResults) {
      if (result.workspacePath !== undefined) workspacePath = result.workspacePath;
    }
    if (!workspacePath) {
      throw new Error(`Workspace not found: ${payload.workspaceName}`);
    }

    // 3. get — each handler contributes its piece
    const getCtx: GetStatusHookInput = {
      intent: ctx.intent,
      workspacePath,
    };
    const { results, errors } = await ctx.hooks.collect<GetStatusHookResult>("get", getCtx);
    if (errors.length > 0) {
      throw new AggregateError(errors, "get-workspace-status get hooks failed");
    }

    // Merge results — isDirty uses OR (any hook says dirty = dirty)
    let isDirty = false;
    let agentStatus: AggregatedAgentStatus | undefined;

    for (const result of results) {
      if (result.isDirty) isDirty = true;
      if (result.agentStatus !== undefined) agentStatus = result.agentStatus;
    }

    const finalAgentStatus = agentStatus ?? {
      status: "none" as const,
      counts: { idle: 0, busy: 0 },
    };

    return {
      isDirty,
      agent:
        finalAgentStatus.status === "none"
          ? { type: "none" }
          : {
              type: finalAgentStatus.status,
              counts: {
                idle: finalAgentStatus.counts.idle,
                busy: finalAgentStatus.counts.busy,
                total: finalAgentStatus.counts.idle + finalAgentStatus.counts.busy,
              },
            },
    };
  }
}
