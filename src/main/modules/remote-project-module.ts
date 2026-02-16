/**
 * RemoteProjectModule - Manages remote (URL-cloned) project state.
 *
 * Owns all remote project lifecycle: cloning, registration, lookup, and cleanup.
 * Responds to hook points on open-project, close-project, and app-start operations.
 *
 * Hook contributions:
 * - open-project / resolve: clone URL or return existing clone path
 * - open-project / register: track remote project in internal state
 * - close-project / resolve-project: look up tracked remote project by projectId
 * - close-project / close: remove from state and store, optionally delete directory
 * - switch-workspace / resolve-project: look up tracked remote project by projectId
 * - app-start / activate: load saved remote project configs into state
 *
 * Self-selects per hook: returns undefined when the project is not remote,
 * allowing local-project handlers to handle those cases.
 */

import type { IntentModule } from "../intents/infrastructure/module";
import type { HookContext } from "../intents/infrastructure/operation";
import type { ProjectId } from "../../shared/api/types";
import type { IGitClient } from "../../services/git/git-client";
import type { PathProvider } from "../../services/platform/path-provider";
import type { ProjectStore } from "../../services/project/project-store";
import type { Logger } from "../../services/logging";
import { Path } from "../../services/platform/path";
import { generateProjectId } from "../../shared/api/id-utils";
import {
  expandGitUrl,
  generateProjectIdFromUrl,
  extractRepoName,
} from "../../services/project/url-utils";
import type {
  OpenProjectIntent,
  ResolveHookResult,
  RegisterHookResult,
} from "../operations/open-project";
import { OPEN_PROJECT_OPERATION_ID } from "../operations/open-project";
import type { RegisterHookInput } from "../operations/open-project";
import type {
  CloseProjectIntent,
  CloseResolveHookResult,
  CloseHookInput,
  CloseHookResult,
} from "../operations/close-project";
import { CLOSE_PROJECT_OPERATION_ID } from "../operations/close-project";
import type { ActivateHookResult } from "../operations/app-start";
import { APP_START_OPERATION_ID } from "../operations/app-start";
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
// Exported Types
// =============================================================================

export interface RemoteProject {
  readonly id: ProjectId;
  readonly name: string;
  readonly path: Path;
  readonly remoteUrl: string;
}

// =============================================================================
// Factory
// =============================================================================

