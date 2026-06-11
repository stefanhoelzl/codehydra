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

import type { Intent, DomainEvent } from "./lib/types";
import type { HookContext } from "./lib/operation";
import type { ProjectId, WorkspaceName } from "../shared/api/types";
import { WorkspaceHookOperation } from "./lib/workspace-operation";

// =============================================================================
// Intent + Event Types
// =============================================================================

export interface SetMetadataPayload {
  readonly workspacePath: string;
  readonly key: string;
  readonly value: string | null;
}

export interface SetMetadataIntent extends Intent<void> {
  readonly type: "workspace:set-metadata";
  readonly payload: SetMetadataPayload;
}

export interface MetadataChangedPayload {
  readonly projectId: ProjectId;
  readonly workspaceName: WorkspaceName;
  readonly workspacePath: string;
  readonly key: string;
  readonly value: string | null;
}

export interface MetadataChangedEvent extends DomainEvent {
  readonly type: "workspace:metadata-changed";
  readonly payload: MetadataChangedPayload;
}

export const INTENT_SET_METADATA = "workspace:set-metadata" as const;
export const EVENT_METADATA_CHANGED = "workspace:metadata-changed" as const;

// =============================================================================
// Hook Types
// =============================================================================

export const SET_METADATA_OPERATION_ID = "set-metadata";

/**
 * Input context for "set" handlers — built from resolve results.
 */
export interface SetHookInput extends HookContext {
  readonly workspacePath: string;
}

// =============================================================================
// Operation
// =============================================================================

export class SetMetadataOperation extends WorkspaceHookOperation<SetMetadataIntent, void, void> {
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
