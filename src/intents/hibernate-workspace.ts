/**
 * HibernateWorkspaceOperation - Tears down a workspace's view + agent server
 * while preserving the worktree, branch, and uncommitted changes.
 *
 * Steps:
 * 1. Dispatch workspace:resolve — workspacePath → projectPath + workspaceName
 * 2. Dispatch project:resolve — projectPath → projectId
 * 3. "capture" hook — best-effort screenshot capture (view-module + screenshot persistence)
 * 4. "shutdown" hook — same handlers as workspace:delete shutdown:
 *    view-module destroys the view, agent-module stops the agent server.
 * 5. Dispatch workspace:set-metadata to persist `hibernated="true"`
 * 6. Emit workspace:hibernated (NOT workspace:deleted — workspace stays in
 *    sidebar/state).
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
  /** If true, do not auto-switch to another workspace when hibernating the active one. */
  readonly skipSwitch?: boolean;
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

/** Input for capture/shutdown hook handlers. */
export interface HibernatePipelineHookInput extends HookContext {
  readonly projectPath: string;
  readonly workspacePath: string;
  readonly projectId: ProjectId;
  readonly workspaceName: WorkspaceName;
}

/** Per-handler result for the "capture" hook point. */
export interface CaptureHookResult {
  /** True if a screenshot was successfully written to disk. */
  readonly captured?: boolean;
}

/** Per-handler result for the "shutdown" hook point. */
export interface HibernateShutdownHookResult {
  readonly wasActive?: boolean;
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

    try {
      // Resolve workspace + project identity
      const { projectPath, workspaceName } = await ctx.dispatch({
        type: INTENT_RESOLVE_WORKSPACE,
        payload: { workspacePath: payload.workspacePath },
      } as ResolveWorkspaceIntent);

      const { projectId } = await ctx.dispatch({
        type: INTENT_RESOLVE_PROJECT,
        payload: { projectPath },
      } as ResolveProjectIntent);

      const hookCtx: HibernatePipelineHookInput = {
        intent: ctx.intent,
        projectPath,
        workspacePath: payload.workspacePath,
        projectId,
        workspaceName,
      };

      // Capture screenshot (best-effort, errors logged but not propagated)
      await ctx.hooks.collect<CaptureHookResult>("capture", hookCtx);

      // Shutdown view + agent (reuses the handlers registered by view-module
      // and agent-module; same semantics as workspace:delete shutdown).
      const { results: shutdownResults } = await ctx.hooks.collect<HibernateShutdownHookResult>(
        "shutdown",
        hookCtx
      );

      let wasActive = false;
      for (const r of shutdownResults) {
        if (r.wasActive) wasActive = true;
      }

      // Persist hibernated flag via existing set-metadata pipeline
      await ctx.dispatch({
        type: INTENT_SET_METADATA,
        payload: {
          workspacePath: payload.workspacePath,
          key: HIBERNATED_METADATA_KEY,
          value: "true",
        },
      } as SetMetadataIntent);

      // If the hibernated workspace was active, auto-switch to an awake
      // sibling; if none exist, fallbackToCurrent keeps the hibernated
      // workspace as active so the renderer shows the hibernation overlay.
      if (wasActive && !payload.skipSwitch) {
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
          // Best-effort: switch failure doesn't fail hibernation
        }
      }

      const event: WorkspaceHibernatedEvent = {
        type: EVENT_WORKSPACE_HIBERNATED,
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
  }
}
