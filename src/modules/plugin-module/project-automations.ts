/**
 * A repository's plugins as its default branch has them: what its automations
 * run from.
 *
 * An automation is project-wide and timed, while every worktree can hold a
 * different `.codehydra/plugins`, so it needs one copy no worktree decides. That
 * is the folder as committed on the branch new workspaces fork from, written
 * under `<data>/plugins/project-automations/<project dir>/<commit>/`.
 *
 * Each read resolves the branch's tip, which is cheap and local: whichever fetch
 * moved it, the next read lands the new commit beside the old copy and switches
 * to it. A copy is written to a temporary folder and renamed, so a half-written
 * one is never read. A script already running keeps the copy it started in: it
 * holds a lease (`acquire`), and a copy goes once it is neither current nor
 * leased. A commit without the folder is remembered as an empty copy, so it is
 * not looked for again.
 *
 * The repository is only read. Its copies are not worktrees: a detached checkout
 * would appear in `git worktree list`, be warned about at every discovery and be
 * offered for adoption.
 */

import type { FileSystemBoundary } from "../../boundaries/platform/filesystem";
import type { IGitClient } from "../../boundaries/platform/git-client";
import type { Logger } from "../../boundaries/platform/logging-types";
import { projectDirName } from "../../boundaries/platform/paths";
import { getErrorMessage } from "../../shared/error-utils";
import { Path } from "../../utils/path/path";
import { WORKSPACE_PLUGINS_DIR } from "./discovery";

export interface ProjectCopy {
  /** The folder holding the plugins. */
  readonly dir: Path;
  readonly commit: string;
}

/** What reading a project's default branch came to. */
export type ProjectCopyResult =
  | { readonly state: "ready"; readonly copy: ProjectCopy }
  /** The branch names no commit: there is nothing to read, nor anything wrong. */
  | { readonly state: "none" }
  | { readonly state: "failed"; readonly message: string };

export interface ProjectCopies {
  /** The current copy of a project's plugins, written first if the branch has moved. */
  read(projectPath: Path, branch: string): Promise<ProjectCopyResult>;
  /** Keep a copy from being removed while a script runs from it. */
  acquire(dir: Path): () => void;
}

export interface ProjectCopiesDeps {
  readonly git: Pick<IGitClient, "resolveCommit" | "exportFolder">;
  readonly fileSystem: Pick<FileSystemBoundary, "mkdir" | "readdir" | "rename" | "rm">;
  readonly logger: Logger;
  /** `<data>/plugins/project-automations`. */
  readonly root: Path;
}

const TEMP_PREFIX = ".tmp-";

export function createProjectCopies(deps: ProjectCopiesDeps): ProjectCopies {
  /** The commit each project's copy was last read at, by its directory. */
  const currents = new Map<string, string>();
  /** One write per project at a time. */
  const queues = new Map<string, Promise<unknown>>();
  /** Scripts running from each copy. */
  const leases = new Map<string, number>();
  let tempCounter = 0;

  function serialize<T>(dir: Path, work: () => Promise<T>): Promise<T> {
    const key = dir.toString();
    const next = (queues.get(key) ?? Promise.resolve()).then(work, work);
    const tail = next.then(
      () => undefined,
      () => undefined
    );
    queues.set(key, tail);
    void tail.then(() => {
      if (queues.get(key) === tail) queues.delete(key);
    });
    return next;
  }

  async function exists(path: Path): Promise<boolean> {
    try {
      await deps.fileSystem.readdir(path);
      return true;
    } catch {
      return false;
    }
  }

  /** Write a commit's copy unless it is already there. */
  async function write(projectPath: Path, dir: Path, commit: string): Promise<Path> {
    const target = new Path(dir, commit);
    if (await exists(target)) return target;
    const temp = new Path(dir, `${TEMP_PREFIX}${process.pid}-${tempCounter++}`);
    const tree = new Path(temp, "tree");
    try {
      await deps.fileSystem.mkdir(tree);
      await deps.git.exportFolder(
        projectPath,
        commit,
        WORKSPACE_PLUGINS_DIR.join("/"),
        tree,
        new Path(temp, "index")
      );
      await deps.fileSystem.rename(tree, target);
    } finally {
      await deps.fileSystem.rm(temp, { recursive: true, force: true }).catch(() => undefined);
    }
    deps.logger.info("Read a repository's plugins from its default branch", {
      project: projectPath.toString(),
      commit,
    });
    return target;
  }

  /** Remove copies neither current nor leased, and temporary folders left behind. Best-effort. */
  async function prune(dir: Path): Promise<void> {
    const current = currents.get(dir.toString());
    let entries;
    try {
      entries = await deps.fileSystem.readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory || entry.name === current) continue;
      const path = new Path(dir, entry.name);
      if ((leases.get(path.toString()) ?? 0) > 0) continue;
      await deps.fileSystem.rm(path, { recursive: true, force: true }).catch((error: unknown) => {
        deps.logger
          .scoped({ path: path.toString() })
          .warn("Could not remove an old copy of a repository's plugins", {
            error: getErrorMessage(error),
          });
      });
    }
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
      if (currents.get(dir.toString()) === commit) {
        return { state: "ready", copy: { dir: new Path(dir, commit), commit } };
      }
      return serialize(dir, async (): Promise<ProjectCopyResult> => {
        try {
          const target = await write(projectPath, dir, commit);
          currents.set(dir.toString(), commit);
          await prune(dir);
          return { state: "ready", copy: { dir: target, commit } };
        } catch (error) {
          const message = getErrorMessage(error);
          deps.logger
            .scoped({ path: projectPath.toString() })
            .warn("Could not read a repository's plugins from its default branch", {
              commit,
              error: message,
            });
          return { state: "failed", message };
        }
      });
    },
    acquire(copy) {
      const key = copy.toString();
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
        const dir = copy.dirname;
        void serialize(dir, () => prune(dir));
      };
    },
  };
}
