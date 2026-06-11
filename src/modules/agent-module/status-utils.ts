/**
 * Pure status conversion helpers shared by the agent module providers.
 */

import type { AggregatedAgentStatus } from "../../shared/ipc";
import type { AgentStatus } from "./types";

/**
 * The "no agent" aggregated status.
 */
export function createNoneStatus(): AggregatedAgentStatus {
  return { status: "none", counts: { idle: 0, busy: 0 } };
}

/**
 * Convert a single-workspace agent status to its aggregated representation.
 */
export function convertToAggregatedStatus(status: AgentStatus): AggregatedAgentStatus {
  switch (status) {
    case "none":
      return { status: "none", counts: { idle: 0, busy: 0 } };
    case "idle":
      return { status: "idle", counts: { idle: 1, busy: 0 } };
    case "busy":
      return { status: "busy", counts: { idle: 0, busy: 1 } };
  }
}

/**
 * Derive an agent status from idle/busy counts.
 */
export function countsToStatus(counts: { idle: number; busy: number }): AgentStatus {
  if (counts.idle === 0 && counts.busy === 0) {
    return "none";
  }
  if (counts.busy > 0) {
    return "busy";
  }
  return "idle";
}
