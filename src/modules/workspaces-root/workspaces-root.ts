/**
 * Where CodeHydra keeps source code: the worktrees it creates and the clones of
 * managed (URL-cloned) projects.
 *
 *   <root>/projects/<name>-<path-hash>/workspaces/<workspace>
 *   <root>/remotes/<repo>-<url-hash>/<repo>
 *
 * The root defaults to the data root and moves with the `workspaces.root` setting
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
}

/** A project whose path changed: a managed project's clone moved to a new root. */
export interface ProjectMove {
  readonly from: string;
  readonly to: string;
}

/**
 * Rewrites a module's own persisted references to moved project paths. Modules
 * whose state is keyed by project path expose one (they own the accessor).
 */
export type ProjectMoveListener = (moves: readonly ProjectMove[]) => Promise<void>;

/** The path a project now has, when one of the moves names it. */
export function movedPath(moves: readonly ProjectMove[], path: string): string | undefined {
  const target = new Path(path);
  return moves.find((move) => target.equals(move.from))?.to;
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
 */
export function createWorkspacesRoot(current: () => Path): WorkspacesRoot {
  return {
    current,
    remotesDir: () => remotesDirUnder(current()),
    workspacesDir: (projectPath) => workspacesDirUnder(current(), projectPath),
  };
}
