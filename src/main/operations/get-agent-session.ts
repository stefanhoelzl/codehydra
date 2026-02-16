/**
 * GetAgentSessionOperation - Orchestrates agent session queries.
 *
 * Runs three sequential hook points:
 * 1. "resolve-project": resolve projectId -> projectPath
 * 2. "resolve-workspace": resolve workspaceName -> workspacePath
 * 3. "get": retrieve session info from enriched context
 *
 * No provider dependencies - the hook handlers do the actual work.
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
// Hook Result & Input Types
// =============================================================================

export const GET_AGENT_SESSION_OPERATION_ID = "get-agent-session";

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

    // 1. Resolve project: projectId -> projectPath
    const resolveProjectCtx: HookContext = { intent: ctx.intent };
    const { results: resolveProjectResults, errors: resolveProjectErrors } =
      await ctx.hooks.collect<ResolveProjectHookResult>("resolve-project", resolveProjectCtx);
    if (resolveProjectErrors.length === 1) {
      throw resolveProjectErrors[0]!;
    }
    if (resolveProjectErrors.length > 1) {
      throw new AggregateError(
        resolveProjectErrors,
        "get-agent-session resolve-project hooks failed"
      );
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
        "get-agent-session resolve-workspace hooks failed"
      );
    }
    let workspacePath: string | undefined;
    for (const r of resolveWorkspaceResults) {
      if (r.workspacePath !== undefined) workspacePath = r.workspacePath;
    }
    if (!workspacePath) {
      throw new Error(`Workspace not found: ${payload.workspaceName}`);
    }

    // 3. Get: handler retrieves session info
    const getCtx: GetAgentSessionHookInput = {
      intent: ctx.intent,
      workspacePath,
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
