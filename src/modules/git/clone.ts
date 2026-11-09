/**
 * The project side of the git type for projects opened from a URL: clone it
 * (or find the clone already there) into the managed clone directory, report
 * type "git" with config `{ remoteUrl }`, and delete the clone on a close that
 * asks for it. No state, no persistence: the project store saves what resolve
 * reports.
 */

import type { IGitClient } from "../../boundaries/platform/git-client";
import type { FileSystemBoundary } from "../../boundaries/platform/filesystem";
import type { Logger } from "../../boundaries/platform/logging";
import { Path } from "../../utils/path/path";
import { projectPathSchema } from "../../intents/contract";
import { expandGitUrl, extractRepoName, isLocalGitOrigin } from "../../utils/url-utils";
import { managedClonePath } from "../../boundaries/platform/paths";
import type { ResolveHookResult, CloneProgressFrame } from "../../intents/open-project";
import { streamProgress } from "../../intents/lib/hook-helpers";
import type { Dispatcher } from "../../intents/lib/dispatcher";
import { notify } from "../presentation/notification-card";
import { getErrorMessage } from "../../shared/errors/service-errors";
import { GIT_PROJECT_TYPE, gitProjectIdentifier } from "./ref";

export interface GitClonesDeps {
  readonly fs: Pick<FileSystemBoundary, "readdir" | "rm">;
  readonly gitClient: Pick<IGitClient, "clone">;
  /** Where managed clones live; read on every use, the workspaces root is settled at startup. */
  readonly remotesDir: () => Path;
  readonly logger: Logger;
  readonly dispatcher: Pick<Dispatcher, "dispatch">;
}

export interface GitClones {
  /** project:open resolve for a URL: clone it, streaming clone progress. */
  resolveUrl(git: string): AsyncGenerator<CloneProgressFrame, ResolveHookResult, void>;
  /** project:close close with removeLocalRepo: delete the clone's directory. */
  removeClone(projectPath: string): Promise<void>;
}

/**
 * A managed clone, resolved: its path, its origin, and the git config it is
 * stored with — only the URL, its path derives from it (see records.ts).
 */
function resolved(gitPath: Path, remoteUrl: string): ResolveHookResult {
  return {
    projectPath: projectPathSchema.parse(gitPath.toString()),
    remoteUrl,
    type: GIT_PROJECT_TYPE,
    config: { remoteUrl },
    identifier: gitProjectIdentifier(gitPath.toString(), remoteUrl),
  };
}

export function createGitClones(deps: GitClonesDeps): GitClones {
  const { fs, gitClient, remotesDir, logger, dispatcher } = deps;

  return {
    async *resolveUrl(git) {
      const expanded = expandGitUrl(git);
      if (isLocalGitOrigin(expanded)) {
        throw new Error(
          `Cannot clone "${git}": it is a path on this machine. Open the folder instead.`
        );
      }

      // Deterministic clone path from URL
      const repoName = extractRepoName(expanded);
      const gitPath = managedClonePath(remotesDir(), expanded);

      // Check for existing clone via filesystem
      try {
        await fs.readdir(gitPath.toString());
        logger.debug("Found existing project for URL", {
          url: expanded,
          existingPath: gitPath.toString(),
        });
        return resolved(gitPath, expanded);
      } catch {
        // Not found — clone
      }

      logger.debug("Cloning repository", { url: expanded, gitPath: gitPath.toString() });

      yield* streamProgress<CloneProgressFrame>(async (emit) => {
        await gitClient.clone(expanded, gitPath, (event) => {
          emit({ stage: event.stage, progress: event.progress / 100, name: repoName });
        });
      });

      return resolved(gitPath, expanded);
    },

    async removeClone(projectPath) {
      // The clone directory is the parent of the project path (remotes/<url-hash>/).
      //
      // Best-effort, and it says so on failure: by now the project is out of
      // state and its workspaces are gone, so throwing would leave the app
      // inconsistent without saving the clone. Matches the local branch of
      // removeLocalRepo — one flag, one failure story.
      const cloneDir = new Path(projectPath).dirname;
      try {
        await fs.rm(cloneDir, { recursive: true, force: true });
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        logger
          .scoped({ path: cloneDir.toString() })
          .warn("Failed to remove clone directory", { error: message });
        notify(dispatcher, {
          type: "error",
          title: "Could not remove the cloned repository",
          message: `${cloneDir.toString()} is still on disk: ${message}`,
          dismissible: true,
        });
      }
    },
  };
}