export function createRemoteProjectModule(deps: {
  readonly projectStore: Pick<
    ProjectStore,
    | "findByRemoteUrl"
    | "saveProject"
    | "removeProject"
    | "deleteProjectDirectory"
    | "loadAllProjectConfigs"
  >;
  readonly gitClient: Pick<IGitClient, "clone">;
  readonly pathProvider: Pick<PathProvider, "remotesDir">;
  readonly logger: Logger;
}): IntentModule {
  const { projectStore, gitClient, pathProvider, logger } = deps;

  /** Internal state: remote projects keyed by canonical path string. */
  const state = new Map<string, RemoteProject>();

  return {
    hooks: {
      // -----------------------------------------------------------------------
      // open-project
      // -----------------------------------------------------------------------
      [OPEN_PROJECT_OPERATION_ID]: {
        resolve: {
          handler: async (ctx: HookContext): Promise<ResolveHookResult | undefined> => {
            const intent = ctx.intent as OpenProjectIntent;
            const { git } = intent.payload;

            if (!git) {
              return undefined;
            }

            const expanded = expandGitUrl(git);

            // Check for existing clone
            const existingPath = await projectStore.findByRemoteUrl(expanded);
            if (existingPath) {
              logger.debug("Found existing project for URL", {
                url: expanded,
                existingPath,
              });
              // Already in internal state — signal short-circuit
              const alreadyOpen = state.has(new Path(existingPath).toString());
              return {
                projectPath: existingPath,
                remoteUrl: expanded,
                ...(alreadyOpen && { alreadyOpen }),
              };
            }

            // Clone
            const urlProjectId = generateProjectIdFromUrl(expanded);
            const repoName = extractRepoName(expanded);
            const projectDir = new Path(pathProvider.remotesDir.toString(), urlProjectId);
            const gitPath = new Path(projectDir.toString(), repoName);

            logger.debug("Cloning repository", {
              url: expanded,
              gitPath: gitPath.toString(),
            });

            await gitClient.clone(expanded, gitPath);
            await projectStore.saveProject(gitPath.toString(), { remoteUrl: expanded });

            return { projectPath: gitPath.toString(), remoteUrl: expanded };
          },
        },

        register: {
          handler: async (ctx: HookContext): Promise<RegisterHookResult | undefined> => {
            const { projectPath, remoteUrl } = ctx as RegisterHookInput;

            if (!remoteUrl) {
              return undefined;
            }

            const projectId = generateProjectId(projectPath);
            const path = new Path(projectPath);

            state.set(path.toString(), {
              id: projectId,
              name: path.basename,
              path,
              remoteUrl,
            });

            return { projectId, name: path.basename, remoteUrl };
          },
        },
      },

      // -----------------------------------------------------------------------
      // close-project
      // -----------------------------------------------------------------------
      [CLOSE_PROJECT_OPERATION_ID]: {
        "resolve-project": {
          handler: async (ctx: HookContext): Promise<CloseResolveHookResult | undefined> => {
            const intent = ctx.intent as CloseProjectIntent;
            const { projectId } = intent.payload;

            for (const project of state.values()) {
              if (project.id === projectId) {
                return {
                  projectPath: project.path.toString(),
                  remoteUrl: project.remoteUrl,
                };
              }
            }

            return undefined;
          },
        },

        close: {
          handler: async (ctx: HookContext): Promise<CloseHookResult> => {
            const { projectPath, remoteUrl, removeLocalRepo } = ctx as CloseHookInput;

            if (!remoteUrl) {
              return {};
            }

            // Remove from internal state
            state.delete(new Path(projectPath).toString());

            // Remove from persistent storage
            try {
              await projectStore.removeProject(projectPath);
            } catch {
              // Fail silently
            }

            // Delete directory if requested
            if (removeLocalRepo) {
              await projectStore.deleteProjectDirectory(projectPath, {
                isClonedProject: true,
              });
            }

            return {};
          },
        },
      },

      // -----------------------------------------------------------------------
      // switch-workspace
      // -----------------------------------------------------------------------
      [SWITCH_WORKSPACE_OPERATION_ID]: {
        "resolve-project": {
          handler: async (ctx: HookContext): Promise<ResolveProjectHookResult> => {
            const { payload } = ctx.intent as SwitchWorkspaceIntent;
            if (isAutoSwitch(payload)) return {};
            const { projectId } = payload;

            for (const project of state.values()) {
              if (project.id === projectId) {
                return { projectPath: project.path.toString(), projectName: project.name };
              }
            }

            return {};
          },
        },
      },

      // -----------------------------------------------------------------------
      // app-start
      // -----------------------------------------------------------------------
      [APP_START_OPERATION_ID]: {
        activate: {
          handler: async (): Promise<ActivateHookResult> => {
            const configs = await projectStore.loadAllProjectConfigs();
            const remotePaths: string[] = [];

            for (const config of configs) {
              if (config.remoteUrl) {
                const path = new Path(config.path);
                const projectId = generateProjectId(config.path);

                state.set(path.toString(), {
                  id: projectId,
                  name: path.basename,
                  path,
                  remoteUrl: config.remoteUrl,
                });

                remotePaths.push(config.path);
              }
            }

            return { projectPaths: remotePaths };
          },
        },
      },

      // -----------------------------------------------------------------------
      // get-workspace-status
      // -----------------------------------------------------------------------
      [GET_WORKSPACE_STATUS_OPERATION_ID]: {
        "resolve-project": {
          handler: async (ctx: HookContext): Promise<GetStatusResolveProjectHookResult> => {
            const intent = ctx.intent as GetWorkspaceStatusIntent;
            const { projectId } = intent.payload;

            for (const project of state.values()) {
              if (project.id === projectId) {
                return { projectPath: project.path.toString() };
              }
            }

            return {};
          },
        },
      },

      // -----------------------------------------------------------------------
      // set-metadata / get-metadata
      // -----------------------------------------------------------------------
      [SET_METADATA_OPERATION_ID]: {
        "resolve-project": {
          handler: async (ctx: HookContext): Promise<SetMetadataResolveProjectHookResult> => {
            const intent = ctx.intent as SetMetadataIntent;
            const { projectId } = intent.payload;

            for (const project of state.values()) {
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

            for (const project of state.values()) {
              if (project.id === projectId) {
                return { projectPath: project.path.toString() };
              }
            }

            return {};
          },
        },
      },

      // -----------------------------------------------------------------------
      // open-workspace
      // -----------------------------------------------------------------------
      [OPEN_WORKSPACE_OPERATION_ID]: {
        "resolve-project": {
          handler: async (ctx: HookContext): Promise<OpenWorkspaceResolveProjectHookResult> => {
            const intent = ctx.intent as OpenWorkspaceIntent;
            const { projectId, projectPath: payloadPath } = intent.payload;

            // Short-circuit: authoritative path already provided
            if (payloadPath) return { projectPath: payloadPath };

            // Look up projectId in remote project state
            if (!projectId) return {};
            for (const project of state.values()) {
              if (project.id === projectId) {
                return { projectPath: project.path.toString() };
              }
            }

            return {};
          },
        },
      },

      // -----------------------------------------------------------------------
      // get-agent-session
      // -----------------------------------------------------------------------
      [GET_AGENT_SESSION_OPERATION_ID]: {
        "resolve-project": {
          handler: async (ctx: HookContext): Promise<GetAgentSessionResolveProjectHookResult> => {
            const intent = ctx.intent as GetAgentSessionIntent;
            const { projectId } = intent.payload;

            for (const project of state.values()) {
              if (project.id === projectId) {
                return { projectPath: project.path.toString() };
              }
            }

            return {};
          },
        },
      },

      // -----------------------------------------------------------------------
      // restart-agent
      // -----------------------------------------------------------------------
      [RESTART_AGENT_OPERATION_ID]: {
        "resolve-project": {
          handler: async (ctx: HookContext): Promise<RestartAgentResolveProjectHookResult> => {
            const intent = ctx.intent as RestartAgentIntent;
            const { projectId } = intent.payload;

            for (const project of state.values()) {
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

            for (const project of state.values()) {
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
