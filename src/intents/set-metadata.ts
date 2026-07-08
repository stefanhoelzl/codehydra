/**
 * SetMetadataOperation - Orchestrates workspace metadata writes.
 *
 * Runs three steps:
 * 1. Dispatch workspace:resolve — validates workspacePath, returns projectPath + workspaceName
 * 2. Dispatch project:resolve — resolves projectPath to projectId (for domain events)
 * 3. "set" hook — each handler performs the actual provider write
 *
 * No provider dependencies - hook handlers do the actual work.
 */

import { z } from "zod/v4";
import type { DomainEvent } from "./lib/types";
import type { OperationSchemas, HookContext } from "./lib/operation";
import { type IntentOf } from "./lib/operation";
import { projectIdSchema, workspaceNameSchema, hookCtxSchema } from "./contract";
import { WorkspaceHookOperation } from "./lib/workspace-operation";

export const INTENT_SET_METADATA = "workspace:set-metadata" as const;
export const EVENT_METADATA_CHANGED = "workspace:metadata-changed" as const;
export const SET_METADATA_OPERATION_ID = "set-metadata";

// =============================================================================
// Contract schemas (single source of truth)
// =============================================================================

export const setMetadataPayloadSchema = z
  .object({
    workspacePath: z.string(),
    key: z.string(),
    value: z.string().nullable(),
  })
  .readonly();

export const metadataChangedPayloadSchema = z
  .object({
    projectId: projectIdSchema,
    workspaceName: workspaceNameSchema,
    workspacePath: z.string(),
    key: z.string(),
    value: z.string().nullable(),
  })
  .readonly();

/** Operation-added enrichment for the "set" hook point (beyond the base HookContext). */
const setEnrichmentSchema = z.object({ workspacePath: z.string() });

/** Runtime whole-context validation schema for the "set" hook point. */
export const setHookInputSchema = hookCtxSchema(
  setMetadataPayloadSchema,
  setEnrichmentSchema.shape
);

const schemas = {
  type: INTENT_SET_METADATA,
  payload: setMetadataPayloadSchema,
  hooks: {
    set: { input: setHookInputSchema },
  },
  events: {
    [EVENT_METADATA_CHANGED]: metadataChangedPayloadSchema,
  },
} satisfies OperationSchemas;

// =============================================================================
// Types derived from the schemas
// =============================================================================

export type SetMetadataPayload = z.infer<typeof setMetadataPayloadSchema>;
export type SetMetadataIntent = IntentOf<typeof schemas>;
export type MetadataChangedPayload = z.infer<typeof metadataChangedPayloadSchema>;

export interface MetadataChangedEvent extends DomainEvent {
  readonly type: "workspace:metadata-changed";
  readonly payload: MetadataChangedPayload;
}

/** Input context for "set" handlers — built from resolve results. */
export type SetHookInput = HookContext & z.infer<typeof setEnrichmentSchema>;

// =============================================================================
// Operation
// =============================================================================

export class SetMetadataOperation extends WorkspaceHookOperation<typeof schemas, void> {
  readonly schemas = schemas;

  constructor() {
    super(SET_METADATA_OPERATION_ID, {
      hookPoint: "set",
      resolveProject: true,
      errorLabel: "set-metadata set hooks failed",
      extract: () => undefined,
      onSuccess: ({ intent, resolved, project }) =>
        ({
          type: EVENT_METADATA_CHANGED,
          payload: {
            projectId: project!.projectId,
            workspaceName: resolved.workspaceName,
            workspacePath: intent.payload.workspacePath,
            key: intent.payload.key,
            value: intent.payload.value,
          },
        }) satisfies MetadataChangedEvent,
    });
  }
}
