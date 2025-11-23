// src/lib/stores/agentStatus.ts

import { writable, derived, get, type Readable } from 'svelte/store';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { AggregatedAgentStatus, AgentStatusChangedEvent } from '$lib/types/agentStatus';
import { createNoAgentsStatus } from '$lib/types/agentStatus';

/**
 * Map of workspace path to agent status.
 *
 * IMPORTANT: Keys are workspace paths as strings. Always use paths exactly as
 * received from the backend to ensure consistency. Do not normalize or modify
 * paths in the frontend.
 */
export const agentStatuses = writable<Map<string, AggregatedAgentStatus>>(new Map());

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
}

/** Clear all statuses */
export function clearAllStatuses(): void {
  agentStatuses.set(new Map());
}

/** Initialize the status listener for Tauri events */
export async function initAgentStatusListener(): Promise<UnlistenFn> {
  const unlisten = await listen<AgentStatusChangedEvent>('agent-status-changed', (event) => {
    updateWorkspaceStatus(event.payload.workspacePath, event.payload.status);
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
