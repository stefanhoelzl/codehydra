/**
 * LocalProjectModule - Owns local project state and responds to hook points.
 *
 * Handles local filesystem projects (not git-URL clones). Uses the self-selection
 * pattern with collect(): returns empty results when the project isn't "ours"
 * (e.g., when remoteUrl is present, indicating a cloned project).
 *
 * Hook registrations:
 * - project:open  → resolve:  validate .git exists for local paths
 * - project:open  → register: generate ID, persist, add to internal state
 * - project:close → resolve-project:  look up projectId in internal state
 * - project:close → close:    remove from internal state and ProjectStore
 * - workspace:switch → resolve-project: look up projectId in internal state
 * - app:start     → activate: load saved project paths from ProjectStore
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
  SWITCH_WORKSPACE_OPERATION_ID,
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

// =============================================================================
// Types
// =============================================================================

/**
 * Internal representation of a local project tracked by this module.
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
 * Create a LocalProjectModule that owns local project state.
 *
 * @param deps - ProjectStore for persistence, GitWorktreeProvider for .git validation
 * @returns IntentModule with hook handlers for project:open, project:close, app:start
 */
export function createLocalProjectModule(deps: LocalProjectModuleDeps): IntentModule {
  const { projectStore, globalProvider } = deps;

  /** Internal state: local projects keyed by normalized path string. */
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

        // register: generate ID, persist, add to internal state
        register: {
          handler: async (ctx: HookContext): Promise<RegisterHookResult> => {
            const { projectPath: projectPathStr, remoteUrl } = ctx as RegisterHookInput;

            // Self-select: only handle local projects (no remoteUrl)
            if (remoteUrl !== undefined) {
              return {};
            }

            const projectPath = new Path(projectPathStr);
            const projectId = generateProjectId(projectPathStr);

            // Persist to store if new
            const existingConfig = await projectStore.getProjectConfig(projectPathStr);
            if (!existingConfig) {
              await projectStore.saveProject(projectPathStr);
            }

            // Add to internal state
            projects.set(projectPath.toString(), {
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

            // Not ours — return empty (another module may handle it)
            return {};
          },
        },

        // close: remove from internal state and ProjectStore
        close: {
          handler: async (ctx: HookContext): Promise<CloseHookResult> => {
            const { projectPath, remoteUrl } = ctx as CloseHookInput;

            // Self-select: only handle local projects (no remoteUrl)
            if (remoteUrl !== undefined) {
              return {};
            }

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
            const intent = ctx.intent as SwitchWorkspaceIntent;
            const { projectId } = intent.payload;

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
        // activate: load saved local project configs, populate state, return paths
        activate: {
          handler: async (): Promise<ActivateHookResult> => {
            const configs = await projectStore.loadAllProjectConfigs();
            const localPaths: string[] = [];

            for (const config of configs) {
              if (config.remoteUrl === undefined) {
                const path = new Path(config.path);
                const projectId = generateProjectId(config.path);

                projects.set(path.toString(), {
                  id: projectId,
                  name: path.basename,
                  path,
                });

                localPaths.push(config.path);
              }
            }

            return { projectPaths: localPaths };
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

      [OPEN_WORKSPACE_OPERATION_ID]: {
        // resolve-project: resolve projectId to path from local project state
        "resolve-project": {
          handler: async (ctx: HookContext): Promise<OpenWorkspaceResolveProjectHookResult> => {
            const intent = ctx.intent as OpenWorkspaceIntent;
            const { projectId, projectPath: payloadPath } = intent.payload;

            // Short-circuit: authoritative path already provided
            if (payloadPath) return { projectPath: payloadPath };

            // Look up projectId in local project state
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
    },
  };
}
