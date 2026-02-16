/**
 * LocalProjectModule - Sole owner of project state for ALL projects.
 *
 * Manages internal state (projects map) and responds to resolve-project
 * hook points across all operations. Completely unaware of remoteUrl —
 * remote-specific concerns (cloning, directory cleanup) stay in RemoteProjectModule.
 *
 * Hook registrations:
 * - project:open  → resolve:  validate .git exists for local paths
 * - project:open  → register: generate ID, persist, add to internal state (all projects)
 * - project:close → resolve-project:  look up projectId in internal state
 * - project:close → close:    remove from internal state and ProjectStore (all projects)
 * - workspace:switch → resolve-project: look up projectId in internal state
 * - app:start     → activate: load ALL saved project paths from ProjectStore
 */

import type { IntentModule } from "../intents/infrastructure/module";
import type { HookContext } from "../intents/infrastructure/operation";
import type { ProjectId } from "../../shared/api/types";
import { generateProjectId } from "../../shared/api/id-utils";
import { Path } from "../../services/platform/path";
import type { ProjectStore } from "../../services/project/project-store";
import type { GitWorktreeProvider } from "../../services/git/git-worktree-provider";
import {
  OPEN_PROJECT_OPERATION_ID,
  type OpenProjectIntent,
  type ResolveHookResult,
  type RegisterHookInput,
  type RegisterHookResult,
} from "../operations/open-project";
import {
  CLOSE_PROJECT_OPERATION_ID,
  type CloseProjectIntent,
  type CloseResolveHookResult,
  type CloseHookInput,
  type CloseHookResult,
} from "../operations/close-project";
import { APP_START_OPERATION_ID, type ActivateHookResult } from "../operations/app-start";
import {
  GET_WORKSPACE_STATUS_OPERATION_ID,
  type ResolveProjectHookResult as GetStatusResolveProjectHookResult,
} from "../operations/get-workspace-status";
import type { GetWorkspaceStatusIntent } from "../operations/get-workspace-status";
import {
  SET_METADATA_OPERATION_ID,
  type ResolveProjectHookResult as SetMetadataResolveProjectHookResult,
} from "../operations/set-metadata";
import type { SetMetadataIntent } from "../operations/set-metadata";
import {
  GET_METADATA_OPERATION_ID,
  type ResolveProjectHookResult as GetMetadataResolveProjectHookResult,
} from "../operations/get-metadata";
import type { GetMetadataIntent } from "../operations/get-metadata";
import {
  SWITCH_WORKSPACE_OPERATION_ID,
  isAutoSwitch,
  type SwitchWorkspaceIntent,
  type ResolveProjectHookResult,
} from "../operations/switch-workspace";
import {
  OPEN_WORKSPACE_OPERATION_ID,
  type OpenWorkspaceIntent,
  type ResolveProjectHookResult as OpenWorkspaceResolveProjectHookResult,
} from "../operations/open-workspace";
import {
  GET_AGENT_SESSION_OPERATION_ID,
  type GetAgentSessionIntent,
  type ResolveProjectHookResult as GetAgentSessionResolveProjectHookResult,
} from "../operations/get-agent-session";
import {
  RESTART_AGENT_OPERATION_ID,
  type RestartAgentIntent,
  type ResolveProjectHookResult as RestartAgentResolveProjectHookResult,
} from "../operations/restart-agent";
import {
  DELETE_WORKSPACE_OPERATION_ID,
  type DeleteWorkspaceIntent,
  type ResolveProjectHookResult as DeleteWorkspaceResolveProjectHookResult,
} from "../operations/delete-workspace";

// =============================================================================
// Types
// =============================================================================

/**
 * Internal representation of a project tracked by this module.
 * No remoteUrl — LocalProjectModule is unaware of remote concerns.
 */
export interface LocalProject {
  readonly id: ProjectId;
  readonly name: string;
  readonly path: Path;
}

/**
 * Dependencies for LocalProjectModule.
 */
