/**
 * WorkspaceSelectionModule - Hook module for workspace auto-selection.
 *
 * Registers a "select-next" hook handler on the switch-workspace operation.
 * Encapsulates the selection algorithm and agent-status scoring.
 *
 * Maintains its own status cache populated by agent:status-updated events
 * (follows the BadgeModule event-subscription pattern).
 */

import type { IntentModule } from "../intents/infrastructure/module";
import type { HookContext } from "../intents/infrastructure/operation";
import type { DomainEvent } from "../intents/infrastructure/types";
import { SWITCH_WORKSPACE_OPERATION_ID, selectNextWorkspace } from "../operations/switch-workspace";
import type {
  SelectNextHookInput,
  SelectNextHookResult,
  AgentStatusScorer,
} from "../operations/switch-workspace";
import type { AgentStatusUpdatedEvent } from "../operations/update-agent-status";
import { EVENT_AGENT_STATUS_UPDATED } from "../operations/update-agent-status";
import type { WorkspaceDeletedEvent } from "../operations/delete-workspace";
import { EVENT_WORKSPACE_DELETED } from "../operations/delete-workspace";
import { extractWorkspaceName } from "../../shared/api/id-utils";
import type { WorkspacePath, AggregatedAgentStatus } from "../../shared/ipc";

export function createWorkspaceSelectionModule(): IntentModule {
  const workspaceStatuses = new Map<WorkspacePath, AggregatedAgentStatus>();

  const scorer: AgentStatusScorer = (workspacePath: WorkspacePath): number => {
    const status = workspaceStatuses.get(workspacePath);
    if (!status || status.status === "none") return 2;
    if (status.status === "busy") return 1;
    return 0;
  };

  return {
    name: "workspace-selection",
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
    events: {
      [EVENT_AGENT_STATUS_UPDATED]: {
        handler: async (event: DomainEvent) => {
          const { workspacePath, status } = (event as AgentStatusUpdatedEvent).payload;
          workspaceStatuses.set(workspacePath, status);
        },
      },
      [EVENT_WORKSPACE_DELETED]: {
        handler: async (event: DomainEvent) => {
          const { workspacePath } = (event as WorkspaceDeletedEvent).payload;
          workspaceStatuses.delete(workspacePath as WorkspacePath);
        },
      },
    },
  };
}
