/**
 * Remote plugin sources: git repositories, checked out where plugins are read.
 *
 * Each remote entry of `plugins.config` gets a directory of its own under
 * `<data>/plugins/remotes/<entry>-<url-hash>/`:
 *
 *   repo.git/          a bare clone
 *   trees/<commit>/    a detached checkout of one commit
 *   current.json       which commit is current, for which ref, fetched when
 *
 * Plugins are read from the current tree. A fetch that lands a new commit
 * checks it out beside the old one and then switches `current`, so a script
 * already running keeps the tree it started in: it holds a lease
 * (`acquire`), and a tree is removed only once it is neither current nor
 * leased. Nothing is ever updated in place. The trees themselves are
 * commit-trees.ts's, shared with a repository's default branch.
 *
 * When fetching happens is deliberate: once at app start (in the background),
 * when an entry is new or its ref changed, and when the user asks
 * (`ch plugin update`). Never otherwise — plugins do not change under a user
 * mid-session. A fetch that fails leaves the last tree running; the failure is
 * the remote's status until a fetch succeeds.
 *
 * Git runs as the user's git does — their SSH keys, credential helpers — as
 * for a project cloned from a URL. There is no terminal to answer a password
 * prompt in, so a private repository needs credentials git finds on its own.
 */

import { createHash } from "node:crypto";
import type { FileSystemBoundary } from "../../boundaries/platform/filesystem";
import type { IGitClient } from "../../boundaries/platform/git-client";
import type { Logger } from "../../boundaries/platform/logging-types";
import { getErrorMessage } from "../../shared/error-utils";
import { Path } from "../../utils/path/path";
import { expandGitUrl, normalizeGitUrl } from "../../utils/url-utils";
import { safeJsonParse, isPlainObject } from "./util";
import { createCommitTrees, directoryExists } from "./commit-trees";

/** What a remote source needs to be checked out. */
export interface RemoteSpec {
  /** The entry's key in `plugins.config`. */
  readonly key: string;
  readonly url: string;
  /** Branch, tag or commit; absent = the repository's default branch. */
  readonly ref?: string;
}

/** Where a remote stands. */
export type RemoteStatus =
  | { readonly state: "cloning" }
  | {
      readonly state: "ready";
      readonly commit: string;
      /** ISO time of the last successful fetch (or clone). */
      readonly fetchedAt: string;
    }
  | {
      readonly state: "failed";
      readonly message: string;
      /** The tree still in use, if an earlier fetch produced one. */
      readonly commit?: string;
      readonly fetchedAt?: string;
    };

export interface RemoteCheckouts {
  /**
   * The current tree of a remote, if it has one yet. A remote never checked
   * out — or whose ref changed — is fetched in the background; until a tree
   * lands it has none, and contributes no plugins.
   */
  tree(spec: RemoteSpec): Promise<Path | undefined>;
  /**
   * Clone or fetch a remote now and switch to what its ref names. Resolves
   * with its status; never throws.
   */
  update(spec: RemoteSpec): Promise<RemoteStatus>;
  /** Fetch every remote, in the background: the app-start refresh. */
  refresh(specs: readonly RemoteSpec[]): void;
  /** Delete the directories of remotes no longer configured. */
  forgetOthers(specs: readonly RemoteSpec[]): Promise<void>;
  status(spec: RemoteSpec): RemoteStatus | undefined;
  /** Keep a tree from being removed while a script runs in it. */
  acquire(tree: Path): () => void;
}

export interface RemoteCheckoutsDeps {
  readonly git: Pick<
    IGitClient,
    | "clone"
    | "fetch"
    | "resolveCommit"
    | "addDetachedWorktree"
    | "removeWorktree"
    | "pruneWorktrees"
  >;
  readonly fileSystem: Pick<
    FileSystemBoundary,
    "readFile" | "writeFile" | "mkdir" | "readdir" | "rm"
  >;
  readonly logger: Logger;
  /** `<data>/plugins/remotes`. */
  readonly root: Path;
  /** Told how every clone or fetch ended, to report a failure and forget it once fixed. */
  readonly onResult?: (spec: RemoteSpec, status: RemoteStatus) => void;
  readonly now?: () => Date;
}

const REPO_DIR = "repo.git";
const TREES_DIR = "trees";
const CURRENT_FILE = "current.json";