export interface LocalProjectModuleDeps {
  readonly projectStore: Pick<
    ProjectStore,
    "loadAllProjectConfigs" | "saveProject" | "removeProject" | "getProjectConfig"
  >;
  readonly globalProvider: Pick<GitWorktreeProvider, "validateRepository">;
}

// =============================================================================
// Module Factory
// =============================================================================

/**
 * Create a LocalProjectModule that owns project state for ALL projects.
 *
 * @param deps - ProjectStore for persistence, GitWorktreeProvider for .git validation
 * @returns IntentModule with hook handlers for project:open, project:close, app:start
 */
export function createLocalProjectModule(deps: LocalProjectModuleDeps): IntentModule {
  const { projectStore, globalProvider } = deps;

  /** Internal state: all projects keyed by normalized path string. */
  const projects = new Map<string, LocalProject>();

  return {
    hooks: {
      [OPEN_PROJECT_OPERATION_ID]: {
        // resolve: validate .git exists for local paths
        resolve: {
          handler: async (ctx: HookContext): Promise<ResolveHookResult> => {
            const intent = ctx.intent as OpenProjectIntent;
            const { path, git } = intent.payload;

            // Self-select: only handle local paths (not git URLs)
            if (git || !path) {
              return {};
            }

            // Already open — skip validation, signal short-circuit
            if (projects.has(path.toString())) {
              return { projectPath: path.toString(), alreadyOpen: true };
            }

            await globalProvider.validateRepository(path);

            return { projectPath: path.toString() };
          },
        },

        // register: generate ID, persist, add to internal state (all projects)
        register: {
          handler: async (ctx: HookContext): Promise<RegisterHookResult> => {
            const { projectPath: projectPathStr } = ctx as RegisterHookInput;

            const projectPath = new Path(projectPathStr);
            const normalizedKey = projectPath.toString();
            const projectId = generateProjectId(projectPathStr);

            // Already in state — return alreadyOpen without re-persisting
            if (projects.has(normalizedKey)) {
              return { projectId, name: projectPath.basename, alreadyOpen: true };
            }

            // Persist to store if new (remote projects already saved by RemoteProjectModule.resolve)
            const existingConfig = await projectStore.getProjectConfig(projectPathStr);
            if (!existingConfig) {
              await projectStore.saveProject(projectPathStr);
            }

            // Add to internal state
            projects.set(normalizedKey, {
              id: projectId,
              name: projectPath.basename,
              path: projectPath,
            });

            return { projectId, name: projectPath.basename };
          },
        },
      },

      [CLOSE_PROJECT_OPERATION_ID]: {
        // resolve-project: look up projectId in internal state
        "resolve-project": {
          handler: async (ctx: HookContext): Promise<CloseResolveHookResult> => {
            const intent = ctx.intent as CloseProjectIntent;
            const { projectId } = intent.payload;

            // Find project by ID in our state
            for (const project of projects.values()) {
              if (project.id === projectId) {
                return { projectPath: project.path.toString() };
              }
            }

            // Not found — return empty
            return {};
          },
        },

        // close: remove from internal state and ProjectStore (all projects)
        close: {
          handler: async (ctx: HookContext): Promise<CloseHookResult> => {
            const { projectPath } = ctx as CloseHookInput;

            // Remove from internal state
            const normalizedKey = new Path(projectPath).toString();
            projects.delete(normalizedKey);

            // Remove from persistent storage
            try {
              await projectStore.removeProject(projectPath);
            } catch {
              // Fail silently
            }

            return {};
          },
        },
      },

      [SWITCH_WORKSPACE_OPERATION_ID]: {
        "resolve-project": {
          handler: async (ctx: HookContext): Promise<ResolveProjectHookResult> => {
            const { payload } = ctx.intent as SwitchWorkspaceIntent;
            if (isAutoSwitch(payload)) return {};
            const { projectId } = payload;

            for (const project of projects.values()) {
              if (project.id === projectId) {
                return { projectPath: project.path.toString(), projectName: project.name };
              }
            }

            return {};
          },
        },
      },

      [APP_START_OPERATION_ID]: {
        // activate: scan saved project configs and return paths for project:open dispatch
        activate: {
          handler: async (): Promise<ActivateHookResult> => {
            const configs = await projectStore.loadAllProjectConfigs();
            return { projectPaths: configs.map((c) => c.path) };
          },
        },
      },

      [GET_WORKSPACE_STATUS_OPERATION_ID]: {
        // resolve-project: look up projectId in internal state
        "resolve-project": {
          handler: async (ctx: HookContext): Promise<GetStatusResolveProjectHookResult> => {
            const intent = ctx.intent as GetWorkspaceStatusIntent;
            const { projectId } = intent.payload;

            for (const project of projects.values()) {
              if (project.id === projectId) {
                return { projectPath: project.path.toString() };
              }
            }

            return {};
          },
        },
      },

      [SET_METADATA_OPERATION_ID]: {
        "resolve-project": {
          handler: async (ctx: HookContext): Promise<SetMetadataResolveProjectHookResult> => {
            const intent = ctx.intent as SetMetadataIntent;
            const { projectId } = intent.payload;

            for (const project of projects.values()) {
              if (project.id === projectId) {
                return { projectPath: project.path.toString() };
              }
            }

            return {};
          },
        },
      },

      [GET_METADATA_OPERATION_ID]: {
        "resolve-project": {
          handler: async (ctx: HookContext): Promise<GetMetadataResolveProjectHookResult> => {
            const intent = ctx.intent as GetMetadataIntent;
            const { projectId } = intent.payload;

            for (const project of projects.values()) {
              if (project.id === projectId) {
                return { projectPath: project.path.toString() };
              }
            }

            return {};
          },
        },
      },

      [OPEN_WORKSPACE_OPERATION_ID]: {
        // resolve-project: resolve projectId to path from project state (sole handler)
        "resolve-project": {
          handler: async (ctx: HookContext): Promise<OpenWorkspaceResolveProjectHookResult> => {
            const intent = ctx.intent as OpenWorkspaceIntent;
            const { projectId, projectPath: payloadPath } = intent.payload;

            // Short-circuit: authoritative path already provided
            if (payloadPath) {
              return { projectPath: payloadPath };
            }

            // Look up projectId in project state
            if (!projectId) return {};
            for (const project of projects.values()) {
              if (project.id === projectId) {
                return { projectPath: project.path.toString() };
              }
            }

            return {};
          },
        },
      },

      [GET_AGENT_SESSION_OPERATION_ID]: {
        "resolve-project": {
          handler: async (ctx: HookContext): Promise<GetAgentSessionResolveProjectHookResult> => {
            const intent = ctx.intent as GetAgentSessionIntent;
            const { projectId } = intent.payload;

            for (const project of projects.values()) {
              if (project.id === projectId) {
                return { projectPath: project.path.toString() };
              }
            }

            return {};
          },
        },
      },

      [RESTART_AGENT_OPERATION_ID]: {
        "resolve-project": {
          handler: async (ctx: HookContext): Promise<RestartAgentResolveProjectHookResult> => {
            const intent = ctx.intent as RestartAgentIntent;
            const { projectId } = intent.payload;

            for (const project of projects.values()) {
              if (project.id === projectId) {
                return { projectPath: project.path.toString() };
              }
            }

            return {};
          },
        },
      },

      [DELETE_WORKSPACE_OPERATION_ID]: {
        "resolve-project": {
          handler: async (ctx: HookContext): Promise<DeleteWorkspaceResolveProjectHookResult> => {
            const intent = ctx.intent as DeleteWorkspaceIntent;
            const { projectId } = intent.payload;

            for (const project of projects.values()) {
              if (project.id === projectId) {
                return { projectPath: project.path.toString() };
              }
            }

            return {};
          },
        },
      },
    },
  };
}
