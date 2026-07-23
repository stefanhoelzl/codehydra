/**
 * GetMetadataOperation - Orchestrates workspace metadata reads.
 *
 * Runs two steps:
 * 1. Dispatch workspace:resolve to validate workspacePath
 * 2. "get" hook — each handler performs the actual provider read
 *
 * No provider dependencies - hook handlers do the actual work.
 * No domain events - this is a query operation.
 *
 * Contract schemas (item 2): zod is the single source of truth; the Intent and hook
 * result/input types are derived from the `schemas` bundle.
 */

import { z } from "zod/v4";
import type { HookContext, OperationSchemas } from "./lib/operation";
import { type IntentOf } from "./lib/operation";
import { hookCtxSchema, workspacePathSchema } from "./contract";
import { WorkspaceHookOperation } from "./lib/workspace-operation";
import { lastDefined, requireResult } from "./lib/hook-helpers";

export const INTENT_GET_METADATA = "workspace:get-metadata" as const;
export const GET_METADATA_OPERATION_ID = "get-metadata";

// =============================================================================
// Contract schemas (single source of truth)
// =============================================================================

export const getMetadataPayloadSchema = z
  .object({
    workspacePath: workspacePathSchema,
  })
  .readonly();

export const getMetadataResultSchema = z.record(z.string(), z.string()).readonly();

/**
 * Per-handler result contract for the "get" hook point.
 * Each handler returns its contribution — the operation merges them.
 */
export const getMetadataHookResultSchema = z
  .object({
    metadata: z.record(z.string(), z.string()).readonly().optional(),
  })
  .readonly();

/** Operation-added enrichment for the "get" hook point (beyond the base HookContext). */
const getMetadataEnrichmentSchema = z.object({ workspacePath: workspacePathSchema });

/** Runtime whole-context validation schema for "get". */
export const getMetadataHookInputSchema = hookCtxSchema(
  getMetadataPayloadSchema,
  getMetadataEnrichmentSchema.shape
);

/**
 * This operation's contract bundle. Exported so consumers (and tests) can take a typed view
 * of its hook points and events via `ResolvedHooks<typeof schemas>` / `EventOf<typeof schemas>`.
 */
export const schemas = {
  type: INTENT_GET_METADATA,
  payload: getMetadataPayloadSchema,
  result: getMetadataResultSchema,
  hooks: {
    get: { input: getMetadataHookInputSchema, result: getMetadataHookResultSchema },
  },
} satisfies OperationSchemas;

// =============================================================================
// Types derived from the schemas
// =============================================================================

export type GetMetadataPayload = z.infer<typeof getMetadataPayloadSchema>;
export type GetMetadataResult = z.infer<typeof getMetadataResultSchema>;
export type GetMetadataIntent = IntentOf<typeof schemas>;
export type GetMetadataHookResult = z.infer<typeof getMetadataHookResultSchema>;

/** Whole input context for "get" handlers: base envelope + inferred enrichment. */
export type GetHookInput = HookContext & z.infer<typeof getMetadataEnrichmentSchema>;

// =============================================================================
// Operation
// =============================================================================

export class GetMetadataOperation extends WorkspaceHookOperation<typeof schemas> {
  readonly schemas = schemas;

  constructor() {
    super(GET_METADATA_OPERATION_ID, {
      hookPoint: "get",
      buildInput: (intent, workspacePath) => ({ intent, workspacePath }),
      errorLabel: "get-metadata get hooks failed",
      extract: (results) =>
        requireResult(
          lastDefined(results, (r) => r.metadata),
          "Get metadata hook did not provide metadata result"
        ),
    });
  }
}
