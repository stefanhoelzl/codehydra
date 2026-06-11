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

import type { Intent } from "./lib/types";
import type { HookContext } from "./lib/operation";
import { WorkspaceHookOperation } from "./lib/workspace-operation";
import { lastDefined, requireResult } from "./lib/hook-helpers";

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

export class GetMetadataOperation extends WorkspaceHookOperation<
  GetMetadataIntent,
  GetMetadataHookResult,
  Readonly<Record<string, string>>
> {
  constructor() {
    super(GET_METADATA_OPERATION_ID, {
      hookPoint: "get",
      errorLabel: "get-metadata get hooks failed",
      extract: (results) =>
        requireResult(
          lastDefined(results, (r) => r.metadata),
          "Get metadata hook did not provide metadata result"
        ),
    });
  }
}
