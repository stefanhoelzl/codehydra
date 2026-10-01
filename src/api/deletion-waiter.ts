/**
 * Waiting for a workspace deletion to actually finish.
 *
 * Deletion reports its real outcome through a domain event rather than through
 * the dispatch result: the delete operation does not await its own `ctx.emit`,
 * so reading state after `await handle` races the emit. A caller that wants to
 * know whether the delete succeeded — which is every caller with an exit code to
 * return — has to wait for the terminal event instead.
 *
 * Subscribing lives here rather than inside the delete entry because a
 * subscription is per-process state, and because `subscribe()` leaks its handler
 * on unsubscribe, so it must be taken once rather than per call.
 */

import type { Dispatcher } from "../intents/lib/dispatcher";
import type { DomainEvent } from "../intents/lib/types";
import {
  EVENT_WORKSPACE_DELETION_PROGRESS,
  type WorkspaceDeletionProgressEvent,
} from "../intents/delete-workspace";
import type { DeletionProgress } from "../shared/api/types";
import type { WorkspaceRef } from "../intents/contract";

export interface DeletionWaiter {
  /** Start waiting before dispatching the delete, so the event cannot be missed. */
  await(workspaceRef: WorkspaceRef): {
    readonly outcome: Promise<DeletionProgress>;
    readonly release: () => void;
  };
  dispose(): void;
}

export function createDeletionWaiter(dispatcher: Dispatcher): DeletionWaiter {
  const waiters = new Map<string, Set<(progress: DeletionProgress) => void>>();

  const unsubscribe = dispatcher.subscribe(
    EVENT_WORKSPACE_DELETION_PROGRESS,
    (event: DomainEvent) => {
      const progress = (event as WorkspaceDeletionProgressEvent).payload;
      // In-progress events are steps along the way; only the terminal one
      // carries the outcome.
      if (!progress.completed) return;

      const pending = waiters.get(progress.workspaceRef);
      if (!pending) return;
      waiters.delete(progress.workspaceRef);
      for (const resolve of pending) resolve(progress);
    }
  );

  return {
    await(workspaceRef) {
      let resolveOutcome!: (progress: DeletionProgress) => void;
      const outcome = new Promise<DeletionProgress>((resolve) => {
        resolveOutcome = resolve;
      });

      const pending = waiters.get(workspaceRef) ?? new Set();
      pending.add(resolveOutcome);
      waiters.set(workspaceRef, pending);

      return {
        outcome,
        release: () => {
          const current = waiters.get(workspaceRef);
          if (!current) return;
          current.delete(resolveOutcome);
          if (current.size === 0) waiters.delete(workspaceRef);
        },
      };
    },
    dispose: unsubscribe,
  };
}
