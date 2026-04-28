/**
 * WakeWorkspaceOperation - Marks a hibernated workspace as awake.
 *
 * Steps:
 * 1. Dispatch workspace:resolve — workspacePath → projectPath + workspaceName
 * 2. Dispatch project:resolve — projectPath → projectId
 * 3. Dispatch workspace:set-metadata — clear `hibernated` metadata
 * 4. "cleanup" hook — delete the on-disk screenshot file (best-effort)
 * 5. Emit workspace:woken
 *
 * The operation intentionally does NOT recreate views or start the agent
 * server — the caller (typically the renderer) should follow up with a
 * workspace:open intent (using the existingWorkspace branch) to bring the
 * workspace fully online.
 */

import type { Intent, DomainEvent } from "./lib/types";
import type { Operation, OperationContext, HookContext } from "./lib/operation";
import type { ProjectId, WorkspaceName } from "../shared/api/types";
import { INTENT_RESOLVE_WORKSPACE, type ResolveWorkspaceIntent } from "./resolve-workspace";
import { INTENT_RESOLVE_PROJECT, type ResolveProjectIntent } from "./resolve-project";
import { INTENT_SET_METADATA, type SetMetadataIntent } from "./set-metadata";
import { HIBERNATED_METADATA_KEY } from "./hibernate-workspace";
import { getErrorMessage } from "../shared/error-utils";

// =============================================================================
// Intent Types
// =============================================================================

export interface WakeWorkspacePayload {
  readonly workspacePath: string;
}

export interface WakeWorkspaceIntent extends Intent<{ started: true }> {
  readonly type: "workspace:wake";
  readonly payload: WakeWorkspacePayload;
}

export const INTENT_WAKE_WORKSPACE = "workspace:wake" as const;
export const WAKE_WORKSPACE_OPERATION_ID = "wake-workspace";

// =============================================================================
// Event Types
// =============================================================================

export interface WorkspaceWokenPayload {
  readonly projectId: ProjectId;
  readonly workspaceName: WorkspaceName;
  readonly workspacePath: string;
  readonly projectPath: string;
}

export interface WorkspaceWokenEvent extends DomainEvent {
  readonly type: "workspace:woken";
  readonly payload: WorkspaceWokenPayload;
}

export const EVENT_WORKSPACE_WOKEN = "workspace:woken" as const;

export interface WorkspaceWakeFailedPayload {
  readonly workspacePath: string;
  readonly error: string;
}

export interface WorkspaceWakeFailedEvent extends DomainEvent {
  readonly type: "workspace:wake-failed";
  readonly payload: WorkspaceWakeFailedPayload;
}

export const EVENT_WORKSPACE_WAKE_FAILED = "workspace:wake-failed" as const;

// =============================================================================
// Hook Types
// =============================================================================

export interface WakePipelineHookInput extends HookContext {
  readonly projectPath: string;
  readonly workspacePath: string;
  readonly projectId: ProjectId;
  readonly workspaceName: WorkspaceName;
}

export type CleanupHookResult = Record<string, never>;

// =============================================================================
// Operation
// =============================================================================

export class WakeWorkspaceOperation implements Operation<WakeWorkspaceIntent, { started: true }> {
  readonly id = WAKE_WORKSPACE_OPERATION_ID;

  async execute(ctx: OperationContext<WakeWorkspaceIntent>): Promise<{ started: true }> {
    const { payload } = ctx.intent;

    try {
      const { projectPath, workspaceName } = await ctx.dispatch({
        type: INTENT_RESOLVE_WORKSPACE,
        payload: { workspacePath: payload.workspacePath },
      } as ResolveWorkspaceIntent);

      const { projectId } = await ctx.dispatch({
        type: INTENT_RESOLVE_PROJECT,
        payload: { projectPath },
      } as ResolveProjectIntent);

      // Clear the hibernated metadata flag before re-init so any consumers
      // observing the metadata-changed event see the workspace as awake.
      await ctx.dispatch({
        type: INTENT_SET_METADATA,
        payload: {
          workspacePath: payload.workspacePath,
          key: HIBERNATED_METADATA_KEY,
          value: null,
        },
      } as SetMetadataIntent);

      const hookCtx: WakePipelineHookInput = {
        intent: ctx.intent,
        projectPath,
        workspacePath: payload.workspacePath,
        projectId,
        workspaceName,
      };

      // Best-effort screenshot file cleanup.
      await ctx.hooks.collect<CleanupHookResult>("cleanup", hookCtx);

      const event: WorkspaceWokenEvent = {
        type: EVENT_WORKSPACE_WOKEN,
        payload: {
          projectId,
          workspaceName,
          workspacePath: payload.workspacePath,
          projectPath,
        },
      };
      ctx.emit(event);

      return { started: true };
    } catch (error) {
      const failedEvent: WorkspaceWakeFailedEvent = {
        type: EVENT_WORKSPACE_WAKE_FAILED,
        payload: {
          workspacePath: payload.workspacePath,
          error: getErrorMessage(error),
        },
      };
      ctx.emit(failedEvent);
      throw error;
    }
  }
}
