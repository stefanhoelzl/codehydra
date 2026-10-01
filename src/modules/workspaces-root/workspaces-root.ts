/**
 * Where CodeHydra keeps source code: the worktrees it creates and the clones of
 * managed (URL-cloned) projects.
 *
 *   <root>/projects/<name>-<path-hash>/workspaces/<workspace>
 *   <root>/remotes/<repo>-<url-hash>/<repo>
 *
 * The root defaults to the data root and moves with the `paths.workspaces` setting
 * (e.g. onto a Windows Dev Drive). Everything else CodeHydra stores — binaries,
 * logs, state, project records — stays in the data root.
 *
 * Read on every call, never captured: the root in use is settled at startup (the
 * app:start `migrations` hook) after the modules that consume it are built.
 */

import { Path } from "../../utils/path/path";
import { projectDirName } from "../../boundaries/platform/paths";

export interface WorkspacesRoot {
  /** The root in use. */
  current(): Path;
  /** Where managed projects are cloned to. */
  remotesDir(): Path;
  /** Where a project's new worktrees are created. */
  workspacesDir(projectPath: string | Path): Path;
  /**
   * Workspaces directories a migration left under earlier roots, of every
   * project. Worktrees in them are still CodeHydra's own.
   */
  previousWorkspacesDirs(): readonly Path[];
}

/** Worktree directory of a project under a given root. */
export function workspacesDirUnder(root: Path, projectPath: string | Path): Path {
  return new Path(root, "projects", projectDirName(new Path(projectPath).toString()), "workspaces");
}

/** Managed-clone directory under a given root. */
export function remotesDirUnder(root: Path): Path {
  return new Path(root, "remotes");
}

/**
 * @param current Returns the root in use; read on every call.
 * @param previous Returns the workspaces directories left under earlier roots.
 */
export function createWorkspacesRoot(
  current: () => Path,
  previous: () => readonly Path[] = () => []
): WorkspacesRoot {
  return {
    current,
    remotesDir: () => remotesDirUnder(current()),
    workspacesDir: (projectPath) => workspacesDirUnder(current(), projectPath),
    previousWorkspacesDirs: previous,
  };
}
