/**
 * OpenProjectOperation - Orchestrates project opening.
 *
 * Runs 3 sequential hook points using collect() for isolated contexts:
 * 1. "resolve": clone if URL, validate git → ResolveHookResult
 * 2. "register": generate ID, store state, persist → RegisterHookResult
 * 3. "discover": find existing workspaces → DiscoverHookResult
 *
 * The operation mediates data flow between hook points — only pure data
 * flows through contexts. Providers are module dependencies via closure.
 *
 * After hooks, dispatches workspace:open per discovered workspace (best-effort)
 * and emits project:opened. View activation is handled by the projectViewModule
 * event handler (registered in bootstrap).
 */

import type { Intent, DomainEvent } from "./lib/types";
import type { Operation, OperationContext, HookContext } from "./lib/operation";
import type { ProjectId, Project } from "../shared/api/types";
import type { Workspace as InternalWorkspace } from "../boundaries/platform/git-types";
import {
  INTENT_OPEN_WORKSPACE,
  type OpenWorkspaceIntent,
  type ExistingWorkspaceData,
} from "./open-workspace";
import { INTENT_SWITCH_WORKSPACE, type SwitchWorkspaceIntent } from "./switch-workspace";
import { INTENT_GET_ACTIVE_WORKSPACE, type GetActiveWorkspaceIntent } from "./get-active-workspace";
import { HIBERNATED_METADATA_KEY } from "./hibernate-workspace";
import { toIpcWorkspaces } from "../utils/workspace-conversion";
import { Path } from "../utils/path/path";
import { throwHookErrors } from "./lib/hook-helpers";

// =============================================================================
// Intent Types
// =============================================================================

export interface OpenProjectPayload {
  /** Absolute local filesystem path. Set by projects.open. */
  readonly path?: Path;
  /** Git URL or shorthand (e.g. "org/repo"). Set by the creation module's clone sub-dialog. */
  readonly git?: string;
}

export interface OpenProjectIntent extends Intent<Project> {
  readonly type: "project:open";
  readonly payload: OpenProjectPayload;
}

export const INTENT_OPEN_PROJECT = "project:open" as const;

// =============================================================================
// Event Types
// =============================================================================

export interface ProjectOpenedPayload {
  readonly project: Project;
  /** Original intent path, for idempotency reset. */
  readonly path?: Path;
  /** Original intent git URL, for idempotency reset. */
  readonly git?: string;
}

export interface ProjectOpenedEvent extends DomainEvent {
  readonly type: "project:opened";
  readonly payload: ProjectOpenedPayload;
}

export const EVENT_PROJECT_OPENED = "project:opened" as const;

export interface ProjectOpenFailedPayload {
  /** Original intent path, for idempotency reset. */
  readonly path?: Path;
  /** Original intent git URL, for idempotency reset. */
  readonly git?: string;
  /** Reason the open failed (error message or "already-open"). */
  readonly reason: string;
}

export interface ProjectOpenFailedEvent extends DomainEvent {
  readonly type: "project:open-failed";
  readonly payload: ProjectOpenFailedPayload;
}

export const EVENT_PROJECT_OPEN_FAILED = "project:open-failed" as const;

// =============================================================================
// Hook Result & Input Types
// =============================================================================

export const OPEN_PROJECT_OPERATION_ID = "open-project";

/** Result returned by handlers on the "select-folder" hook point. */
export interface SelectFolderHookResult {
  readonly folderPath: string | null;
}

/** Result returned by handlers on the "prepare" hook point. */
export interface PrepareHookResult {
  /** If true, user canceled — abort the open operation. */
  readonly canceled?: boolean;
}

/** Result returned by handlers on the "resolve" hook point. */
export interface ResolveHookResult {
  /** Optional when using collect() — handler may skip via self-selection. */
  readonly projectPath?: string;
  readonly remoteUrl?: string;
  /** If true, the project is already open — skip workspace:open and event emission. */
  readonly alreadyOpen?: boolean;
}

/** Result returned by handlers on the "discover" hook point. */
export interface DiscoverHookResult {
  readonly workspaces: readonly InternalWorkspace[];
  readonly defaultBaseBranch?: string;
}

/** Result returned by handlers on the "register" hook point. */
export interface RegisterHookResult {
  /** Optional when using collect() — handler may skip via self-selection. */
  readonly projectId?: ProjectId;
  readonly name?: string;
  /** If true, the project is already open — skip workspace:open and event emission. */
  readonly alreadyOpen?: boolean;
}

/** Input context for the "discover" hook point. */
export interface DiscoverHookInput extends HookContext {
  readonly projectPath: string;
}

