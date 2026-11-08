/**
 * Detached checkouts of single commits, side by side in one folder:
 * `<dir>/<commit>/`. What plugins run from when no worktree of the user's is
 * theirs to read: a remote source's clone (remotes.ts) and a repository's
 * default branch (project-automations.ts).
 *
 * A checkout is never updated in place: a new commit lands beside the old one,
 * and the caller switches to it. A script already running keeps the checkout it
 * started in: it holds a lease (`acquire`), and a checkout is removed only once
 * it is neither the one kept nor leased. Work on one folder runs one at a time
 * (`serialize`), so a removal never meets a checkout being made.
 */

import type { FileSystemBoundary } from "../../boundaries/platform/filesystem";
import type { IGitClient } from "../../boundaries/platform/git-client";
import type { Logger } from "../../boundaries/platform/logging-types";
import { FileSystemError } from "../../shared/errors/service-errors";
import { getErrorMessage } from "../../shared/error-utils";
import { Path } from "../../utils/path/path";

export interface CommitTrees {
  /** Run work on one folder after the work queued on it before. */
  serialize<T>(key: Path, work: () => Promise<T>): Promise<T>;
  /** Whether work is queued on a folder. */
  busy(key: Path): boolean;
  /** A commit's checkout under `dir`, made first unless it is there. */
  checkout(repo: Path, dir: Path, commit: string): Promise<Path>;
  /** Remove the checkouts under `dir` other than `keep`'s that no lease holds. Best-effort. */
  prune(repo: Path, dir: Path, keep: string | undefined): Promise<void>;
  /**
   * Keep a checkout from being removed while a script runs in it. The returned
   * release calls `onIdle` once nothing holds the checkout any more: the moment
   * to prune.
   */
  acquire(tree: Path, onIdle: () => void): () => void;
  /** Whether a lease holds any checkout inside a folder. */
  leased(under: Path): boolean;
}

export interface CommitTreesDeps {
  readonly git: Pick<IGitClient, "addDetachedWorktree" | "removeWorktree" | "pruneWorktrees">;
  readonly fileSystem: Pick<FileSystemBoundary, "mkdir" | "readdir" | "rm">;
  readonly logger: Logger;
}

/** Whether a directory exists; any failure but its absence is thrown. */
export async function directoryExists(
  fileSystem: Pick<FileSystemBoundary, "readdir">,
  path: Path
): Promise<boolean> {
  try {
    await fileSystem.readdir(path);
    return true;
  } catch (error) {
    if (error instanceof FileSystemError && error.fsCode === "ENOENT") return false;
    throw error;
  }
}

export function createCommitTrees(deps: CommitTreesDeps): CommitTrees {
  /** One piece of work per folder at a time. */
  const queues = new Map<string, Promise<unknown>>();
  /** Scripts running in each checkout. */
  const leases = new Map<string, number>();

  return {
    serialize(key, work) {
      const id = key.toString();
      const next = (queues.get(id) ?? Promise.resolve()).then(work, work);
      const tail = next.then(
        () => undefined,
        () => undefined
      );
      queues.set(id, tail);
      // An idle folder has no queue: what is queued is what is busy.
      void tail.then(() => {
        if (queues.get(id) === tail) queues.delete(id);
      });
      return next;
    },

    busy: (key) => queues.has(key.toString()),

    async checkout(repo, dir, commit) {
      const tree = new Path(dir, commit);
      if (await directoryExists(deps.fileSystem, tree)) return tree;
      await deps.fileSystem.mkdir(dir);
      try {
        await deps.git.addDetachedWorktree(repo, tree, commit);
      } catch (error) {
        // A checkout cut short would otherwise pass for a finished one next time.
        await deps.fileSystem.rm(tree, { recursive: true, force: true }).catch(() => undefined);
        await deps.git.pruneWorktrees(repo).catch(() => undefined);
        throw error;
      }
      return tree;
    },

    async prune(repo, dir, keep) {
      let entries;
      try {
        entries = await deps.fileSystem.readdir(dir);
      } catch {
        return;
      }
      let removed = false;
      for (const entry of entries) {
        if (!entry.isDirectory || entry.name === keep) continue;
        const tree = new Path(dir, entry.name);
        if ((leases.get(tree.toString()) ?? 0) > 0) continue;
        try {
          // git forgets the checkout (and removes it); whatever it leaves goes too.
          await deps.git.removeWorktree(repo, tree).catch(() => undefined);
          await deps.fileSystem.rm(tree, { recursive: true, force: true });
          removed = true;
        } catch (error) {
          deps.logger
            .scoped({ path: tree.toString() })
            .warn("Could not remove an old plugin tree", { error: getErrorMessage(error) });
        }
      }
      if (removed) await deps.git.pruneWorktrees(repo).catch(() => undefined);
    },

    acquire(tree, onIdle) {
      const key = tree.toString();
      leases.set(key, (leases.get(key) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const left = (leases.get(key) ?? 1) - 1;
        if (left > 0) {
          leases.set(key, left);
          return;
        }
        leases.delete(key);
        onIdle();
      };
    },

    leased: (under) =>
      [...leases.entries()].some(([tree, count]) => count > 0 && new Path(tree).isChildOf(under)),
  };
}
