/**
 * Pure status conversion helpers shared by the agent module providers.
 */

import type { AggregatedAgentStatus } from "../../shared/ipc";
import type { AgentActivity } from "./types";

/**
 * The "no agent" aggregated status.
 */
export function createNoneStatus(): AggregatedAgentStatus {
  return { status: "none", counts: { idle: 0, busy: 0 } };
}

/**
 * Convert a single-workspace agent status to its aggregated representation.
 */
export function convertToAggregatedStatus(status: AgentActivity): AggregatedAgentStatus {
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
 * Detect the `[bg]` marker on a sub-agent's label.
 *
 * A background sub-agent keeps the workspace busy, unless the agent that spawned
 * it opted it out by starting its description with `[bg]` — the sub-agent
 * counterpart of `ch bg` for shells. Claude reports the description in the Stop
 * payload's background_tasks; OpenCode makes it the child session's title.
 * Prefix only and case-insensitive, so the token never fires on prose.
 */
export function isBackgroundAgentLabel(label: string | undefined): boolean {
  return /^\s*\[bg\]/i.test(label ?? "");
}

/**
 * Derive an agent status from idle/busy counts.
 */
export function countsToStatus(counts: { idle: number; busy: number }): AgentActivity {
  if (counts.idle === 0 && counts.busy === 0) {
    return "none";
  }
  if (counts.busy > 0) {
    return "busy";
  }
  return "idle";
}