/** Callback for reporting clone progress from a resolve hook. */
export type CloneProgressReporter = (stage: string, progress: number, name: string) => void;

/** Input context for the "resolve" hook point. */
export interface ResolveHookInput extends HookContext {
  readonly report: CloneProgressReporter;
}

// =============================================================================
// Clone Progress Event Types
// =============================================================================

export const EVENT_CLONE_PROGRESS = "clone:progress" as const;

export interface CloneProgressPayload {
  readonly stage: string;
  readonly progress: number;
  readonly name: string;
  readonly url: string;
}

export interface CloneProgressEvent extends DomainEvent {
  readonly type: typeof EVENT_CLONE_PROGRESS;
  readonly payload: CloneProgressPayload;
}

/** Input context for the "register" hook point. */
export interface RegisterHookInput extends HookContext {
  readonly projectPath: string;
  readonly remoteUrl?: string;
}

// =============================================================================
// Operation
// =============================================================================

export class OpenProjectOperation implements Operation<OpenProjectIntent, Project | null> {
  readonly id = OPEN_PROJECT_OPERATION_ID;

  async execute(ctx: OperationContext<OpenProjectIntent>): Promise<Project | null> {
    const { intent } = ctx;

    // Intent-origin fields for idempotency reset events
    const origin = {
      ...(intent.payload.path !== undefined && { path: intent.payload.path }),
      ...(intent.payload.git !== undefined && { git: intent.payload.git }),
    };

    // 0. Select folder: when no path or git URL provided, run "select-folder" hook
    let effectiveIntent = intent;
    if (!intent.payload.path && !intent.payload.git) {
      const selectCtx: HookContext = { intent };
      const { results: selectResults, errors: selectErrors } =
        await ctx.hooks.collect<SelectFolderHookResult>("select-folder", selectCtx);
      throwHookErrors(selectErrors, "project:open select-folder hooks failed");
      let folderPath: string | null = null;
      for (const r of selectResults) {
        if (r.folderPath) folderPath = r.folderPath;
      }
      if (!folderPath) {
        return null; // User canceled dialog
      }
      // Construct effective intent with the selected path
      effectiveIntent = {
        ...intent,
        payload: { ...intent.payload, path: new Path(folderPath) },
      };
    }

    // 0.5. Prepare: give modules a chance to prepare the directory (e.g., git init)
    // Only runs for local paths, not git URLs
    if (effectiveIntent.payload.path && !effectiveIntent.payload.git) {
      const prepareCtx: HookContext = { intent: effectiveIntent };
      const { results: prepareResults, errors: prepareErrors } =
        await ctx.hooks.collect<PrepareHookResult>("prepare", prepareCtx);
      throwHookErrors(prepareErrors, "project:open prepare hooks failed");
      for (const r of prepareResults) {
        if (r.canceled) return null;
      }
    }

    try {
      // Create clone progress reporter that emits domain events
      const gitUrl = effectiveIntent.payload.git ?? "";
      const report: CloneProgressReporter = (stage, progress, name) => {
        ctx.emit({
          type: EVENT_CLONE_PROGRESS,
          payload: { stage, progress, name, url: gitUrl },
        } as CloneProgressEvent);
      };

      // 1. Resolve: clone if URL, validate git, return projectPath + remoteUrl
      const resolveCtx: ResolveHookInput = { intent: effectiveIntent, report };
      const { results: resolveResults, errors: resolveErrors } =
        await ctx.hooks.collect<ResolveHookResult>("resolve", resolveCtx);
      throwHookErrors(resolveErrors, "project:open resolve hooks failed");
      let projectPath: string | undefined;
      let resolvedRemoteUrl: string | undefined;
      let alreadyOpen = false;
      for (const r of resolveResults) {
        if (r.projectPath && !projectPath) projectPath = r.projectPath;
        if (r.remoteUrl !== undefined) resolvedRemoteUrl = r.remoteUrl;
        if (r.alreadyOpen) alreadyOpen = true;
      }
      if (!projectPath) {
        throw new Error("Resolve hook did not provide projectPath");
      }

      // 2. Register: generate ID, store state, persist
      const registerCtx: RegisterHookInput = {
        intent: effectiveIntent,
        projectPath,
        ...(resolvedRemoteUrl !== undefined && { remoteUrl: resolvedRemoteUrl }),
      };
      const { results: registerResults, errors: registerErrors } =
        await ctx.hooks.collect<RegisterHookResult>("register", registerCtx);
      throwHookErrors(registerErrors, "project:open register hooks failed");
      let projectId: ProjectId | undefined;
      let name: string | undefined;
      for (const r of registerResults) {
        if (r.projectId) projectId = r.projectId;
        if (r.name !== undefined) name = r.name;
        if (r.alreadyOpen) alreadyOpen = true;
      }
      if (!projectId) {
        throw new Error("Register hook did not provide projectId");
      }

      // 3. Discover: find existing workspaces
      const discoverCtx: DiscoverHookInput = { intent: effectiveIntent, projectPath };
      const { results: discoverResults, errors: discoverErrors } =
        await ctx.hooks.collect<DiscoverHookResult>("discover", discoverCtx);
      throwHookErrors(discoverErrors, "project:open discover hooks failed");
      const workspaces: InternalWorkspace[] = [];
      let defaultBaseBranch: string | undefined;
      for (const r of discoverResults) {
        if (r.workspaces) workspaces.push(...r.workspaces);
        if (r.defaultBaseBranch !== undefined) defaultBaseBranch = r.defaultBaseBranch;
      }

      // Build Project return value
      let project: Project = {
        id: projectId,
        path: projectPath,
        name: name ?? new Path(projectPath).basename,
        workspaces: toIpcWorkspaces(workspaces, projectId),
        ...(defaultBaseBranch !== undefined && { defaultBaseBranch }),
        ...(resolvedRemoteUrl !== undefined && { remoteUrl: resolvedRemoteUrl }),
      };

      // When already open, register + discover ran (idempotent) but skip side effects
      if (!alreadyOpen) {
        // Dispatch workspace:open per discovered workspace (best-effort).
        // Hibernated workspaces stay inert at startup — no view + agent init runs;
        // they appear in the sidebar with the hibernation indicator.
        const urlByPath = new Map<string, string>();
        for (const workspace of workspaces) {
          if (workspace.metadata[HIBERNATED_METADATA_KEY] === "true") continue;
          try {
            const existingWorkspace: ExistingWorkspaceData = {
              path: workspace.path.toString(),
              name: workspace.name,
              branch: workspace.branch,
              metadata: workspace.metadata,
            };

            const openWsIntent: OpenWorkspaceIntent = {
              type: INTENT_OPEN_WORKSPACE,
              payload: {
                workspaceName: workspace.name,
                base: workspace.metadata.base ?? "",
                existingWorkspace,
                projectPath,
                stealFocus: false,
                source: "open-project",
              },
            };

            const opened = await ctx.dispatch(openWsIntent);
            if (opened?.url !== undefined) {
              urlByPath.set(opened.path, opened.url);
            }
          } catch {
            // Best-effort: individual workspace:open failures don't fail the project open
          }
        }

        // Carry each opened workspace's code-server URL so the renderer can
        // mount iframes for workspaces it learns about via project:opened
        // (their earlier workspace:created events predate the project in the
        // renderer store). Hibernated workspaces stay URL-less.
        project = {
          ...project,
          workspaces: project.workspaces.map((w) => {
            const url = urlByPath.get(w.path);
            return url !== undefined ? { ...w, url } : w;
          }),
        };

        // Emit project:opened event
        const event: ProjectOpenedEvent = {
          type: EVENT_PROJECT_OPENED,
          payload: { project, ...origin },
        };
        ctx.emit(event);

        // Switch to the first workspace only if no workspace is currently active.
        // During startup, multiple projects open sequentially — only the first
        // should activate a workspace to avoid visual jumping.
        if (project.workspaces.length > 0) {
          const activeWorkspace = await ctx.dispatch({
            type: INTENT_GET_ACTIVE_WORKSPACE,
            payload: {},
          } as GetActiveWorkspaceIntent);

          if (activeWorkspace === null) {
            // Pick the first non-hibernated workspace; if all are hibernated,
            // leave no workspace active so the user lands on the empty backdrop.
            const firstAwake = project.workspaces.find(
              (w) => w.metadata[HIBERNATED_METADATA_KEY] !== "true"
            );
            if (firstAwake) {
              try {
                await ctx.dispatch({
                  type: INTENT_SWITCH_WORKSPACE,
                  payload: { workspacePath: firstAwake.path },
                } as SwitchWorkspaceIntent);
              } catch {
                // Best-effort: switch failure doesn't fail the project open
              }
            }
          }
        }
      } else {
        // Project already open — emit failed event so idempotency key is released
        ctx.emit({
          type: EVENT_PROJECT_OPEN_FAILED,
          payload: { ...origin, reason: "already-open" },
        } as ProjectOpenFailedEvent);
      }

      return project;
    } catch (e) {
      // Emit failed event so idempotency key is released on error
      ctx.emit({
        type: EVENT_PROJECT_OPEN_FAILED,
        payload: {
          ...origin,
          reason: e instanceof Error ? e.message : String(e),
        },
      } as ProjectOpenFailedEvent);
      throw e;
    }
  }
}
