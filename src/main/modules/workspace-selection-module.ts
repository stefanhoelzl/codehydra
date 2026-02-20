/**
 * WorkspaceSelectionModule - Hook module for workspace auto-selection.
 *
 * Registers a "select-next" hook handler on the switch-workspace operation.
 * Encapsulates the selection algorithm and agent-status scoring.
 *
 * The handler:
 * 1. Receives candidates and the current workspace path
 * 2. Builds a scorer closure over agentStatusManager
 * 3. Calls selectNextWorkspace to find the best candidate
 */

import type { IntentModule } from "../intents/infrastructure/module";
import type { HookContext } from "../intents/infrastructure/operation";
import { SWITCH_WORKSPACE_OPERATION_ID, selectNextWorkspace } from "../operations/switch-workspace";
import type {
  SelectNextHookInput,
  SelectNextHookResult,
  AgentStatusScorer,
} from "../operations/switch-workspace";
import { extractWorkspaceName } from "../../shared/api/id-utils";
import type { WorkspacePath, AggregatedAgentStatus } from "../../shared/ipc";

export function createWorkspaceSelectionModule(agentStatusManager: {
  getStatus(path: WorkspacePath): AggregatedAgentStatus;
}): IntentModule {
  const scorer: AgentStatusScorer = (workspacePath: WorkspacePath): number => {
    const status = agentStatusManager.getStatus(workspacePath);
    if (status.status === "none") return 2;
    if (status.status === "busy") return 1;
    return 0;
  };

  return {
    hooks: {
      [SWITCH_WORKSPACE_OPERATION_ID]: {
        "select-next": {
          handler: async (ctx: HookContext): Promise<SelectNextHookResult> => {
            const { currentPath, candidates } = ctx as unknown as SelectNextHookInput;
            const result = selectNextWorkspace(
              currentPath,
              candidates,
              extractWorkspaceName,
              scorer
            );
            return result ? { selected: result } : {};
          },
        },
      },
    },
  };
}
