// src/lib/types/agentStatus.ts

/** Status counts from agent providers */
export interface AgentStatusCounts {
  idle: number;
  busy: number;
}

/** Aggregated status for a workspace - discriminated union */
export type AggregatedAgentStatus =
  | { type: 'noAgents' }
  | { type: 'allIdle'; count: number }
  | { type: 'allBusy'; count: number }
  | { type: 'mixed'; idle: number; busy: number };

/** Event emitted when agent status changes */
export interface AgentStatusChangedEvent {
  workspacePath: string;
  status: AggregatedAgentStatus;
  counts: AgentStatusCounts;
}

/** Status indicator color for UI */
export type StatusIndicatorColor = 'green' | 'red' | 'mixed' | 'grey';

/** Get indicator color from aggregated status */
export function getStatusColor(status: AggregatedAgentStatus): StatusIndicatorColor {
  switch (status.type) {
    case 'noAgents':
      return 'grey';
    case 'allIdle':
      return 'green';
    case 'allBusy':
      return 'red';
    case 'mixed':
      return 'mixed';
  }
}

/** Get human-readable tooltip text from status */
export function getStatusTooltip(status: AggregatedAgentStatus): string {
  switch (status.type) {
    case 'noAgents':
      return 'No agents running';
    case 'allIdle':
      return `${status.count} agent${status.count > 1 ? 's' : ''} idle`;
    case 'allBusy':
      return `${status.count} agent${status.count > 1 ? 's' : ''} busy`;
    case 'mixed':
      return `${status.idle} idle, ${status.busy} busy`;
  }
}

/** Get total agent count from status */
export function getTotalAgents(status: AggregatedAgentStatus): number {
  switch (status.type) {
    case 'noAgents':
      return 0;
    case 'allIdle':
    case 'allBusy':
      return status.count;
    case 'mixed':
      return status.idle + status.busy;
  }
}

/** Create a default "no agents" status */
export function createNoAgentsStatus(): AggregatedAgentStatus {
  return { type: 'noAgents' };
}

/** Derive status color from counts */
export function getStatusColorFromCounts(counts: AgentStatusCounts): StatusIndicatorColor {
  const { idle, busy } = counts;
  if (idle === 0 && busy === 0) return 'grey';
  if (busy === 0) return 'green';
  if (idle === 0) return 'red';
  return 'mixed';
}

/** Derive tooltip from counts */
export function getTooltipFromCounts(counts: AgentStatusCounts): string {
  const { idle, busy } = counts;
  if (idle === 0 && busy === 0) return 'No agents running';
  if (busy === 0) return `${idle} agent${idle > 1 ? 's' : ''} idle`;
  if (idle === 0) return `${busy} agent${busy > 1 ? 's' : ''} busy`;
  return `${idle} idle, ${busy} busy`;
}

/** Create default empty counts */
export function createEmptyCounts(): AgentStatusCounts {
  return { idle: 0, busy: 0 };
}
