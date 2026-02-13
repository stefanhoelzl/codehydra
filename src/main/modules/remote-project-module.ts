/**
 * RemoteProjectModule - Manages remote (URL-cloned) project state.
 *
 * Owns all remote project lifecycle: cloning, registration, lookup, and cleanup.
 * Responds to hook points on open-project, close-project, and app-start operations.
 *
 * Hook contributions:
 * - open-project / resolve: clone URL or return existing clone path
 * - open-project / register: track remote project in internal state
 * - close-project / resolve: look up tracked remote project by projectId
 * - close-project / close: remove from state and store, optionally delete directory
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
  type ResolveProjectHookResult,
} from "../operations/get-workspace-status";
import type { GetWorkspaceStatusIntent } from "../operations/get-workspace-status";

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
              return { projectPath: existingPath, remoteUrl: expanded };
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

            return { projectId, remoteUrl };
          },
        },
      },

      // -----------------------------------------------------------------------
      // close-project
      // -----------------------------------------------------------------------
      [CLOSE_PROJECT_OPERATION_ID]: {
        resolve: {
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
          handler: async (ctx: HookContext): Promise<ResolveProjectHookResult> => {
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
    },
  };
}
