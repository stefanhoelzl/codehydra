/**
 * IPC handlers for agent status operations.
 */

import type { IpcMainInvokeEvent } from "electron";
import type { z } from "zod";
import type { AggregatedAgentStatus } from "../../shared/ipc";
import type { AgentGetStatusPayloadSchema } from "./validation";
import type { AgentStatusManager } from "../../services/opencode/agent-status-manager";
import type { DiscoveryService } from "../../services/opencode/discovery-service";

/**
 * Validated payload type for agent:get-status.
 * Uses Zod inference to get the branded WorkspacePath type from the schema.
 */
type AgentGetStatusValidatedPayload = z.infer<typeof AgentGetStatusPayloadSchema>;

/**
 * Creates handler for agent:get-status command.
 * Returns the aggregated status for a specific workspace.
 */
export function createAgentGetStatusHandler(
  agentStatusManager: AgentStatusManager
): (
  event: IpcMainInvokeEvent,
  payload: AgentGetStatusValidatedPayload
) => Promise<AggregatedAgentStatus> {
  return async (_event, payload) => {
    // workspacePath is already typed as WorkspacePath from the schema transform
    return agentStatusManager.getStatus(payload.workspacePath);
  };
}

/**
 * Creates handler for agent:get-all-statuses command.
 * Returns all workspace statuses as a Record (for IPC serialization).
 */
export function createAgentGetAllStatusesHandler(
  agentStatusManager: AgentStatusManager
): (event: IpcMainInvokeEvent, payload: void) => Promise<Record<string, AggregatedAgentStatus>> {
  return async () => {
    const statusMap = agentStatusManager.getAllStatuses();
    const result: Record<string, AggregatedAgentStatus> = {};
    for (const [path, status] of statusMap) {
      result[path] = status;
    }
    return result;
  };
}

/**
 * Creates handler for agent:refresh command.
 * Triggers an immediate discovery scan.
 */
export function createAgentRefreshHandler(
  discoveryService: DiscoveryService
): (event: IpcMainInvokeEvent, payload: void) => Promise<void> {
  return async () => {
    // Trigger scan, ignore result (fire-and-forget for manual refresh)
    await discoveryService.scan();
  };
}
