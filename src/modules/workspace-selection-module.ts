/**
 * WorkspaceSelectionModule - Hook module for workspace auto-selection.
 *
 * Registers a "select-next" hook handler on the switch-workspace operation.
 * Encapsulates the selection algorithm and agent-status scoring.
 *
 * Maintains its own status cache populated by agent:status-updated events
 * (follows the BadgeModule event-subscription pattern).
 */

import type { IntentModule } from "../intents/lib/module";
import type { HookOutput } from "../intents/lib/operation";
import { SWITCH_WORKSPACE_OPERATION_ID, selectNextWorkspace } from "../intents/switch-workspace";
import type { SelectNextHookResult, AgentStatusScorer } from "../intents/switch-workspace";
import type { WorkspaceRef } from "../intents/contract";
import { createWorkspaceStatusCache } from "./workspace-status-cache";
import { defineEvents, defineHooks } from "../intents/declarations";

export function createWorkspaceSelectionModule(): IntentModule {
  // Reads the cache lazily on each selection, so no onChange callback is needed.
  const cache = createWorkspaceStatusCache();

  const scorer: AgentStatusScorer = (workspaceRef: WorkspaceRef): number => {
    const status = cache.statuses.get(workspaceRef);
    if (!status || status.status === "none") return 2;
    if (status.status === "busy") return 1;
    return 0;
  };

  return {
    name: "workspace-selection",
    hooks: defineHooks({
      [SWITCH_WORKSPACE_OPERATION_ID]: {
        "select-next": {
          handler: async (ctx): Promise<HookOutput<SelectNextHookResult>> => {
            const { currentRef, candidates } = ctx;
            const result = selectNextWorkspace(currentRef, candidates, scorer);
            return result ? { result: { selected: result } } : { result: {} };
          },
        },
      },
    }),
    events: defineEvents(cache.events),
  };
}
