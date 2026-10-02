/**
 * Shared per-workspace agent-status cache for intent modules.
 *
 * Several modules (badge, power, workspace-selection, os-notification,
 * workspaces-root, presentation) each need an up-to-date
 * map of workspace ref → aggregated agent status, maintained by subscribing to
 * the same two domain events. This helper owns that map and the two event
 * handlers, invoking an optional `onChange` callback after every mutation so the
 * module can re-derive whatever it drives (badge state, sleep blocker, …) or
 * react to the transition itself (the callback gets the workspace and its status
 * before and after).
 *
 * - agent:status-updated → set(workspace.ref, status)
 * - workspace:deleted    → delete(workspaceRef)
 *
 * The `workspace:deleted` subscription covers both full deletion and
 * project:close runtime teardown, which both emit it.
 */

import type { TypedEventHandler } from "../intents/lib/module";
import { EVENT_AGENT_STATUS_UPDATED } from "../intents/update-agent-status";
import { EVENT_WORKSPACE_DELETED } from "../intents/delete-workspace";
import type { WorkspaceRef, AggregatedAgentStatus } from "../shared/ipc";
import type { EventFor } from "../intents/declarations";

/**
 * Called after every set/delete with the workspace that changed and its status
 * before and after (`undefined` = not tracked: never reported, or deleted).
 */
export type WorkspaceStatusChange = (
  workspaceRef: WorkspaceRef,
  previous: AggregatedAgentStatus | undefined,
  next: AggregatedAgentStatus | undefined
) => void;

export interface WorkspaceStatusCache {
  /** Live, read-only view of the current per-workspace statuses. */
  readonly statuses: ReadonlyMap<WorkspaceRef, AggregatedAgentStatus>;
  /**
   * Event handlers for the owning module's `defineEvents`. Named, so a
   * module with its own work on one of these events can call the cache's
   * handler from its own.
   */
  readonly events: {
    readonly [EVENT_AGENT_STATUS_UPDATED]: TypedEventHandler<
      EventFor<typeof EVENT_AGENT_STATUS_UPDATED>
    >;
    readonly [EVENT_WORKSPACE_DELETED]: TypedEventHandler<EventFor<typeof EVENT_WORKSPACE_DELETED>>;
  };
}

/**
 * Create a workspace agent-status cache.
 *
 * @param onChange - Called after every set/delete, with the transition. Omit for
 *   modules that read the map lazily (e.g. on demand from a scorer) rather than
 *   reacting to changes.
 */
export function createWorkspaceStatusCache(onChange?: WorkspaceStatusChange): WorkspaceStatusCache {
  const statuses = new Map<WorkspaceRef, AggregatedAgentStatus>();

  return {
    statuses,
    events: {
      [EVENT_AGENT_STATUS_UPDATED]: {
        handler: async (event): Promise<void> => {
          const { workspaceRef, status } = event.payload;
          const previous = statuses.get(workspaceRef);
          statuses.set(workspaceRef, status);
          onChange?.(workspaceRef, previous, status);
        },
      },
      [EVENT_WORKSPACE_DELETED]: {
        handler: async (event): Promise<void> => {
          const { workspaceRef } = event.payload;
          const previous = statuses.get(workspaceRef);
          statuses.delete(workspaceRef);
          onChange?.(workspaceRef, previous, undefined);
        },
      },
    },
  };
}
