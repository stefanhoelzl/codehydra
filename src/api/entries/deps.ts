/**
 * Dependencies the registry entries dispatch through.
 *
 * Entries hold no state of their own. Anything that needs module-level state —
 * notably waiting on a deletion's terminal progress event, which requires a
 * domain-event subscription — is injected here by the module that owns it.
 */

import type { Dispatcher } from "../../intents/lib/dispatcher";
import type { AppBoundary } from "../../boundaries/shell/app";
import type { DeletionProgress } from "../../shared/api/types";
import type { ProjectPath, WorkspacePath } from "../../intents/contract";
import type { OperationRegistry } from "../registry";
import type { Config } from "../../boundaries/platform/config";

/**
 * Where a lock name lives.
 *
 * A global lock is contended for by every workspace of every open project; a
 * project-scoped one only by that project's workspaces. The same name in the
 * two namespaces is two different locks.
 */
export interface LockKey {
  /** `[A-Za-z0-9-_]+` — free-form, created on first take. */
  readonly name: string;
  /** The owning project for a project-scoped lock; null for a global one. */
  readonly project: ProjectPath | null;
}

export interface LockTakeOptions {
  /** Why the caller wants it. Shown to waiters and in the sidebar tag's tooltip. */
  readonly reason?: string | undefined;
  /** Queue behind the holder when it is held, instead of failing with `conflict`. */
  readonly wait: boolean;
  /** The caller's connection; aborting it drops a queued waiter. */
  readonly signal: AbortSignal;
  /**
   * Also release when `signal` aborts after the lock was granted.
   *
   * Only `ch lock run` sets this: its process is the hold, so killing it must
   * free the lock. An ordinary take is held by the workspace and outlives the
   * process that asked for it.
   */
  readonly releaseOnDisconnect: boolean;
}

export interface LockTakeResult {
  /**
   * False when the workspace already held the lock. A re-take is reentrant: it
   * succeeds at once and changes nothing, so a caller that did not acquire must
   * not release — which is how `ch lock run` inside a longer hold leaves it intact.
   */
  readonly acquired: boolean;
  readonly waitedMs: number;
}

/** One lock as it stands right now. Locks exist only while held. */
export interface LockSnapshot {
  readonly name: string;
  readonly project: ProjectPath | null;
  readonly holder: WorkspacePath;
  readonly reason?: string;
  /** Epoch milliseconds. */
  readonly acquiredAt: number;
  /** Queued workspaces, in the order they will be granted. */
  readonly waiting: readonly WorkspacePath[];
}

/**
 * The lock table: single-holder resources shared across workspaces.
 *
 * Owned by the lock module (in-memory, gone at restart) and reached by the
 * `lock.*` entries through here, like `awaitDeletion`.
 */
export interface Locks {
  /**
   * Take a lock for a workspace. Resolves once it is the holder: at once when the
   * lock is free or already this workspace's, otherwise after waiting its turn
   * (FIFO, granted atomically on release). Rejects with `conflict` when held and
   * `wait` is false.
   */
  take(workspace: WorkspacePath, key: LockKey, options: LockTakeOptions): Promise<LockTakeResult>;
  /** Release a lock the workspace holds. Throws `not-found` when it does not hold it. */
  release(workspace: WorkspacePath, key: LockKey): void;
  list(): readonly LockSnapshot[];
}

export interface EntryDeps {
  readonly dispatcher: Dispatcher;
  /**
   * Open a path with the OS. `reveal` shows it in the file manager (selecting a
   * file's containing folder), otherwise it opens with the default application.
   * No intent covers this — the plugin server calls the app boundary directly.
   */
  readonly appLayer: Pick<AppBoundary, "openPath">;
  /**
   * Wait for the terminal deletion-progress event for a workspace.
   *
   * Deletion reports its real outcome through an event rather than the dispatch
   * result: `ctx.emit` is not awaited inside the delete operation, so reading
   * state after `await handle` races the emit. Returns a promise for the
   * terminal progress plus a cleanup to drop the waiter.
   */
  readonly awaitDeletion: (workspacePath: WorkspacePath) => {
    readonly outcome: Promise<DeletionProgress>;
    readonly release: () => void;
  };
  /**
   * The app's config, for the config entries. Called directly rather than
   * through an intent: reading and writing a setting has no hooks to run, and
   * the settings dialog uses the same service the same way.
   */
  readonly config: Pick<
    Config,
    "getDefinitions" | "getEffective" | "getDefault" | "getSource" | "set" | "reset"
  >;
  /**
   * The registry itself, for the entry that describes it.
   *
   * A getter rather than the value because the registry is built FROM these
   * entries: the describe entry has to be able to see the finished registry it
   * is a member of. Set once during construction.
   */
  readonly registry: () => OperationRegistry;
  /** The lock table, owned by the lock module. */
  readonly locks: Locks;
}
