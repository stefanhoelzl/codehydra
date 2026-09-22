/**
 * LockModule — single-holder resources shared across workspaces (`ch lock`).
 *
 * A dozen workspaces, one physical phone: a lock is how they take turns. The
 * table lives here, in memory, and the `lock.*` registry entries reach it through
 * `EntryDeps.locks` — there are no lock intents. Nothing needs to hook into
 * taking a lock or react to one changing, so an operation would be ceremony; the
 * day something does, the change is one event-only `lock:changed` intent this
 * module dispatches after every table change (the `agent:update-status` shape).
 *
 * The holder is the WORKSPACE, not a process. A take returns as soon as the lock
 * is granted and the hold continues without anything running, so a workspace can
 * hold a lock across many agent turns and still go idle. The hold ends when the
 * workspace releases it, hibernates, or is deleted — project close deletes its
 * workspaces at runtime, so it needs no rule of its own. Closing the agent
 * terminal deliberately does not release: the lock may have been taken from a
 * regular terminal. The one process-held form is `ch lock run`, which sets
 * `releaseOnDisconnect` so a killed run frees the lock through its connection's
 * abort signal.
 *
 * Waiters queue FIFO and are granted atomically on release, so there is no gap
 * between "it is free" and "it is mine" for another workspace to win. A waiter
 * whose caller disconnects leaves the queue — otherwise the lock would later be
 * granted to a workspace nobody is waiting in.
 *
 * In-memory is enough because a restart tears down every workspace's terminals:
 * every holder is gone by then, and a persisted lock would be one nobody can
 * release. The sidebar tags this writes DO persist (they are git-config
 * metadata), so they are reconciled against the table whenever a workspace is
 * (re)discovered.
 */

import type { IntentModule } from "../intents/lib/module";
import type { DomainEvent } from "../intents/lib/types";
import type { Dispatcher } from "../intents/lib/dispatcher";
import type { Logger } from "../boundaries/platform/logging";
import type { WorkspacePath } from "../intents/contract";
import { ApiError } from "../api/errors";
import type {
  LockKey,
  LockSnapshot,
  LockTakeOptions,
  LockTakeResult,
  Locks,
} from "../api/entries/deps";
import { Path } from "../utils/path/path";
import { formatAge } from "../utils/age";
import { TAGS_METADATA_KEY_PREFIX } from "../shared/api/types";
import { INTENT_SET_METADATA, type SetMetadataIntent } from "../intents/set-metadata";
import { EVENT_WORKSPACE_CREATED, type WorkspaceCreatedEvent } from "../intents/open-workspace";
import { EVENT_WORKSPACE_DELETED, type WorkspaceDeletedEvent } from "../intents/delete-workspace";
import {
  EVENT_WORKSPACE_HIBERNATED,
  type WorkspaceHibernatedEvent,
} from "../intents/hibernate-workspace";

/**
 * Metadata keys of the two sidebar tags. Fixed rather than derived from the lock
 * name: git config rejects `_` in a variable name, and lock names allow it.
 */
export const LOCK_TAG_KEY = `${TAGS_METADATA_KEY_PREFIX}lock`;
export const LOCK_WAIT_TAG_KEY = `${TAGS_METADATA_KEY_PREFIX}lock-wait`;

const HELD_ICON = "🔒";
const WAITING_ICON = "⏳";

export interface LockModuleDeps {
  readonly dispatcher: Dispatcher;
  readonly logger: Logger;
}

export interface LockModule extends IntentModule {
  readonly locks: Locks;
}

interface Holder {
  /** Normalized, for comparison. */
  readonly workspace: string;
  readonly workspacePath: WorkspacePath;
  readonly reason: string | undefined;
  readonly acquiredAt: number;
  /** Stops listening to the caller's connection, for a `releaseOnDisconnect` hold. */
  detach?: () => void;
}

interface Waiter {
  readonly workspace: string;
  readonly workspacePath: WorkspacePath;
  readonly reason: string | undefined;
  readonly enqueuedAt: number;
  readonly options: LockTakeOptions;
  readonly resolve: (result: LockTakeResult) => void;
  readonly reject: (error: Error) => void;
  readonly onAbort: () => void;
}

interface Lock {
  readonly key: LockKey;
  holder: Holder;
  readonly queue: Waiter[];
}

/** The two tag values a workspace currently shows; null means no tag. */
interface TagState {
  readonly held: string | null;
  readonly waiting: string | null;
}

