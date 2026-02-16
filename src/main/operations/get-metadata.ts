/**
 * GetMetadataOperation - Orchestrates workspace metadata reads.
 *
 * Runs three hook points in sequence:
 * 1. "resolve-project" - Resolves projectId to projectPath
 * 2. "resolve-workspace" - Resolves workspaceName to workspacePath
 * 3. "get" - Each handler performs the actual provider read
 *
 * No provider dependencies - hook handlers do the actual work.
 * No domain events - this is a query operation.
 */

import type { Intent } from "../intents/infrastructure/types";
import type { Operation, OperationContext, HookContext } from "../intents/infrastructure/operation";
import type { ProjectId, WorkspaceName } from "../../shared/api/types";

// =============================================================================
// Intent Types
// =============================================================================

export interface GetMetadataPayload {
  readonly projectId: ProjectId;
  readonly workspaceName: WorkspaceName;
}

export interface GetMetadataIntent extends Intent<Readonly<Record<string, string>>> {
  readonly type: "workspace:get-metadata";
  readonly payload: GetMetadataPayload;
}

export const INTENT_GET_METADATA = "workspace:get-metadata" as const;

// =============================================================================
// Hook Types
// =============================================================================

export const GET_METADATA_OPERATION_ID = "get-metadata";

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
export interface GetHookInput extends HookContext {
  readonly workspacePath: string;
}

/**
 * Per-handler result contract for the "get" hook point.
 * Each handler returns its contribution — the operation merges them.
 */
export interface GetMetadataHookResult {
  readonly metadata: Readonly<Record<string, string>>;
}

// =============================================================================
// Operation
// =============================================================================

export class GetMetadataOperation implements Operation<
  GetMetadataIntent,
  Readonly<Record<string, string>>
> {
  readonly id = GET_METADATA_OPERATION_ID;

  async execute(
    ctx: OperationContext<GetMetadataIntent>
  ): Promise<Readonly<Record<string, string>>> {
    const { payload } = ctx.intent;

    // 1. resolve-project — resolve projectId to projectPath
    const { results: resolveProjectResults, errors: resolveProjectErrors } =
      await ctx.hooks.collect<ResolveProjectHookResult>("resolve-project", {
        intent: ctx.intent,
      });
    if (resolveProjectErrors.length > 0) {
      throw new AggregateError(resolveProjectErrors, "get-metadata resolve-project failed");
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
      throw new AggregateError(resolveWorkspaceErrors, "get-metadata resolve-workspace failed");
    }

    let workspacePath: string | undefined;
    for (const result of resolveWorkspaceResults) {
      if (result.workspacePath !== undefined) workspacePath = result.workspacePath;
    }
    if (!workspacePath) {
      throw new Error(`Workspace not found: ${payload.workspaceName}`);
    }

    // 3. get — handler performs the actual provider read
    const getCtx: GetHookInput = {
      intent: ctx.intent,
      workspacePath,
    };
    const { results, errors } = await ctx.hooks.collect<GetMetadataHookResult>("get", getCtx);
    if (errors.length > 0) {
      throw errors[0]!;
    }

    // Merge results — last-write-wins for metadata
    let metadata: Readonly<Record<string, string>> | undefined;
    for (const result of results) {
      if (result.metadata !== undefined) metadata = result.metadata;
    }

    if (metadata === undefined) {
      throw new Error("Get metadata hook did not provide metadata result");
    }

    return metadata;
  }
}
