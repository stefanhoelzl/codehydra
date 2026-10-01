/**
 * Shared per-workspace agent-status cache for intent modules.
 *
 * Several modules (badge, power, workspace-selection) each need an up-to-date
 * map of workspace ref → aggregated agent status, maintained by subscribing to
 * the same two domain events. This helper owns that map and the two event
 * handlers, invoking an optional `onChange` callback after every mutation so the
 * module can re-derive whatever it drives (badge state, sleep blocker, …).
 *
 * - agent:status-updated → set(workspace.ref, status)
 * - workspace:deleted    → delete(workspaceRef)
 *
 * The `workspace:deleted` subscription covers both full deletion and
 * project:close runtime teardown, which both emit it.
 */

import type { EventDeclarations } from "../intents/lib/module";
import type { DomainEvent } from "../intents/lib/types";
import type { AgentStatusUpdatedEvent } from "../intents/update-agent-status";
import { EVENT_AGENT_STATUS_UPDATED } from "../intents/update-agent-status";
import type { WorkspaceDeletedEvent } from "../intents/delete-workspace";
import { EVENT_WORKSPACE_DELETED } from "../intents/delete-workspace";
import type { WorkspaceRef, AggregatedAgentStatus } from "../shared/ipc";

export interface WorkspaceStatusCache {
  /** Live, read-only view of the current per-workspace statuses. */
  readonly statuses: ReadonlyMap<WorkspaceRef, AggregatedAgentStatus>;
  /** Event handlers to spread into the owning module's `events`. */
  readonly events: EventDeclarations;
}

/**
 * Create a workspace agent-status cache.
 *
 * @param onChange - Called after every set/delete. Omit for modules that read
 *   the map lazily (e.g. on demand from a scorer) rather than reacting to changes.
 */
export function createWorkspaceStatusCache(onChange?: () => void): WorkspaceStatusCache {
  const statuses = new Map<WorkspaceRef, AggregatedAgentStatus>();

  return {
    statuses,
    events: {
      [EVENT_AGENT_STATUS_UPDATED]: {
        handler: async (event: DomainEvent): Promise<void> => {
          const { workspace, status } = (event as AgentStatusUpdatedEvent).payload;
          statuses.set(workspace.ref, status);
          onChange?.();
        },
      },
      [EVENT_WORKSPACE_DELETED]: {
        handler: async (event: DomainEvent): Promise<void> => {
          statuses.delete((event as WorkspaceDeletedEvent).payload.workspaceRef);
          onChange?.();
        },
      },
    },
  };
}
