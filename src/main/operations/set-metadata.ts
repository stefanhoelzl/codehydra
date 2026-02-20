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

import type { Intent, DomainEvent } from "../intents/infrastructure/types";
import type { Operation, OperationContext, HookContext } from "../intents/infrastructure/operation";
import type { ProjectId, WorkspaceName } from "../../shared/api/types";
import { INTENT_RESOLVE_WORKSPACE, type ResolveWorkspaceIntent } from "./resolve-workspace";
import { INTENT_RESOLVE_PROJECT, type ResolveProjectIntent } from "./resolve-project";

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

export class SetMetadataOperation implements Operation<SetMetadataIntent, void> {
  readonly id = SET_METADATA_OPERATION_ID;

  async execute(ctx: OperationContext<SetMetadataIntent>): Promise<void> {
    const { payload } = ctx.intent;

    // 1. Dispatch shared workspace resolution
    const { projectPath, workspaceName } = await ctx.dispatch({
      type: INTENT_RESOLVE_WORKSPACE,
      payload: { workspacePath: payload.workspacePath },
    } as ResolveWorkspaceIntent);

    // 2. Dispatch shared project resolution
    const { projectId } = await ctx.dispatch({
      type: INTENT_RESOLVE_PROJECT,
      payload: { projectPath },
    } as ResolveProjectIntent);

    // 3. set — handler performs the actual provider write
    const setCtx: SetHookInput = {
      intent: ctx.intent,
      workspacePath: payload.workspacePath,
    };
    const { errors } = await ctx.hooks.collect<void>("set", setCtx);
    if (errors.length > 0) {
      throw errors[0]!;
    }

    // Emit domain event for subscribers (e.g., IpcEventBridge)
    const event: MetadataChangedEvent = {
      type: EVENT_METADATA_CHANGED,
      payload: {
        projectId,
        workspaceName,
        key: payload.key,
        value: payload.value,
      },
    };
    ctx.emit(event);
  }
}
