/**
 * HibernateWorkspaceOperation - Tears down a workspace's view + agent server
 * while preserving the worktree, branch, and uncommitted changes.
 *
 * Pipeline is split so the renderer flips to a pending hibernation overlay as
 * soon as the screenshot is on disk; the slow teardown runs in the background:
 *
 * Foreground (awaited by callers, ~500 ms):
 * 1. Dispatch workspace:resolve — yields projectPath, workspaceName, active
 * 2. Dispatch project:resolve — projectPath → projectId
 * 3. "prepare-capture" → "capture" (in a try) → "cleanup-capture" (finally)
 *    hooks — collapse the sidebar out of the shot, take the best-effort
 *    screenshot, then always restore the sidebar
 * 4. Dispatch workspace:set-metadata to persist `hibernated="true"` (this is
 *    what makes the renderer show HibernatedOverlay; switch-workspace's
 *    `c.hibernated` filter also begins excluding the workspace immediately)
 * 5. If active, dispatch workspace:switch so the user is moved to an awake
 *    sibling without waiting for the background teardown
 *
 * Background (fire-and-forget):
 * 6. "shutdown" hook — view-module destroys the view, agent-module stops the
 *    agent server
 * 7. "release" hook — best-effort kill of CWD-rooted processes (Windows
 *    file-lock cleanup; multi-second PowerShell scan)
 * 8. Emit workspace:hibernated (always, via finally) so the dispatcher's
 *    idempotency interceptor releases the per-workspace lock and the renderer
 *    clears its pending entry
 *
 * Background failures are logged only — the user already saw the overlay
 * flip and re-emitting workspace:hibernate-failed at this point would be
 * misleading. The renderer's wake button is hidden while pending, so the
 * teardown does not race a wake intent (only entry point for wake is the
 * renderer's WORKSPACE_WAKE IPC).
 *
 * Intentionally does NOT emit workspace:deleted — consumers (sidebar,
 * workspace-selection-module, badge-module, etc.) should not evict the
 * workspace from their state.
 */

import type { Intent, DomainEvent } from "./lib/types";
import type { Operation, OperationContext, HookContext } from "./lib/operation";
import type { ProjectId, WorkspaceName } from "../shared/api/types";
import { INTENT_RESOLVE_WORKSPACE, type ResolveWorkspaceIntent } from "./resolve-workspace";
import { INTENT_RESOLVE_PROJECT, type ResolveProjectIntent } from "./resolve-project";
import { INTENT_SET_METADATA, type SetMetadataIntent } from "./set-metadata";
import { INTENT_SWITCH_WORKSPACE, type SwitchWorkspaceIntent } from "./switch-workspace";
import { getErrorMessage } from "../shared/error-utils";

// =============================================================================
// Intent Types
// =============================================================================

export interface HibernateWorkspacePayload {
  readonly workspacePath: string;
}

export interface HibernateWorkspaceIntent extends Intent<{ started: true }> {
  readonly type: "workspace:hibernate";
  readonly payload: HibernateWorkspacePayload;
}

export const INTENT_HIBERNATE_WORKSPACE = "workspace:hibernate" as const;

export const HIBERNATE_WORKSPACE_OPERATION_ID = "hibernate-workspace";

/** Metadata key indicating a workspace is hibernated. */
export const HIBERNATED_METADATA_KEY = "hibernated";

// =============================================================================
// Event Types
// =============================================================================

export interface WorkspaceHibernatedPayload {
  readonly projectId: ProjectId;
  readonly workspaceName: WorkspaceName;
  readonly workspacePath: string;
  readonly projectPath: string;
}

export interface WorkspaceHibernatedEvent extends DomainEvent {
  readonly type: "workspace:hibernated";
  readonly payload: WorkspaceHibernatedPayload;
}

export const EVENT_WORKSPACE_HIBERNATED = "workspace:hibernated" as const;

export interface WorkspaceHibernateFailedPayload {
  readonly workspacePath: string;
  readonly error: string;
}

export interface WorkspaceHibernateFailedEvent extends DomainEvent {
  readonly type: "workspace:hibernate-failed";
  readonly payload: WorkspaceHibernateFailedPayload;
}

export const EVENT_WORKSPACE_HIBERNATE_FAILED = "workspace:hibernate-failed" as const;

// =============================================================================
// Hook Types
// =============================================================================

/** Input for prepare-capture/capture/cleanup-capture/shutdown/release hook handlers. */
export interface HibernatePipelineHookInput extends HookContext {
  readonly projectPath: string;
  readonly workspacePath: string;
  readonly projectId: ProjectId;
  readonly workspaceName: WorkspaceName;
  readonly active: boolean;
}

/**
 * Per-handler result for the "prepare-capture" hook point. Runs before the
 * screenshot so the presenter can collapse the sidebar out of the capture.
 */
export type PrepareCaptureHookResult = Record<string, never>;

/** Per-handler result for the "capture" hook point. */
export type CaptureHookResult = Record<string, never>;

