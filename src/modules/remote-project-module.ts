/**
 * RemoteProjectModule - Handles remote (URL-cloned) project filesystem concerns.
 *
 * No internal state. No persistence. Delegates project state ownership to
 * LocalProjectModule. Responsible only for cloning repos on open and cleaning
 * up clone directories on close.
 *
 * Hook contributions:
 * - open-project / resolve: clone URL or return existing clone path
 * - close-project / close: filesystem cleanup (delete cloned directory if requested)
 */

import nodePath from "path";
import type { IntentModule } from "../intents/lib/module";
import type { HookContext, HookOutput } from "../intents/lib/operation";
import type { IGitClient } from "../boundaries/platform/git-client";
import type { PathProvider } from "../boundaries/platform/path-provider";
import type { FileSystemBoundary } from "../boundaries/platform/filesystem";
import type { Logger } from "../boundaries/platform/logging";
import { Path } from "../utils/path/path";
import { projectPathSchema } from "../intents/contract";
import { expandGitUrl, extractRepoName } from "../utils/url-utils";
import { managedClonePath } from "../boundaries/platform/paths";
import type {
  OpenProjectIntent,
  ResolveHookResult,
  CloneProgressFrame,
} from "../intents/open-project";
import { OPEN_PROJECT_OPERATION_ID } from "../intents/open-project";
import { streamProgress } from "../intents/lib/hook-helpers";
import type { CloseHookInput, CloseHookResult } from "../intents/close-project";
import type { Dispatcher } from "../intents/lib/dispatcher";
import { notify } from "./presentation/notification-card";
import { getErrorMessage } from "../shared/errors/service-errors";
import { CLOSE_PROJECT_OPERATION_ID } from "../intents/close-project";

// =============================================================================
// Factory
// =============================================================================

export function createRemoteProjectModule(deps: {
  readonly fs: Pick<FileSystemBoundary, "readdir" | "rm">;
  readonly gitClient: Pick<IGitClient, "clone">;
  readonly pathProvider: Pick<PathProvider, "dataPath">;
  readonly logger: Logger;
  readonly dispatcher: Pick<Dispatcher, "dispatch">;
}): IntentModule {
  const { fs, gitClient, pathProvider, logger, dispatcher } = deps;

  return {
    name: "remote-project",
    hooks: {
      // -----------------------------------------------------------------------
      // open-project
      // -----------------------------------------------------------------------
      [OPEN_PROJECT_OPERATION_ID]: {
        resolve: {
          // Streaming handler: yield clone-progress frames; the open-project operation
          // adds the url and emits clone:progress. Returns the resolved paths.
          handler: async function* (
            ctx: HookContext
          ): AsyncGenerator<CloneProgressFrame, HookOutput<ResolveHookResult>, void> {
            const intent = ctx.intent as OpenProjectIntent;
            const { git } = intent.payload;

            if (!git) {
              return {};
            }

            const expanded = expandGitUrl(git);

            // Deterministic clone path from URL
            const repoName = extractRepoName(expanded);
            const gitPath = managedClonePath(pathProvider.dataPath("remotes"), expanded);

            // Check for existing clone via filesystem
            try {
              await fs.readdir(gitPath.toString());

              logger.debug("Found existing project for URL", {
                url: expanded,
                existingPath: gitPath.toString(),
              });
              return {
                result: {
                  projectPath: projectPathSchema.parse(gitPath.toString()),
                  remoteUrl: expanded,
                },
              };
            } catch {
              // Not found — clone
            }

            logger.debug("Cloning repository", {
              url: expanded,
              gitPath: gitPath.toString(),
            });

            yield* streamProgress<CloneProgressFrame>(async (emit) => {
              await gitClient.clone(expanded, gitPath, (event) => {
                emit({ stage: event.stage, progress: event.progress / 100, name: repoName });
              });
            });

            // No saveProject call — LocalProjectModule.register handles persistence
            // with remoteUrl from context

            return {
              result: {
                projectPath: projectPathSchema.parse(gitPath.toString()),
                remoteUrl: expanded,
              },
            };
          },
        },
      },

      // -----------------------------------------------------------------------
      // close-project
      // -----------------------------------------------------------------------
      [CLOSE_PROJECT_OPERATION_ID]: {
        // close: filesystem cleanup only — delete cloned directory if requested
        // Uses remoteUrl from hook context (provided by resolve-project results)
        close: {
          handler: async (ctx: HookContext): Promise<HookOutput<CloseHookResult>> => {
            const { projectPath, removeLocalRepo, remoteUrl } = ctx as CloseHookInput;

            if (!removeLocalRepo || !remoteUrl) {
              return { result: {} };
            }

            // Delete the clone directory (parent of gitPath, e.g. remotes/<url-hash>/)
            //
            // Best-effort, and it says so on failure: by now the project is
            // out of state and its workspaces are gone, so throwing would
            // leave the app inconsistent without saving the clone. Matches
            // the local branch of removeLocalRepo in LocalProjectModule —
            // one flag, one failure story.
            const cloneDir = nodePath.dirname(new Path(projectPath).toString());
            try {
              await fs.rm(cloneDir, { recursive: true, force: true });
            } catch (error: unknown) {
              const message = getErrorMessage(error);
              logger.warn("Failed to remove clone directory", { cloneDir, error: message });
              notify(dispatcher, {
                type: "error",
                title: "Could not remove the cloned repository",
                message: `${cloneDir} is still on disk: ${message}`,
                dismissible: true,
              });
            }

            return { result: {} };
          },
        },
      },
    },
  };
}
