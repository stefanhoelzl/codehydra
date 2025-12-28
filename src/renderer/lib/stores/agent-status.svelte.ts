/**
 * Agent status store using Svelte 5 runes.
 * Manages agent status for workspaces.
 * This is a pure state container - IPC subscriptions are handled externally.
 */

import { SvelteMap } from "svelte/reactivity";
import type { AggregatedAgentStatus } from "@shared/ipc";

// ============ State ============

const _statuses = new SvelteMap<string, AggregatedAgentStatus>();

// ============ Default Status ============

const DEFAULT_STATUS: AggregatedAgentStatus = {
  status: "none",
  counts: { idle: 0, busy: 0 },
};

// ============ Actions ============

/**
 * Update the status for a specific workspace.
 * @param workspacePath - Path to the workspace
 * @param status - New aggregated agent status
 */
export function updateStatus(workspacePath: string, status: AggregatedAgentStatus): void {
  _statuses.set(workspacePath, status);
}

/**
 * Set all statuses at once from a record (typically from getAllAgentStatuses).
 * Clears existing statuses before setting new ones.
 * @param statuses - Record of workspace paths to their statuses
 */
export function setAllStatuses(statuses: Record<string, AggregatedAgentStatus>): void {
  _statuses.clear();
  for (const [path, status] of Object.entries(statuses)) {
    _statuses.set(path, status);
  }
}

/**
 * Get the status for a specific workspace.
 * @param workspacePath - Path to the workspace
 * @returns Aggregated status, or 'none' status if not found
 */
export function getStatus(workspacePath: string): AggregatedAgentStatus {
  return _statuses.get(workspacePath) ?? DEFAULT_STATUS;
}

/**
 * Reset store to initial state. Used for testing.
 */
export function reset(): void {
  _statuses.clear();
}