/** Map key for a lock. `\0` cannot appear in a name or a path. */
function idOf(key: LockKey): string {
  return `${key.project ?? ""}\0${key.name}`;
}

function normalize(workspacePath: WorkspacePath): string {
  return new Path(workspacePath).toString();
}

function workspaceName(workspacePath: WorkspacePath): string {
  return new Path(workspacePath).basename;
}

export function createLockModule(deps: LockModuleDeps): LockModule {
  const { dispatcher, logger } = deps;

  const locks = new Map<string, Lock>();

  // What each workspace's tags were last written as, so an unchanged table never
  // costs a git write. Absent means "no tag", which is also what a workspace has
  // until the discovery reconcile below says otherwise.
  const written = new Map<string, TagState>();
  // One write chain per workspace: set-metadata is async, and two writes for the
  // same key landing out of order would leave the older value on screen.
  const chains = new Map<string, Promise<void>>();
  // Deleted workspaces: their worktree is gone, so writing their tags would fail.
  const gone = new Set<string>();

  // ---------------------------------------------------------------------------
  // Tags
  // ---------------------------------------------------------------------------

  function tagsFor(workspace: string): TagState {
    const held: Lock[] = [];
    const waiting: Lock[] = [];
    for (const lock of locks.values()) {
      if (lock.holder.workspace === workspace) held.push(lock);
      else if (lock.queue.some((w) => w.workspace === workspace)) waiting.push(lock);
    }
    held.sort((a, b) => a.holder.acquiredAt - b.holder.acquiredAt);

    const heldTag =
      held.length === 0
        ? null
        : JSON.stringify({
            label: `${HELD_ICON} ${held.map((l) => l.key.name).join(", ")}`,
            // A lock taken with no reason still names itself in the label; its line
            // in the tooltip is just the name.
            description: held
              .map((l) =>
                l.holder.reason === undefined ? l.key.name : `${l.key.name} — ${l.holder.reason}`
              )
              .join("\n"),
          });

    const waitingTag =
      waiting.length === 0
        ? null
        : JSON.stringify({
            label: `${WAITING_ICON} ${waiting.map((l) => l.key.name).join(", ")}`,
            description: waiting
              .map((l) => {
                const by = `${l.key.name} — held by '${workspaceName(l.holder.workspacePath)}'`;
                return l.holder.reason === undefined ? by : `${by} — "${l.holder.reason}"`;
              })
              .join("\n"),
          });

    // No age anywhere: a tag is written once per change and would go stale.
    return { held: heldTag, waiting: waitingTag };
  }

  function writeTag(
    workspacePath: WorkspacePath,
    key: string,
    value: string | null
  ): Promise<void> {
    return dispatcher
      .dispatch<SetMetadataIntent>({
        type: INTENT_SET_METADATA,
        payload: { workspacePath, key, value },
      })
      .then(() => undefined);
  }

  /** Bring the tags of these workspaces in line with the table. Cosmetic: never throws. */
  function refreshTags(workspacePaths: Iterable<WorkspacePath>): void {
    const seen = new Set<string>();
    for (const workspacePath of workspacePaths) {
      const workspace = normalize(workspacePath);
      if (seen.has(workspace) || gone.has(workspace)) continue;
      seen.add(workspace);

      const next = tagsFor(workspace);
      const previous = written.get(workspace) ?? { held: null, waiting: null };
      if (next.held === previous.held && next.waiting === previous.waiting) continue;
      written.set(workspace, next);

      const chain = (chains.get(workspace) ?? Promise.resolve()).then(async () => {
        try {
          if (next.held !== previous.held) await writeTag(workspacePath, LOCK_TAG_KEY, next.held);
          if (next.waiting !== previous.waiting) {
            await writeTag(workspacePath, LOCK_WAIT_TAG_KEY, next.waiting);
          }
        } catch (error) {
          // Forget what we thought we wrote, so the next change retries it.
          written.delete(workspace);
          logger.warn("Failed to update lock tags", {
            workspacePath,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
      chains.set(workspace, chain);
      void chain.finally(() => {
        if (chains.get(workspace) === chain) chains.delete(workspace);
      });
    }
  }

  /** Every workspace whose tags a change to this lock can move. */
  function involved(lock: Lock): WorkspacePath[] {
    return [lock.holder.workspacePath, ...lock.queue.map((w) => w.workspacePath)];
  }

  // ---------------------------------------------------------------------------
  // Table
  // ---------------------------------------------------------------------------

  function describeHolder(lock: Lock): string {
    const name = workspaceName(lock.holder.workspacePath);
    const reason = lock.holder.reason === undefined ? "" : ` — "${lock.holder.reason}"`;
    return `'${lock.key.name}' is held by '${name}' (${formatAge(lock.holder.acquiredAt)})${reason}`;
  }

  function newHolder(
    workspacePath: WorkspacePath,
    reason: string | undefined,
    options: LockTakeOptions,
    id: string
  ): Holder {
    const holder: Holder = {
      workspace: normalize(workspacePath),
      workspacePath,
      reason,
      acquiredAt: Date.now(),
    };
    if (options.releaseOnDisconnect) {
      // Held for as long as the caller's connection lives: `ch lock run` killed
      // mid-command frees the lock. Guarded on identity, so an abort arriving
      // after the lock changed hands releases nothing.
      const onAbort = () => {
        const current = locks.get(id);
        if (current?.holder !== holder) return;
        logger.info("Lock released: holder disconnected", {
          lock: current.key.name,
          workspace: workspacePath,
        });
        releaseHolder(current);
      };
      options.signal.addEventListener("abort", onAbort, { once: true });
      holder.detach = () => options.signal.removeEventListener("abort", onAbort);
    }
    return holder;
  }

  /**
   * End the current hold and hand the lock to the next live waiter, or drop it.
   *
   * The handoff is synchronous: the next holder is installed before this returns,
   * so nothing can take the lock in between.
   */
  function releaseHolder(lock: Lock): void {
    const id = idOf(lock.key);
    const previous = lock.holder;
    previous.detach?.();
    const touched: WorkspacePath[] = involved(lock);

    let next: Waiter | undefined;
    while ((next = lock.queue.shift()) !== undefined) {
      next.options.signal.removeEventListener("abort", next.onAbort);
      if (!next.options.signal.aborted) break;
      // Aborted but not yet removed by its listener: its caller is gone.
      next.reject(new ApiError("failed", "The caller disconnected while waiting."));
    }

    if (next === undefined) {
      locks.delete(id);
      logger.debug("Lock released", { lock: lock.key.name, workspace: previous.workspacePath });
      refreshTags(touched);
      return;
    }

    const waiter = next;
    lock.holder = newHolder(waiter.workspacePath, waiter.reason, waiter.options, id);
    const waitedMs = Date.now() - waiter.enqueuedAt;
    waiter.resolve({ acquired: true, waitedMs });

    // Other takes from the same workspace were queued behind it; now that it is
    // the holder they are re-takes, which are reentrant.
    for (let i = lock.queue.length - 1; i >= 0; i--) {
      const same = lock.queue[i]!;
      if (same.workspace !== waiter.workspace) continue;
      lock.queue.splice(i, 1);
      same.options.signal.removeEventListener("abort", same.onAbort);
      same.resolve({ acquired: false, waitedMs: Date.now() - same.enqueuedAt });
    }

    logger.info("Lock handed over", {
      lock: lock.key.name,
      from: previous.workspacePath,
      to: waiter.workspacePath,
      waitedMs,
    });
    refreshTags(touched);
  }

  /** Release everything a workspace holds and drop what it is queued for. */
  function releaseWorkspace(workspacePath: WorkspacePath, why: string): void {
    const workspace = normalize(workspacePath);
    for (const lock of [...locks.values()]) {
      const dropped = lock.queue.filter((w) => w.workspace === workspace);
      if (dropped.length > 0) {
        lock.queue.splice(
          0,
          lock.queue.length,
          ...lock.queue.filter((w) => w.workspace !== workspace)
        );
        for (const waiter of dropped) {
          waiter.options.signal.removeEventListener("abort", waiter.onAbort);
          waiter.reject(new ApiError("failed", `The workspace was ${why} while waiting.`));
        }
      }
      if (lock.holder.workspace === workspace) {
        logger.info(`Lock released: workspace ${why}`, {
          lock: lock.key.name,
          workspace: workspacePath,
        });
        releaseHolder(lock);
      }
    }
    refreshTags([workspacePath]);
  }

  const table: Locks = {
    take(workspacePath, key, options) {
      const id = idOf(key);
      const workspace = normalize(workspacePath);
      const lock = locks.get(id);

      if (lock === undefined) {
        if (options.signal.aborted) {
          return Promise.reject(new ApiError("failed", "The caller disconnected."));
        }
        const created: Lock = {
          key,
          holder: newHolder(workspacePath, options.reason, options, id),
          queue: [],
        };
        locks.set(id, created);
        logger.info("Lock taken", {
          lock: key.name,
          project: key.project,
          workspace: workspacePath,
        });
        refreshTags([workspacePath]);
        return Promise.resolve({ acquired: true, waitedMs: 0 });
      }

      // Reentrant: already ours. Nothing changes — not even the reason.
      if (lock.holder.workspace === workspace) {
        return Promise.resolve({ acquired: false, waitedMs: 0 });
      }

      if (!options.wait) {
        return Promise.reject(new ApiError("conflict", describeHolder(lock)));
      }
      if (options.signal.aborted) {
        return Promise.reject(new ApiError("failed", "The caller disconnected."));
      }

      return new Promise<LockTakeResult>((resolve, reject) => {
        const waiter: Waiter = {
          workspace,
          workspacePath,
          reason: options.reason,
          enqueuedAt: Date.now(),
          options,
          resolve,
          reject,
          onAbort: () => {
            const index = lock.queue.indexOf(waiter);
            if (index === -1) return;
            lock.queue.splice(index, 1);
            logger.debug("Lock waiter left: caller disconnected", {
              lock: key.name,
              workspace: workspacePath,
            });
            reject(new ApiError("failed", "The caller disconnected while waiting."));
            refreshTags([workspacePath]);
          },
        };
        options.signal.addEventListener("abort", waiter.onAbort, { once: true });
        lock.queue.push(waiter);
        logger.debug("Lock queued", {
          lock: key.name,
          workspace: workspacePath,
          position: lock.queue.length,
        });
        refreshTags([workspacePath]);
      });
    },

    release(workspacePath, key) {
      const lock = locks.get(idOf(key));
      if (lock === undefined || lock.holder.workspace !== normalize(workspacePath)) {
        const holder =
          lock === undefined ? "" : ` (held by '${workspaceName(lock.holder.workspacePath)}')`;
        throw new ApiError("not-found", `'${key.name}' is not held by this workspace${holder}.`);
      }
      releaseHolder(lock);
    },

    list(): readonly LockSnapshot[] {
      return [...locks.values()].map((lock) => ({
        name: lock.key.name,
        project: lock.key.project,
        holder: lock.holder.workspacePath,
        ...(lock.holder.reason !== undefined && { reason: lock.holder.reason }),
        acquiredAt: lock.holder.acquiredAt,
        waiting: lock.queue.map((w) => w.workspacePath),
      }));
    },
  };

  return {
    name: "lock",
    locks: table,
    events: {
      [EVENT_WORKSPACE_DELETED]: {
        handler: async (event: DomainEvent): Promise<void> => {
          const { workspacePath } = (event as WorkspaceDeletedEvent).payload;
          // Mark first, so the release below does not try to write tags into a
          // worktree that no longer exists. A runtime-only teardown (project
          // close) leaves the worktree, and its stale tags are reconciled when the
          // workspace is next discovered.
          gone.add(normalize(workspacePath));
          written.delete(normalize(workspacePath));
          releaseWorkspace(workspacePath, "deleted");
        },
      },
      [EVENT_WORKSPACE_HIBERNATED]: {
        handler: async (event: DomainEvent): Promise<void> => {
          releaseWorkspace((event as WorkspaceHibernatedEvent).payload.workspacePath, "hibernated");
        },
      },
      // Startup re-discovery, wake, and project re-open all come through here.
      // Seed what the workspace actually shows from its metadata and reconcile:
      // tags left behind by a previous run (or a teardown) are cleared, and a lock
      // taken since is kept.
      [EVENT_WORKSPACE_CREATED]: {
        handler: async (event: DomainEvent): Promise<void> => {
          const { workspacePath, metadata } = (event as WorkspaceCreatedEvent).payload;
          const workspace = normalize(workspacePath);
          gone.delete(workspace);
          const held = metadata[LOCK_TAG_KEY] ?? null;
          const waiting = metadata[LOCK_WAIT_TAG_KEY] ?? null;
          if (held === null && waiting === null && !written.has(workspace)) return;
          written.set(workspace, { held, waiting });
          refreshTags([workspacePath]);
        },
      },
    },
  };
}
