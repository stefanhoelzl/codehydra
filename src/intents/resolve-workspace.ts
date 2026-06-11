/**
 * ResolveWorkspaceOperation - Shared workspace resolution.
 *
 * Centralizes the workspacePath → (projectPath, workspaceName) lookup
 * used by multiple operations. Each consuming operation dispatches this
 * intent instead of running its own resolve hook.
 *
 * Single hook point:
 * 1. "resolve" — collected from modules (e.g., gitWorktreeWorkspaceModule)
 *
 * Throws if no handler returns projectPath or workspaceName.
 */

import type { Intent } from "./lib/types";
import type { Operation, OperationContext, HookContext } from "./lib/operation";
import type { WorkspaceName } from "../shared/api/types";
import { throwHookErrors } from "./lib/hook-helpers";

// =============================================================================
// Intent Types
// =============================================================================

export interface ResolveWorkspacePayload {
  readonly workspacePath: string;
}

export interface ResolveWorkspaceResult {
  readonly projectPath: string;
  readonly workspaceName: WorkspaceName;
  readonly active: boolean;
  /** Current branch name, or null for detached HEAD. */
  readonly branch: string | null;
}

export interface ResolveWorkspaceIntent extends Intent<ResolveWorkspaceResult> {
  readonly type: "workspace:resolve";
  readonly payload: ResolveWorkspacePayload;
}

export const INTENT_RESOLVE_WORKSPACE = "workspace:resolve" as const;

// =============================================================================
// Hook Types
// =============================================================================

export const RESOLVE_WORKSPACE_OPERATION_ID = "resolve-workspace";

/** Input context for "resolve" handlers. */
export interface ResolveHookInput extends HookContext {
  readonly workspacePath: string;
}

/** Per-handler result for "resolve" hook point. */
export interface ResolveHookResult {
  readonly projectPath?: string;
  readonly workspaceName?: WorkspaceName;
  readonly active?: boolean;
  readonly branch?: string | null;
}

// =============================================================================
// Operation
// =============================================================================

export class ResolveWorkspaceOperation implements Operation<
  ResolveWorkspaceIntent,
  ResolveWorkspaceResult
> {
  readonly id = RESOLVE_WORKSPACE_OPERATION_ID;

  async execute(ctx: OperationContext<ResolveWorkspaceIntent>): Promise<ResolveWorkspaceResult> {
    const { payload } = ctx.intent;

    const resolveCtx: ResolveHookInput = {
      intent: ctx.intent,
      workspacePath: payload.workspacePath,
    };
    const { results, errors } = await ctx.hooks.collect<ResolveHookResult>("resolve", resolveCtx);
    throwHookErrors(errors, "workspace:resolve hooks failed");

    let projectPath: string | undefined;
    let workspaceName: WorkspaceName | undefined;
    let active = false;
    // branch can legitimately be null (detached HEAD), so track "provided"
    // separately from the null value.
    let branch: string | null = null;
    for (const r of results) {
      if (r.projectPath !== undefined) projectPath = r.projectPath;
      if (r.workspaceName !== undefined) workspaceName = r.workspaceName;
      if (r.active === true) active = true;
      if (r.branch !== undefined) branch = r.branch;
    }

    if (!projectPath || !workspaceName) {
      throw new Error(`Workspace not found: ${payload.workspacePath}`);
    }

    return { projectPath, workspaceName, active, branch };
  }
}
