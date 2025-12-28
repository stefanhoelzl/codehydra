/**
 * Agent status store using Svelte 5 runes.
 * Manages agent status for workspaces.
 * This is a pure state container - IPC subscriptions are handled externally.
 *
 * Uses the v2 AgentStatus format directly from the API.
 */

import { SvelteMap } from "svelte/reactivity";
import type { AgentStatus } from "@shared/api/types";

// ============ State ============

const _statuses = new SvelteMap<string, AgentStatus>();

// ============ Default Status ============

const DEFAULT_STATUS: AgentStatus = { type: "none" };

// ============ Default Counts ============

const DEFAULT_COUNTS = { idle: 0, busy: 0 };

// ============ Actions ============

/**
 * Update the status for a specific workspace.
 * @param workspacePath - Path to the workspace
 * @param status - New agent status (v2 format)
 */
export function updateStatus(workspacePath: string, status: AgentStatus): void {
  _statuses.set(workspacePath, status);
}

/**
 * Set all statuses at once from a record (typically from initial fetch).
 * Clears existing statuses before setting new ones.
 * @param statuses - Record of workspace paths to their statuses
 */
export function setAllStatuses(statuses: Record<string, AgentStatus>): void {
  _statuses.clear();
  for (const [path, status] of Object.entries(statuses)) {
    _statuses.set(path, status);
  }
}

/**
 * Get the status for a specific workspace.
 * @param workspacePath - Path to the workspace
 * @returns Agent status, or 'none' status if not found
 */
export function getStatus(workspacePath: string): AgentStatus {
  return _statuses.get(workspacePath) ?? DEFAULT_STATUS;
}

/**
 * Get the counts for a specific workspace.
 * Safely extracts counts from status, returning zeros for "none" status.
 * @param workspacePath - Path to the workspace
 * @returns Agent counts (idle and busy)
 */
export function getCounts(workspacePath: string): { idle: number; busy: number } {
  const status = _statuses.get(workspacePath);
  if (!status || status.type === "none") {
    return DEFAULT_COUNTS;
  }
  return { idle: status.counts.idle, busy: status.counts.busy };
}

/**
 * Reset store to initial state. Used for testing.
 */
export function reset(): void {
  _statuses.clear();
}
