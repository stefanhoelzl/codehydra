/**
 * WakeWorkspaceOperation - Wakes a hibernated workspace and brings it online.
 *
 * Steps:
 * 1. Dispatch workspace:resolve — workspacePath → projectPath + workspaceName + branch
 * 2. Dispatch project:resolve — projectPath → projectId
 * 3. Dispatch workspace:set-metadata — clear `hibernated` metadata (emits
 *    workspace:metadata-changed, which clears the renderer overlay)
 * 4. "cleanup" hook — delete the on-disk screenshot file (best-effort)
 * 5. Dispatch workspace:get-metadata — read back the now-clean metadata
 * 6. Dispatch workspace:open (existingWorkspace branch) — re-run the canonical
 *    open pipeline against the already-existing worktree to restart the agent
 *    server, rebuild the workspace URL, and emit workspace:created (which mounts
 *    the view). stealFocus/source are forwarded so callers control focus and
 *    error-notification behavior, exactly like workspace_create.
 * 7. Emit workspace:woken (releases the per-workspace wake idempotency lock)
 *
 * Returns the reopened Workspace. The metadata-changed event (step 3) is
 * emitted before workspace:created (step 6), so the overlay clears before the
 * new view appears.
 */

import type { Intent, DomainEvent } from "./lib/types";
import type { Operation, OperationContext, HookContext } from "./lib/operation";
import type { ProjectId, WorkspaceName, Workspace } from "../shared/api/types";
import { INTENT_SET_METADATA, type SetMetadataIntent } from "./set-metadata";
import { INTENT_GET_METADATA, type GetMetadataIntent } from "./get-metadata";
import {
  INTENT_OPEN_WORKSPACE,
  type OpenWorkspaceIntent,
  type WorkspaceOpenSource,
} from "./open-workspace";
import { HIBERNATED_METADATA_KEY } from "./hibernate-workspace";
import { resolveWorkspaceIdentity, emitWorkspaceFailure } from "./lib/workspace-identity";

// =============================================================================
// Intent Types
// =============================================================================

export interface WakeWorkspacePayload {
  readonly workspacePath: string;
  /** Forwarded to the internal workspace:open. If true, switch to the woken
   *  workspace; if false, bring it online in the background. Default
   *  (undefined): switch — matching the pre-fold renderer behavior. */
  readonly stealFocus?: boolean;
  /** Forwarded to the internal workspace:open. Identifies the originating
   *  surface so error-notification can skip non-interactive sources (e.g. mcp). */
  readonly source?: WorkspaceOpenSource;
}

export interface WakeWorkspaceIntent extends Intent<Workspace> {
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

export class WakeWorkspaceOperation implements Operation<WakeWorkspaceIntent, Workspace> {
  readonly id = WAKE_WORKSPACE_OPERATION_ID;

  async execute(ctx: OperationContext<WakeWorkspaceIntent>): Promise<Workspace> {
    const { payload } = ctx.intent;

    try {
      const { projectPath, workspaceName, projectId, branch } = await resolveWorkspaceIdentity(
        ctx.dispatch,
        payload.workspacePath
      );

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

      // Read back the now-clean metadata (hibernated flag removed above) so the
      // reopen — and the workspace:created event it emits — carry accurate
      // metadata rather than reintroducing the stale flag.
      const metadata = await ctx.dispatch({
        type: INTENT_GET_METADATA,
        payload: { workspacePath: payload.workspacePath },
      } as GetMetadataIntent);

      // Re-run the canonical open pipeline against the existing worktree to
      // bring the workspace back online (agent server, workspace URL, view).
      const workspace = await ctx.dispatch({
        type: INTENT_OPEN_WORKSPACE,
        payload: {
          projectPath,
          workspaceName,
          existingWorkspace: {
            path: payload.workspacePath,
            name: workspaceName,
            branch,
            metadata,
          },
          ...(payload.stealFocus !== undefined && { stealFocus: payload.stealFocus }),
          ...(payload.source !== undefined && { source: payload.source }),
        },
      } as OpenWorkspaceIntent);

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

      return workspace;
    } catch (error) {
      emitWorkspaceFailure(ctx.emit, EVENT_WORKSPACE_WAKE_FAILED, payload.workspacePath, error);
      throw error;
    }
  }
}