/**
 * Per-handler result for the "cleanup-capture" hook point. Runs in the
 * operation's `finally` (even if capture throws) so the presenter always
 * restores the sidebar and can never leave it stuck collapsed.
 */
export type CleanupCaptureHookResult = Record<string, never>;

/** Per-handler result for the "shutdown" hook point. */
export type HibernateShutdownHookResult = Record<string, never>;

/**
 * Per-handler result for the "release" hook point.
 * Best-effort CWD-rooted process kill.
 */
export interface HibernateReleaseHookResult {
  readonly error?: string;
}

// =============================================================================
// Operation
// =============================================================================

export class HibernateWorkspaceOperation implements Operation<
  HibernateWorkspaceIntent,
  { started: true }
> {
  readonly id = HIBERNATE_WORKSPACE_OPERATION_ID;

  async execute(ctx: OperationContext<HibernateWorkspaceIntent>): Promise<{ started: true }> {
    const { payload } = ctx.intent;

    let hookCtx: HibernatePipelineHookInput;
    let projectId: ProjectId;
    let projectPath: string;
    let workspaceName: WorkspaceName;

    try {
      // ─── Foreground ──────────────────────────────────────────────────────
      let active: boolean;
      ({ projectPath, workspaceName, active } = await ctx.dispatch({
        type: INTENT_RESOLVE_WORKSPACE,
        payload: { workspacePath: payload.workspacePath },
      } as ResolveWorkspaceIntent));

      ({ projectId } = await ctx.dispatch({
        type: INTENT_RESOLVE_PROJECT,
        payload: { projectPath },
      } as ResolveProjectIntent));

      hookCtx = {
        intent: ctx.intent,
        projectPath,
        workspacePath: payload.workspacePath,
        projectId,
        workspaceName,
        active,
      };

      // Capture screenshot (best-effort, errors logged but not propagated).
      // Must complete in the foreground so the overlay has a file:// URL to
      // load when the metadata flip below triggers the renderer.
      //
      // "prepare-capture" collapses the sidebar out of the shot (the presenter
      // owns the sidebar UI state); "cleanup-capture" restores it. Cleanup runs
      // in `finally` so a stuck capturing flag can never leave the sidebar
      // permanently collapsed, even if the capture hook throws.
      await ctx.hooks.collect<PrepareCaptureHookResult>("prepare-capture", hookCtx);
      try {
        await ctx.hooks.collect<CaptureHookResult>("capture", hookCtx);
      } finally {
        await ctx.hooks.collect<CleanupCaptureHookResult>("cleanup-capture", hookCtx);
      }

      // Persist hibernated flag via existing set-metadata pipeline. This is
      // what makes the renderer swap in HibernatedOverlay via the
      // workspace:metadata-changed → WORKSPACE_METADATA_CHANGED IPC, and
      // makes switch-workspace's `c.hibernated` filter exclude us.
      await ctx.dispatch({
        type: INTENT_SET_METADATA,
        payload: {
          workspacePath: payload.workspacePath,
          key: HIBERNATED_METADATA_KEY,
          value: "true",
        },
      } as SetMetadataIntent);

      // If the hibernated workspace was active, switch to an awake sibling
      // immediately so the user is moved away while the teardown runs in the
      // background. fallbackToCurrent keeps the hibernated workspace as
      // active when no awake sibling exists; the renderer then shows the
      // pending hibernation overlay over it.
      if (active) {
        try {
          await ctx.dispatch({
            type: INTENT_SWITCH_WORKSPACE,
            payload: {
              auto: true,
              currentPath: payload.workspacePath,
              focus: true,
              fallbackToCurrent: true,
            },
          } as SwitchWorkspaceIntent);
        } catch {
          // Best-effort: switch failure doesn't fail hibernation.
        }
      }
    } catch (error) {
      const failedEvent: WorkspaceHibernateFailedEvent = {
        type: EVENT_WORKSPACE_HIBERNATE_FAILED,
        payload: {
          workspacePath: payload.workspacePath,
          error: getErrorMessage(error),
        },
      };
      ctx.emit(failedEvent);
      throw error;
    }

    // ─── Background ────────────────────────────────────────────────────────
    // Fire-and-forget; failures are logged by the dispatcher's hook runner.
    // The renderer's wake button is hidden until workspace:hibernated fires,
    // so no wake intent can race the teardown.
    void (async () => {
      try {
        await ctx.hooks.collect<HibernateShutdownHookResult>("shutdown", hookCtx);
        await ctx.hooks.collect<HibernateReleaseHookResult>("release", hookCtx);
      } finally {
        // Always emit so the dispatcher's idempotency interceptor releases
        // the per-workspace lock and the renderer clears its pending entry.
        const event: WorkspaceHibernatedEvent = {
          type: EVENT_WORKSPACE_HIBERNATED,
          payload: {
            projectId,
            workspaceName,
            workspacePath: payload.workspacePath,
            projectPath,
          },
        };
        void ctx.emit(event);
      }
    })();

    return { started: true };
  }
}
