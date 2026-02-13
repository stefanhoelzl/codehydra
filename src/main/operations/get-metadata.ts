/**
 * GetMetadataOperation - Orchestrates workspace metadata reads.
 *
 * Runs the "get" hook point (where the actual provider read happens),
 * checks for errors, then returns the metadata from the extended hook context.
 *
 * No provider dependencies - the hook handler does the actual work.
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
// Operation
// =============================================================================

export const GET_METADATA_OPERATION_ID = "get-metadata";

/**
 * Per-handler result contract for the "get" hook point.
 * Each handler returns its contribution — the operation merges them.
 */
export interface GetMetadataHookResult {
  readonly metadata: Readonly<Record<string, string>>;
}

export class GetMetadataOperation implements Operation<
  GetMetadataIntent,
  Readonly<Record<string, string>>
> {
  readonly id = GET_METADATA_OPERATION_ID;

  async execute(
    ctx: OperationContext<GetMetadataIntent>
  ): Promise<Readonly<Record<string, string>>> {
    const hookCtx: HookContext = {
      intent: ctx.intent,
    };

    // Run "get" hook — handler performs the actual provider read
    const { results, errors } = await ctx.hooks.collect<GetMetadataHookResult>("get", hookCtx);
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
