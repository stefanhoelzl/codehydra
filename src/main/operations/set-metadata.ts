/**
 * SetMetadataOperation - Orchestrates workspace metadata writes.
 *
 * Runs the "set" hook point (where the actual provider write happens),
 * checks for errors, then emits a `workspace:metadata-changed` domain event.
 *
 * No provider dependencies - the hook handler does the actual work.
 */

import type { Intent, DomainEvent } from "../intents/infrastructure/types";
import type { Operation, OperationContext, HookContext } from "../intents/infrastructure/operation";
import type { ProjectId, WorkspaceName } from "../../shared/api/types";

// =============================================================================
// Intent + Event Types
// =============================================================================

export interface SetMetadataPayload {
  readonly projectId: ProjectId;
  readonly workspaceName: WorkspaceName;
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
// Operation
// =============================================================================

export const SET_METADATA_OPERATION_ID = "set-metadata";

export class SetMetadataOperation implements Operation<SetMetadataIntent, void> {
  readonly id = SET_METADATA_OPERATION_ID;

  async execute(ctx: OperationContext<SetMetadataIntent>): Promise<void> {
    const hookCtx: HookContext = {
      intent: ctx.intent,
    };

    // Run "set" hook — handler performs the actual provider write
    await ctx.hooks.run("set", hookCtx);

    // Check for errors from hook handlers
    if (hookCtx.error) {
      throw hookCtx.error;
    }

    // Emit domain event for subscribers (e.g., IpcEventBridge)
    const event: MetadataChangedEvent = {
      type: EVENT_METADATA_CHANGED,
      payload: {
        projectId: ctx.intent.payload.projectId,
        workspaceName: ctx.intent.payload.workspaceName,
        key: ctx.intent.payload.key,
        value: ctx.intent.payload.value,
      },
    };
    ctx.emit(event);
  }
}