/** The directory a remote's clone and trees live in. */
export function remoteDirName(spec: RemoteSpec): string {
  const hash = createHash("sha256")
    .update(normalizeGitUrl(expandGitUrl(spec.url)))
    .digest("hex")
    .substring(0, 8);
  return `${spec.key}-${hash}`;
}

/** A URL's credentials, out of a message a person (or an agent) will read. */
export function scrubCredentials(message: string): string {
  return message.replace(/(\/\/)[^/@\s]+@/g, "$1");
}

/** A 40- or 64-hex commit hash: a ref no fetch can move. */
function isCommitHash(ref: string | undefined): boolean {
  return ref !== undefined && /^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(ref);
}

interface Current {
  readonly commit: string;
  readonly ref: string | null;
  readonly fetchedAt: string;
}

function parseCurrent(text: string): Current | undefined {
  const raw = safeJsonParse(text);
  if (!isPlainObject(raw)) return undefined;
  const { commit, ref, fetchedAt } = raw;
  if (typeof commit !== "string" || typeof fetchedAt !== "string") return undefined;
  if (ref !== null && typeof ref !== "string") return undefined;
  return { commit, ref, fetchedAt };
}

export function createRemoteCheckouts(deps: RemoteCheckoutsDeps): RemoteCheckouts {
  const now = deps.now ?? ((): Date => new Date());

  /** What each remote directory has checked out, once read. */
  const currents = new Map<string, Current>();
  /** Failures and clones in progress, by remote directory. */
  const statuses = new Map<string, RemoteStatus>();
  /** The work a remote has queued, so a second ask joins it. */
  const pending = new Map<string, Promise<RemoteStatus>>();
  /** The ref whose last attempt failed, by remote directory. */
  const failedRefs = new Map<string, string | null>();
  /** Its checkouts; one git operation per remote at a time, by its directory. */
  const trees = createCommitTrees(deps);

  const dirOf = (spec: RemoteSpec): Path => new Path(deps.root, remoteDirName(spec));
  const treeOf = (dir: Path, commit: string): Path => new Path(dir, TREES_DIR, commit);

  async function readCurrent(dir: Path): Promise<Current | undefined> {
    const known = currents.get(dir.toString());
    if (known !== undefined) return known;
    let text: string;
    try {
      text = await deps.fileSystem.readFile(new Path(dir, CURRENT_FILE));
    } catch {
      return undefined;
    }
    const current = parseCurrent(text);
    if (current !== undefined) currents.set(dir.toString(), current);
    return current;
  }

  /** The revisions a ref may name in a bare clone, most likely first. */
  function candidates(ref: string | undefined): string[] {
    if (ref === undefined) return ["origin/HEAD"];
    if (isCommitHash(ref)) return [ref];
    // A branch is a remote-tracking ref in our clones; a tag or a short hash is as written.
    return [`origin/${ref}`, ref];
  }

  async function resolve(repo: Path, ref: string | undefined): Promise<string> {
    for (const rev of candidates(ref)) {
      const commit = await deps.git.resolveCommit(repo, rev);
      if (commit !== null) return commit;
    }
    throw new Error(
      ref === undefined
        ? "the repository has no default branch"
        : `${ref} is not a branch, tag or commit of the repository`
    );
  }

  /** Remove trees that are neither current nor leased. Best-effort. */
  function prune(dir: Path): Promise<void> {
    return trees.prune(
      new Path(dir, REPO_DIR),
      new Path(dir, TREES_DIR),
      currents.get(dir.toString())?.commit
    );
  }

  /** Clone or fetch, resolve the ref, check its commit out and make it current. */
  async function fetchAndSwitch(spec: RemoteSpec, fetch: boolean): Promise<RemoteStatus> {
    const dir = dirOf(spec);
    const repo = new Path(dir, REPO_DIR);
    const previous = await readCurrent(dir);
    try {
      if (!(await directoryExists(deps.fileSystem, repo))) {
        statuses.set(dir.toString(), { state: "cloning" });
        await deps.fileSystem.mkdir(dir);
        try {
          await deps.git.clone(expandGitUrl(spec.url), repo);
        } catch (error) {
          // A clone cut short leaves a directory git will not clone into again.
          await deps.fileSystem.rm(repo, { recursive: true, force: true }).catch(() => undefined);
          throw error;
        }
      } else if (fetch) {
        await deps.git.fetch(repo, "origin");
      }

      const commit = await resolve(repo, spec.ref);
      await trees.checkout(repo, new Path(dir, TREES_DIR), commit);
      const current: Current = { commit, ref: spec.ref ?? null, fetchedAt: now().toISOString() };
      await deps.fileSystem.writeFile(new Path(dir, CURRENT_FILE), JSON.stringify(current));
      currents.set(dir.toString(), current);
      statuses.delete(dir.toString());
      failedRefs.delete(dir.toString());
      if (previous?.commit !== commit) {
        deps.logger.info("Plugin source checked out", { source: spec.key, commit });
      }
      await prune(dir);
      return { state: "ready", commit, fetchedAt: current.fetchedAt };
    } catch (error) {
      const message = scrubCredentials(getErrorMessage(error));
      deps.logger.warn("Plugin source could not be fetched", { source: spec.key, error: message });
      const kept = await readCurrent(dir);
      const status: RemoteStatus = {
        state: "failed",
        message,
        ...(kept !== undefined && { commit: kept.commit, fetchedAt: kept.fetchedAt }),
      };
      statuses.set(dir.toString(), status);
      failedRefs.set(dir.toString(), spec.ref ?? null);
      return status;
    }
  }

  /** Queue a fetch for a remote, joining one already queued. */
  function update(spec: RemoteSpec, fetch = true): Promise<RemoteStatus> {
    const dir = dirOf(spec);
    const key = `${dir.toString()}\0${spec.ref ?? ""}`;
    const queued = pending.get(key);
    if (queued !== undefined) return queued;
    const work = trees
      .serialize(dir, () => fetchAndSwitch(spec, fetch))
      .then((status) => {
        deps.onResult?.(spec, status);
        return status;
      })
      .finally(() => pending.delete(key));
    pending.set(key, work);
    return work;
  }

  function statusOf(spec: RemoteSpec): RemoteStatus | undefined {
    const dir = dirOf(spec);
    const status = statuses.get(dir.toString());
    if (status !== undefined) return status;
    const current = currents.get(dir.toString());
    return current === undefined
      ? undefined
      : { state: "ready", commit: current.commit, fetchedAt: current.fetchedAt };
  }

  return {
    async tree(spec) {
      const dir = dirOf(spec);
      const current = await readCurrent(dir);
      const wanted = spec.ref ?? null;
      if (current !== undefined && current.ref === wanted) return treeOf(dir, current.commit);
      // Never checked out, or pointed elsewhere since: fetch now, in the background.
      // An attempt at this ref that failed waits for `ch plugin update` (or the
      // next start) instead of being retried on every read.
      if (failedRefs.get(dir.toString()) !== wanted) {
        if (current === undefined) statuses.set(dir.toString(), { state: "cloning" });
        void update(spec, current !== undefined);
      }
      // A ref changed: keep running the old tree until the new one lands.
      return current === undefined ? undefined : treeOf(dir, current.commit);
    },
    update: (spec) => update(spec, true),
    refresh(specs) {
      for (const spec of specs) {
        // A commit names its tree for good: there is nothing to fetch for it
        // unless it is not there yet.
        if (isCommitHash(spec.ref)) {
          void readCurrent(dirOf(spec)).then((current) => {
            if (current?.commit.toLowerCase() !== spec.ref?.toLowerCase()) void update(spec);
          });
          continue;
        }
        void update(spec);
      }
    },
    async forgetOthers(specs) {
      const keep = new Set(specs.map(remoteDirName));
      let entries;
      try {
        entries = await deps.fileSystem.readdir(deps.root);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory || keep.has(entry.name)) continue;
        const dir = new Path(deps.root, entry.name);
        if (trees.leased(dir) || trees.busy(dir)) continue;
        try {
          await deps.fileSystem.rm(dir, { recursive: true, force: true });
          currents.delete(dir.toString());
          statuses.delete(dir.toString());
          failedRefs.delete(dir.toString());
          deps.logger.info("Removed a plugin source no longer configured", { dir: entry.name });
        } catch (error) {
          deps.logger
            .scoped({ path: dir.toString() })
            .warn("Could not remove a plugin source", { error: getErrorMessage(error) });
        }
      }
    },
    status: statusOf,
    acquire(tree) {
      return trees.acquire(tree, () => {
        const dir = tree.dirname.dirname;
        void trees.serialize(dir, () => prune(dir));
      });
    },
  };
}
