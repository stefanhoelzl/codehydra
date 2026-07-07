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
import type { HookContext, HookOutput } from "../intents/lib/operation";
import { SWITCH_WORKSPACE_OPERATION_ID, selectNextWorkspace } from "../intents/switch-workspace";
import type {
  SelectNextHookInput,
  SelectNextHookResult,
  AgentStatusScorer,
} from "../intents/switch-workspace";
import type { WorkspacePath } from "../shared/ipc";
import { createWorkspaceStatusCache } from "./workspace-status-cache";

export function createWorkspaceSelectionModule(): IntentModule {
  // Reads the cache lazily on each selection, so no onChange callback is needed.
  const cache = createWorkspaceStatusCache();

  const scorer: AgentStatusScorer = (workspacePath: WorkspacePath): number => {
    const status = cache.statuses.get(workspacePath);
    if (!status || status.status === "none") return 2;
    if (status.status === "busy") return 1;
    return 0;
  };

  return {
    name: "workspace-selection",
    hooks: {
      [SWITCH_WORKSPACE_OPERATION_ID]: {
        "select-next": {
          handler: async (ctx: HookContext): Promise<HookOutput<SelectNextHookResult>> => {
            const { currentPath, candidates } = ctx as unknown as SelectNextHookInput;
            const result = selectNextWorkspace(currentPath, candidates, scorer);
            return result ? { result: { selected: result } } : { result: {} };
          },
        },
      },
    },
    events: cache.events,
  };
}
