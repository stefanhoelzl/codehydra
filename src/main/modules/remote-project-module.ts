/**
 * RemoteProjectModule - Handles remote (URL-cloned) project filesystem concerns.
 *
 * No internal state. Delegates project state ownership to LocalProjectModule.
 * Responsible only for cloning repos on open and cleaning up directories on close.
 *
 * Hook contributions:
 * - open-project / resolve: clone URL or return existing clone path
 * - close-project / close: filesystem cleanup (delete cloned directory if requested)
 *
 * IMPORTANT: Must be registered before LocalProjectModule in wireModules so that
 * the close hook can read the project config before LocalProjectModule removes it.
 */

import type { IntentModule } from "../intents/infrastructure/module";
import type { HookContext } from "../intents/infrastructure/operation";
import type { IGitClient } from "../../services/git/git-client";
import type { PathProvider } from "../../services/platform/path-provider";
import type { ProjectStore } from "../../services/project/project-store";
import type { Logger } from "../../services/logging";
import { Path } from "../../services/platform/path";
import {
  expandGitUrl,
  generateProjectIdFromUrl,
  extractRepoName,
} from "../../services/project/url-utils";
import type { OpenProjectIntent, ResolveHookResult } from "../operations/open-project";
import { OPEN_PROJECT_OPERATION_ID } from "../operations/open-project";
import type { CloseHookInput, CloseHookResult } from "../operations/close-project";
import { CLOSE_PROJECT_OPERATION_ID } from "../operations/close-project";

// =============================================================================
// Factory
// =============================================================================

export function createRemoteProjectModule(deps: {
  readonly projectStore: Pick<
    ProjectStore,
    "findByRemoteUrl" | "saveProject" | "getProjectConfig" | "deleteProjectDirectory"
  >;
  readonly gitClient: Pick<IGitClient, "clone">;
  readonly pathProvider: Pick<PathProvider, "remotesDir">;
  readonly logger: Logger;
}): IntentModule {
  const { projectStore, gitClient, pathProvider, logger } = deps;

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
              return {
                projectPath: existingPath,
                remoteUrl: expanded,
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
      },

      // -----------------------------------------------------------------------
      // close-project
      // -----------------------------------------------------------------------
      [CLOSE_PROJECT_OPERATION_ID]: {
        // close: filesystem cleanup only — delete cloned directory if requested
        // Looks up the project config to determine if this is a remote project.
        // Must run before LocalProjectModule.close which removes the store entry.
        close: {
          handler: async (ctx: HookContext): Promise<CloseHookResult> => {
            const { projectPath, removeLocalRepo } = ctx as CloseHookInput;

            if (!removeLocalRepo) {
              return {};
            }

            // Check if this is a remote project by looking up the store config
            const config = await projectStore.getProjectConfig(projectPath);
            if (!config?.remoteUrl) {
              return {};
            }

            await projectStore.deleteProjectDirectory(projectPath, {
              isClonedProject: true,
            });

            return {};
          },
        },
      },
    },
  };
}
