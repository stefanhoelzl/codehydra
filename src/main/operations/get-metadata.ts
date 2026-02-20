/**
 * GetMetadataOperation - Orchestrates workspace metadata reads.
 *
 * Runs two steps:
 * 1. Dispatch workspace:resolve to validate workspacePath
 * 2. "get" hook — each handler performs the actual provider read
 *
 * No provider dependencies - hook handlers do the actual work.
 * No domain events - this is a query operation.
 */

import type { Intent } from "../intents/infrastructure/types";
import type { Operation, OperationContext, HookContext } from "../intents/infrastructure/operation";
import { INTENT_RESOLVE_WORKSPACE, type ResolveWorkspaceIntent } from "./resolve-workspace";

// =============================================================================
// Intent Types
// =============================================================================

export interface GetMetadataPayload {
  readonly workspacePath: string;
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
 * Input context for "get" handlers — built from resolve results.
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

    // 1. Dispatch shared workspace resolution
    await ctx.dispatch({
      type: INTENT_RESOLVE_WORKSPACE,
      payload: { workspacePath: payload.workspacePath },
    } as ResolveWorkspaceIntent);

    // 2. get — handler performs the actual provider read
    const getCtx: GetHookInput = {
      intent: ctx.intent,
      workspacePath: payload.workspacePath,
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
