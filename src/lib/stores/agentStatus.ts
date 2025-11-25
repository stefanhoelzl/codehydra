// src/lib/stores/agentStatus.ts

import { writable, derived, get, type Readable } from 'svelte/store';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  AggregatedAgentStatus,
  AgentStatusChangedEvent,
  AgentStatusCounts,
} from '$lib/types/agentStatus';
import { createNoAgentsStatus, createEmptyCounts } from '$lib/types/agentStatus';
import { AgentNotificationService } from '$lib/services/agentNotifications';

/**
 * Map of workspace path to agent status.
 *
 * IMPORTANT: Keys are workspace paths as strings. Always use paths exactly as
 * received from the backend to ensure consistency. Do not normalize or modify
 * paths in the frontend.
 */
export const agentStatuses = writable<Map<string, AggregatedAgentStatus>>(new Map());

/**
 * Map of workspace path to raw agent counts.
 * Used for chime detection and direct counts access.
 */
export const agentCounts = writable<Map<string, AgentStatusCounts>>(new Map());

// Singleton notification service for chime handling
let notificationService: AgentNotificationService | null = null;

/**
 * Get the notification service instance.
 * Creates one if it doesn't exist.
 */
export function getNotificationService(): AgentNotificationService {
  if (!notificationService) {
    notificationService = new AgentNotificationService();
  }
  return notificationService;
}

/**
 * Reset the notification service (for testing).
 */
export function resetNotificationService(): void {
  notificationService?.reset();
  notificationService = null;
}

/**
 * Get status for a specific workspace (non-reactive snapshot).
 * Use `createWorkspaceStatusDerived` for reactive updates in components.
 */
export function getWorkspaceStatus(workspacePath: string): AggregatedAgentStatus {
  const statuses = get(agentStatuses);
  return statuses.get(workspacePath) ?? createNoAgentsStatus();
}

/**
 * Create a reactive derived store for a specific workspace's status.
 * Use this in Svelte components for automatic updates.
 *
 * @example
 * ```svelte
 * <script>
 *   const status = createWorkspaceStatusDerived(workspace.path);
 * </script>
 * <AgentStatusIndicator status={$status} />
 * ```
 */
export function createWorkspaceStatusDerived(
  workspacePath: string
): Readable<AggregatedAgentStatus> {
  return derived(
    agentStatuses,
    ($statuses) => $statuses.get(workspacePath) ?? createNoAgentsStatus()
  );
}

/** Update status for a workspace */
export function updateWorkspaceStatus(workspacePath: string, status: AggregatedAgentStatus): void {
  agentStatuses.update((statuses) => {
    const newStatuses = new Map(statuses);
    newStatuses.set(workspacePath, status);
    return newStatuses;
  });
}

/** Remove status for a workspace */
export function removeWorkspaceStatus(workspacePath: string): void {
  agentStatuses.update((statuses) => {
    const newStatuses = new Map(statuses);
    newStatuses.delete(workspacePath);
    return newStatuses;
  });
  agentCounts.update((counts) => {
    const newCounts = new Map(counts);
    newCounts.delete(workspacePath);
    return newCounts;
  });
  getNotificationService().removeWorkspace(workspacePath);
}

/** Clear all statuses */
export function clearAllStatuses(): void {
  agentStatuses.set(new Map());
  agentCounts.set(new Map());
  getNotificationService().reset();
}

/** Update counts for a workspace */
export function updateWorkspaceCounts(workspacePath: string, counts: AgentStatusCounts): void {
  agentCounts.update((existingCounts) => {
    const newCounts = new Map(existingCounts);
    newCounts.set(workspacePath, counts);
    return newCounts;
  });
}

/**
 * Get counts for a specific workspace (non-reactive snapshot).
 */
export function getWorkspaceCounts(workspacePath: string): AgentStatusCounts {
  const counts = get(agentCounts);
  return counts.get(workspacePath) ?? createEmptyCounts();
}

/**
 * Create a reactive derived store for a specific workspace's counts.
 */
export function createWorkspaceCountsDerived(workspacePath: string): Readable<AgentStatusCounts> {
  return derived(agentCounts, ($counts) => $counts.get(workspacePath) ?? createEmptyCounts());
}

/** Initialize the status listener for Tauri events */
export async function initAgentStatusListener(): Promise<UnlistenFn> {
  const service = getNotificationService();

  const unlisten = await listen<AgentStatusChangedEvent>('agent-status-changed', (event) => {
    const { workspacePath, status, counts } = event.payload;

    // Handle chime notification (detects busy -> idle transitions)
    service.handleStatusChange(workspacePath, counts);

    // Update both stores
    updateWorkspaceStatus(workspacePath, status);
    updateWorkspaceCounts(workspacePath, counts);
  });

  return unlisten;
}

/** Batch update multiple workspace statuses */
export function updateMultipleStatuses(updates: Map<string, AggregatedAgentStatus>): void {
  agentStatuses.update((statuses) => {
    const newStatuses = new Map(statuses);
    for (const [path, status] of updates) {
      newStatuses.set(path, status);
    }
    return newStatuses;
  });
}

/** Load initial statuses from backend */
export async function loadInitialStatuses(): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  try {
    const statuses = await invoke<Record<string, AggregatedAgentStatus>>('get_all_agent_statuses');
    updateMultipleStatuses(new Map(Object.entries(statuses)));
  } catch (e) {
    console.error('Failed to load initial agent statuses:', e);
  }
}
