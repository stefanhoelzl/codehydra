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

import type { Intent, DomainEvent } from "../intents/infrastructure/types";
import type { Operation, OperationContext, HookContext } from "../intents/infrastructure/operation";
import type { ProjectId, Project } from "../../shared/api/types";
import type { Workspace as InternalWorkspace } from "../../services/git/types";
import {
  INTENT_OPEN_WORKSPACE,
  type OpenWorkspaceIntent,
  type ExistingWorkspaceData,
} from "./open-workspace";
import { INTENT_SWITCH_WORKSPACE, type SwitchWorkspaceIntent } from "./switch-workspace";
import { toIpcWorkspaces } from "../api/workspace-conversion";
import { Path } from "../../services/platform/path";

// =============================================================================
// Intent Types
// =============================================================================

export interface OpenProjectPayload {
  /** Absolute local filesystem path. Set by projects.open. */
  readonly path?: Path;
  /** Git URL or shorthand (e.g. "org/repo"). Set by projects.clone. */
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
}

export interface ProjectOpenedEvent extends DomainEvent {
  readonly type: "project:opened";
  readonly payload: ProjectOpenedPayload;
}

export const EVENT_PROJECT_OPENED = "project:opened" as const;

// =============================================================================
// Hook Result & Input Types
// =============================================================================

export const OPEN_PROJECT_OPERATION_ID = "open-project";

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

/** Input context for the "register" hook point. */
export interface RegisterHookInput extends HookContext {
  readonly projectPath: string;
  readonly remoteUrl?: string;
}

// =============================================================================
// Operation
// =============================================================================

export class OpenProjectOperation implements Operation<OpenProjectIntent, Project> {
  readonly id = OPEN_PROJECT_OPERATION_ID;

  async execute(ctx: OperationContext<OpenProjectIntent>): Promise<Project> {
    // 1. Resolve: clone if URL, validate git, return projectPath + remoteUrl
    const resolveCtx: HookContext = { intent: ctx.intent };
    const { results: resolveResults, errors: resolveErrors } =
      await ctx.hooks.collect<ResolveHookResult>("resolve", resolveCtx);
    if (resolveErrors.length === 1) {
      throw resolveErrors[0]!;
    }
    if (resolveErrors.length > 1) {
      throw new AggregateError(resolveErrors, "project:open resolve hooks failed");
    }
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
      intent: ctx.intent,
      projectPath,
      ...(resolvedRemoteUrl !== undefined && { remoteUrl: resolvedRemoteUrl }),
    };
    const { results: registerResults, errors: registerErrors } =
      await ctx.hooks.collect<RegisterHookResult>("register", registerCtx);
    if (registerErrors.length === 1) {
      throw registerErrors[0]!;
    }
    if (registerErrors.length > 1) {
      throw new AggregateError(registerErrors, "project:open register hooks failed");
    }
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
    const discoverCtx: DiscoverHookInput = { intent: ctx.intent, projectPath };
    const { results: discoverResults, errors: discoverErrors } =
      await ctx.hooks.collect<DiscoverHookResult>("discover", discoverCtx);
    if (discoverErrors.length === 1) {
      throw discoverErrors[0]!;
    }
    if (discoverErrors.length > 1) {
      throw new AggregateError(discoverErrors, "project:open discover hooks failed");
    }
    const workspaces: InternalWorkspace[] = [];
    let defaultBaseBranch: string | undefined;
    for (const r of discoverResults) {
      if (r.workspaces) workspaces.push(...r.workspaces);
      if (r.defaultBaseBranch !== undefined) defaultBaseBranch = r.defaultBaseBranch;
    }

    // Build Project return value
    const project: Project = {
      id: projectId,
      path: projectPath,
      name: name ?? new Path(projectPath).basename,
      workspaces: toIpcWorkspaces(workspaces, projectId),
      ...(defaultBaseBranch !== undefined && { defaultBaseBranch }),
      ...(resolvedRemoteUrl !== undefined && { remoteUrl: resolvedRemoteUrl }),
    };

    // When already open, register + discover ran (idempotent) but skip side effects
    if (!alreadyOpen) {
      // Dispatch workspace:open per discovered workspace (best-effort)
      for (const workspace of workspaces) {
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
              projectId,
              workspaceName: workspace.name,
              base: workspace.metadata.base ?? "",
              existingWorkspace,
              projectPath,
              keepInBackground: true,
            },
          };

          await ctx.dispatch(openWsIntent);
        } catch {
          // Best-effort: individual workspace:open failures don't fail the project open
        }
      }

      // Emit project:opened event
      const event: ProjectOpenedEvent = {
        type: EVENT_PROJECT_OPENED,
        payload: { project },
      };
      ctx.emit(event);

      // Dispatch workspace:switch for the first workspace
      if (project.workspaces.length > 0) {
        const firstWorkspace = project.workspaces[0]!;
        const switchIntent: SwitchWorkspaceIntent = {
          type: INTENT_SWITCH_WORKSPACE,
          payload: {
            workspacePath: firstWorkspace.path,
          },
        };
        try {
          await ctx.dispatch(switchIntent);
        } catch {
          // Best-effort: switch failure doesn't fail the project open
        }
      }
    }

    return project;
  }
}
