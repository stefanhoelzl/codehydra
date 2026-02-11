/**
 * OpenProjectOperation - Orchestrates project opening.
 *
 * Runs 3 sequential hook points using collect() for isolated contexts:
 * 1. "resolve": clone if URL, validate git → ResolveHookResult
 * 2. "discover": find existing workspaces → DiscoverHookResult
 * 3. "register": generate ID, store state, persist → RegisterHookResult
 *
 * The operation mediates data flow between hook points — only pure data
 * flows through contexts. Providers are module dependencies via closure.
 *
 * After hooks, dispatches workspace:create per discovered workspace (best-effort)
 * and emits project:opened. View activation is handled by the projectViewModule
 * event handler (registered in bootstrap).
 */

import type { Intent, DomainEvent } from "../intents/infrastructure/types";
import type { Operation, OperationContext, HookContext } from "../intents/infrastructure/operation";
import type { ProjectId, Project } from "../../shared/api/types";
import type { Workspace as InternalWorkspace } from "../../services/git/types";
import {
  INTENT_CREATE_WORKSPACE,
  type CreateWorkspaceIntent,
  type ExistingWorkspaceData,
} from "./create-workspace";
import { INTENT_SWITCH_WORKSPACE, type SwitchWorkspaceIntent } from "./switch-workspace";
import { toIpcWorkspaces } from "../api/workspace-conversion";
import { Path } from "../../services/platform/path";
import { extractWorkspaceName } from "../api/id-utils";

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
  readonly projectPath: string;
  readonly remoteUrl?: string;
}

/** Result returned by handlers on the "discover" hook point. */
export interface DiscoverHookResult {
  readonly workspaces: readonly InternalWorkspace[];
}

/** Result returned by handlers on the "register" hook point. */
export interface RegisterHookResult {
  readonly projectId: ProjectId;
  readonly defaultBaseBranch?: string;
  readonly remoteUrl?: string;
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
    for (const r of resolveResults) {
      if (r.projectPath && !projectPath) projectPath = r.projectPath;
      if (r.remoteUrl !== undefined) resolvedRemoteUrl = r.remoteUrl;
    }
    if (!projectPath) {
      throw new Error("Resolve hook did not provide projectPath");
    }

    // 2. Discover: find existing workspaces
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
    for (const r of discoverResults) {
      if (r.workspaces) workspaces.push(...r.workspaces);
    }

    // 3. Register: generate ID, store state, persist
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
    let defaultBaseBranch: string | undefined;
    let registeredRemoteUrl: string | undefined;
    for (const r of registerResults) {
      if (r.projectId) projectId = r.projectId;
      if (r.defaultBaseBranch !== undefined) defaultBaseBranch = r.defaultBaseBranch;
      if (r.remoteUrl !== undefined) registeredRemoteUrl = r.remoteUrl;
    }
    if (!projectId) {
      throw new Error("Register hook did not provide projectId");
    }

    const finalRemoteUrl = registeredRemoteUrl ?? resolvedRemoteUrl;

    // Dispatch workspace:create per discovered workspace (best-effort)
    for (const workspace of workspaces) {
      try {
        const existingWorkspace: ExistingWorkspaceData = {
          path: workspace.path.toString(),
          name: workspace.name,
          branch: workspace.branch,
          metadata: workspace.metadata,
        };

        const createIntent: CreateWorkspaceIntent = {
          type: INTENT_CREATE_WORKSPACE,
          payload: {
            projectId,
            name: workspace.name,
            base: workspace.metadata.base ?? "",
            existingWorkspace,
            projectPath,
            keepInBackground: true,
          },
        };

        await ctx.dispatch(createIntent);
      } catch {
        // Best-effort: individual workspace:create failures don't fail the project open
      }
    }

    // Build Project return value
    const project: Project = {
      id: projectId,
      path: projectPath,
      name: new Path(projectPath).basename,
      workspaces: toIpcWorkspaces(workspaces, projectId),
      ...(defaultBaseBranch !== undefined && { defaultBaseBranch }),
      ...(finalRemoteUrl !== undefined && { remoteUrl: finalRemoteUrl }),
    };

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
          projectId,
          workspaceName: extractWorkspaceName(firstWorkspace.path),
        },
      };
      try {
        await ctx.dispatch(switchIntent);
      } catch {
        // Best-effort: switch failure doesn't fail the project open
      }
    }

    return project;
  }
}
