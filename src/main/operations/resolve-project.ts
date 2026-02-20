/**
 * ResolveProjectOperation - Shared project resolution.
 *
 * Centralizes the projectPath → (projectId, projectName) lookup
 * used by multiple operations. Each consuming operation dispatches this
 * intent instead of running its own resolve-project hook.
 *
 * Single hook point:
 * 1. "resolve" — collected from modules (e.g., localProjectModule)
 *
 * Throws if no handler returns projectId.
 */

import type { Intent } from "../intents/infrastructure/types";
import type { Operation, OperationContext, HookContext } from "../intents/infrastructure/operation";
import type { ProjectId } from "../../shared/api/types";

// =============================================================================
// Intent Types
// =============================================================================

export interface ResolveProjectPayload {
  readonly projectPath: string;
}

export interface ResolveProjectResult {
  readonly projectId: ProjectId;
  readonly projectName: string;
}

export interface ResolveProjectIntent extends Intent<ResolveProjectResult> {
  readonly type: "project:resolve";
  readonly payload: ResolveProjectPayload;
}

export const INTENT_RESOLVE_PROJECT = "project:resolve" as const;

// =============================================================================
// Hook Types
// =============================================================================

export const RESOLVE_PROJECT_OPERATION_ID = "resolve-project";

/** Input context for "resolve" handlers. */
export interface ResolveHookInput extends HookContext {
  readonly projectPath: string;
}

/** Per-handler result for "resolve" hook point. */
export interface ResolveHookResult {
  readonly projectId?: ProjectId;
  readonly projectName?: string;
}

// =============================================================================
// Operation
// =============================================================================

export class ResolveProjectOperation implements Operation<
  ResolveProjectIntent,
  ResolveProjectResult
> {
  readonly id = RESOLVE_PROJECT_OPERATION_ID;

  async execute(ctx: OperationContext<ResolveProjectIntent>): Promise<ResolveProjectResult> {
    const { payload } = ctx.intent;

    const resolveCtx: ResolveHookInput = {
      intent: ctx.intent,
      projectPath: payload.projectPath,
    };
    const { results, errors } = await ctx.hooks.collect<ResolveHookResult>("resolve", resolveCtx);
    if (errors.length === 1) {
      throw errors[0]!;
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "project:resolve hooks failed");
    }

    let projectId: ProjectId | undefined;
    let projectName: string | undefined;
    for (const r of results) {
      if (r.projectId !== undefined) projectId = r.projectId;
      if (r.projectName !== undefined) projectName = r.projectName;
    }

    if (!projectId) {
      throw new Error(`Project not found for path: ${payload.projectPath}`);
    }

    return { projectId, projectName: projectName ?? "" };
  }
}
