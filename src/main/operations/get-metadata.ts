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
 * Extended hook context for get-metadata.
 * The "get" hook handler populates `metadata` with the result.
 */
export interface GetMetadataHookContext extends HookContext {
  metadata?: Readonly<Record<string, string>>;
}

export class GetMetadataOperation implements Operation<
  GetMetadataIntent,
  Readonly<Record<string, string>>
> {
  readonly id = GET_METADATA_OPERATION_ID;

  async execute(
    ctx: OperationContext<GetMetadataIntent>
  ): Promise<Readonly<Record<string, string>>> {
    const hookCtx: GetMetadataHookContext = {
      intent: ctx.intent,
    };

    // Run "get" hook — handler performs the actual provider read
    // and stores the result in hookCtx.metadata
    await ctx.hooks.run("get", hookCtx);

    // Check for errors from hook handlers
    if (hookCtx.error) {
      throw hookCtx.error;
    }

    // Read metadata from the extended context
    if (hookCtx.metadata === undefined) {
      throw new Error("Get metadata hook did not provide metadata result");
    }

    return hookCtx.metadata;
  }
}
