/**
 * BadgeModule - Event subscriber module for updating the app icon badge.
 *
 * Subscribes to:
 * - agent:status-updated: updates internal map, re-aggregates, calls badgeManager.updateBadge()
 * - workspace:deleted: evicts deleted workspace from internal map, re-aggregates
 *
 * The aggregation logic (aggregateWorkspaceStates) is a standalone pure function
 * extracted from BadgeManager.
 */

import type { IntentModule } from "../intents/infrastructure/module";
import type { DomainEvent } from "../intents/infrastructure/types";
import type { BadgeManager, BadgeState } from "../managers/badge-manager";
import type { AgentStatusUpdatedEvent } from "../operations/update-agent-status";
import { EVENT_AGENT_STATUS_UPDATED } from "../operations/update-agent-status";
import type { WorkspaceDeletedEvent } from "../operations/delete-workspace";
import { EVENT_WORKSPACE_DELETED } from "../operations/delete-workspace";
import type { WorkspacePath, AggregatedAgentStatus } from "../../shared/ipc";

/**
 * Aggregates workspace statuses into a single badge state.
 *
 * Logic:
 * - "none": No workspaces with agents, or all workspaces are ready (idle)
 * - "all-working": All workspaces with agents are busy
 * - "mixed": Some workspaces ready, some working
 *
 * Note: Workspaces with "mixed" status (both idle and busy agents) count as "working"
 * since they have active work in progress.
 *
 * @param statuses - Map of workspace paths to their aggregated statuses
 * @returns Badge state to display
 */
export function aggregateWorkspaceStates(
  statuses: ReadonlyMap<WorkspacePath, AggregatedAgentStatus>
): BadgeState {
  let hasReady = false;
  let hasWorking = false;

  for (const status of statuses.values()) {
    switch (status.status) {
      case "idle":
        hasReady = true;
        break;
      case "busy":
      case "mixed":
        hasWorking = true;
        break;
      // "none" status doesn't affect the badge
    }
  }

  if (!hasReady && !hasWorking) {
    return "none";
  }
  if (hasReady && !hasWorking) {
    return "none";
  }
  if (!hasReady && hasWorking) {
    return "all-working";
  }
  return "mixed";
}

/**
 * Create a badge module that subscribes to agent status and workspace deletion events.
 *
 * @param badgeManager - The BadgeManager to call updateBadge() on
 * @returns IntentModule with event subscriptions
 */
export function createBadgeModule(badgeManager: BadgeManager): IntentModule {
  const workspaceStatuses = new Map<WorkspacePath, AggregatedAgentStatus>();

  function updateBadge(): void {
    const state = aggregateWorkspaceStates(workspaceStatuses);
    badgeManager.updateBadge(state);
  }

  return {
    events: {
      [EVENT_AGENT_STATUS_UPDATED]: (event: DomainEvent) => {
        const { workspacePath, status } = (event as AgentStatusUpdatedEvent).payload;
        workspaceStatuses.set(workspacePath, status);
        updateBadge();
      },
      [EVENT_WORKSPACE_DELETED]: (event: DomainEvent) => {
        const { workspacePath } = (event as WorkspaceDeletedEvent).payload;
        workspaceStatuses.delete(workspacePath as WorkspacePath);
        updateBadge();
      },
    },
  };
}
