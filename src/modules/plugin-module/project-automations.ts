/**
 * A repository as its default branch has it: what its automations run in.
 *
 * An automation is project-wide and timed, while every worktree can hold a
 * different `.codehydra/plugins`, so it needs one checkout no worktree decides:
 * the branch new workspaces fork from, checked out detached under
 * `<data>/plugins/project-automations/<project dir>/<commit>/`. It is the whole
 * repository, so an automation reaches the project's files the way a workspace
 * plugin's hooks reach their worktree's, the same for a local project and for a
 * cloned (bare) one.
 *
 * Each read resolves the branch's tip, which is cheap and local: whichever fetch
 * moved it, the next read checks the new commit out beside the old one and
 * switches to it. Only a commit whose `.codehydra/plugins` exists is checked
 * out, so a project without plugins never gets one. The checkouts, their leases
 * and their removal are commit-trees.ts's, as for a remote source.
 *
 * They are worktrees of the user's repository, so `git worktree list` shows
 * them; CodeHydra's worktree discovery (git-worktree-provider.ts) is told this
 * folder, and leaves them out of its workspaces and of what it offers to adopt.
 */

import type { FileSystemBoundary } from "../../boundaries/platform/filesystem";
import type { IGitClient } from "../../boundaries/platform/git-client";
import type { Logger } from "../../boundaries/platform/logging-types";
import { projectDirName } from "../../boundaries/platform/paths";
import { getErrorMessage } from "../../shared/error-utils";
import { Path } from "../../utils/path/path";
import { createCommitTrees } from "./commit-trees";
import { WORKSPACE_PLUGINS_DIR } from "./discovery";

/** Where under the data folder the checkouts live. */
export const PROJECT_AUTOMATIONS_DIR = "plugins/project-automations";

export interface ProjectCheckout {
  /** The checkout's root: the repository's files at that commit. */
  readonly tree: Path;
  readonly commit: string;
}

/** What reading a project's default branch came to. */
export type ProjectCheckoutResult =
  | { readonly state: "ready"; readonly checkout: ProjectCheckout }
  /** The branch names no commit, or its commit has no plugins: nothing to read, nothing wrong. */
  | { readonly state: "none" }
  | { readonly state: "failed"; readonly message: string };

export interface ProjectCheckouts {
  /** The current checkout of a project's default branch, made first if the branch has moved. */
  read(projectPath: Path, branch: string): Promise<ProjectCheckoutResult>;
  /** Keep a checkout from being removed while a script runs in it. */
  acquire(tree: Path, projectPath: Path): () => void;
}

export interface ProjectCheckoutsDeps {
  readonly git: Pick<
    IGitClient,
    "resolveCommit" | "hasFolder" | "addDetachedWorktree" | "removeWorktree" | "pruneWorktrees"
  >;
  readonly fileSystem: Pick<FileSystemBoundary, "mkdir" | "readdir" | "rm">;
  readonly logger: Logger;
  /** `<data>/plugins/project-automations`. */
  readonly root: Path;
}

export function createProjectCheckouts(deps: ProjectCheckoutsDeps): ProjectCheckouts {
  const trees = createCommitTrees(deps);
  /** The commit each project was last read at, and whether it had plugins, by its directory. */
  const currents = new Map<string, { readonly commit: string; readonly hasPlugins: boolean }>();

  function prune(projectPath: Path, dir: Path): Promise<void> {
    const current = currents.get(dir.toString());
    return trees.prune(projectPath, dir, current?.hasPlugins === true ? current.commit : undefined);
  }

  function result(dir: Path, commit: string, hasPlugins: boolean): ProjectCheckoutResult {
    return hasPlugins
      ? { state: "ready", checkout: { tree: new Path(dir, commit), commit } }
      : { state: "none" };
  }

  return {
    async read(projectPath, branch) {
      const dir = new Path(deps.root, projectDirName(projectPath.toString()));
      let commit: string | null;
      try {
        commit = await deps.git.resolveCommit(projectPath, branch);
      } catch (error) {
        return { state: "failed", message: getErrorMessage(error) };
      }
      if (commit === null) return { state: "none" };
      const known = currents.get(dir.toString());
      if (known?.commit === commit) return result(dir, commit, known.hasPlugins);

      return trees.serialize(dir, async (): Promise<ProjectCheckoutResult> => {
        try {
          // A git failure throws here, and is retried at the next read.
          const hasPlugins = await deps.git.hasFolder(
            projectPath,
            commit,
            WORKSPACE_PLUGINS_DIR.join("/")
          );
          if (hasPlugins) {
            await trees.checkout(projectPath, dir, commit);
            deps.logger.info("Checked out a repository's default branch for its automations", {
              project: projectPath.toString(),
              commit,
            });
          }
          currents.set(dir.toString(), { commit, hasPlugins });
          await prune(projectPath, dir);
          return result(dir, commit, hasPlugins);
        } catch (error) {
          const message = getErrorMessage(error);
          deps.logger
            .scoped({ path: projectPath.toString() })
            .warn("Could not check out a repository's default branch", {
              commit,
              error: message,
            });
          return { state: "failed", message };
        }
      });
    },
    acquire(tree, projectPath) {
      return trees.acquire(tree, () => {
        const dir = tree.dirname;
        void trees.serialize(dir, () => prune(projectPath, dir));
      });
    },
  };
}
