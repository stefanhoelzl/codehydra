/**
 * MCP API handlers factory.
 *
 * Creates a flat McpApiHandlers implementation that dispatches intents,
 * following the same pattern as ipc-event-bridge.ts bridge handlers.
 */

import type { Dispatcher } from "../intents/infrastructure/dispatcher";
import type { PluginServer } from "../../services/plugin-server/plugin-server";
import type { McpApiHandlers } from "../../services/mcp-server/types";
import type { Workspace } from "../../shared/api/types";
import { INTENT_GET_WORKSPACE_STATUS } from "../operations/get-workspace-status";
import type { GetWorkspaceStatusIntent } from "../operations/get-workspace-status";
import { INTENT_GET_METADATA } from "../operations/get-metadata";
import type { GetMetadataIntent } from "../operations/get-metadata";
import { INTENT_SET_METADATA } from "../operations/set-metadata";
import type { SetMetadataIntent } from "../operations/set-metadata";
import { INTENT_GET_AGENT_SESSION } from "../operations/get-agent-session";
import type { GetAgentSessionIntent } from "../operations/get-agent-session";
import { INTENT_RESTART_AGENT } from "../operations/restart-agent";
import type { RestartAgentIntent } from "../operations/restart-agent";
import { INTENT_OPEN_WORKSPACE } from "../operations/open-workspace";
import type { OpenWorkspaceIntent } from "../operations/open-workspace";
import { INTENT_DELETE_WORKSPACE } from "../operations/delete-workspace";
import type { DeleteWorkspaceIntent } from "../operations/delete-workspace";
import { INTENT_LIST_PROJECTS } from "../operations/list-projects";
import type { ListProjectsIntent } from "../operations/list-projects";

/**
 * Create McpApiHandlers that dispatch intents via the Dispatcher.
 *
 * @param dispatcher - The intent dispatcher
 * @param pluginServer - Plugin server for executeCommand (may be null)
 */
export function createMcpHandlers(
  dispatcher: Dispatcher,
  pluginServer: PluginServer | null
): McpApiHandlers {
  return {
    async getStatus(workspacePath) {
      const intent: GetWorkspaceStatusIntent = {
        type: INTENT_GET_WORKSPACE_STATUS,
        payload: { workspacePath },
      };
      const result = await dispatcher.dispatch(intent);
      if (!result) {
        throw new Error("Get workspace status dispatch returned no result");
      }
      return result;
    },

    async getMetadata(workspacePath) {
      const intent: GetMetadataIntent = {
        type: INTENT_GET_METADATA,
        payload: { workspacePath },
      };
      const result = await dispatcher.dispatch(intent);
      if (!result) {
        throw new Error("Get metadata dispatch returned no result");
      }
      return result;
    },

    async setMetadata(workspacePath, key, value) {
      const intent: SetMetadataIntent = {
        type: INTENT_SET_METADATA,
        payload: { workspacePath, key, value },
      };
      await dispatcher.dispatch(intent);
    },

    async getAgentSession(workspacePath) {
      const intent: GetAgentSessionIntent = {
        type: INTENT_GET_AGENT_SESSION,
        payload: { workspacePath },
      };
      return dispatcher.dispatch(intent);
    },

    async restartAgentServer(workspacePath) {
      const intent: RestartAgentIntent = {
        type: INTENT_RESTART_AGENT,
        payload: { workspacePath },
      };
      const result = await dispatcher.dispatch(intent);
      if (result === undefined) {
        throw new Error("Restart agent dispatch returned no result");
      }
      return result;
    },

    async listProjects() {
      const intent: ListProjectsIntent = {
        type: INTENT_LIST_PROJECTS,
        payload: {} as Record<string, never>,
      };
      const result = await dispatcher.dispatch(intent);
      if (!result) {
        throw new Error("List projects dispatch returned no result");
      }
      return result;
    },

    async createWorkspace(options) {
      const intent: OpenWorkspaceIntent = {
        type: INTENT_OPEN_WORKSPACE,
        payload: {
          projectPath: options.projectPath,
          workspaceName: options.name,
          base: options.base,
          ...(options.initialPrompt !== undefined && { initialPrompt: options.initialPrompt }),
          ...(options.stealFocus !== undefined && { stealFocus: options.stealFocus }),
        },
      };
      const result = await dispatcher.dispatch(intent);
      if (!result) {
        throw new Error("Create workspace dispatch returned no result");
      }
      return result as Workspace;
    },

    async deleteWorkspace(workspacePath, options) {
      const intent: DeleteWorkspaceIntent = {
        type: INTENT_DELETE_WORKSPACE,
        payload: {
          workspacePath,
          keepBranch: options.keepBranch,
          force: false,
          removeWorktree: true,
          ignoreWarnings: options.ignoreWarnings ?? false,
        },
      };
      const handle = dispatcher.dispatch(intent);
      if (!(await handle.accepted)) {
        return { started: false };
      }
      await handle;
      return { started: true };
    },

    async executeCommand(workspacePath, command, args) {
      if (!pluginServer) {
        throw new Error("Plugin server not available");
      }
      const result = await pluginServer.sendCommand(workspacePath, command, args);
      if (!result.success) {
        throw new Error(result.error);
      }
      return result.data;
    },

    async showNotification(workspacePath, request, timeoutMs) {
      if (!pluginServer) {
        throw new Error("Plugin server not available");
      }
      const result = await pluginServer.showNotification(workspacePath, request, timeoutMs);
      if (!result.success) {
        throw new Error(result.error);
      }
      return result.data;
    },

    async updateStatusBar(workspacePath, request) {
      if (!pluginServer) {
        throw new Error("Plugin server not available");
      }
      const result = await pluginServer.updateStatusBar(workspacePath, request);
      if (!result.success) {
        throw new Error(result.error);
      }
    },

    async disposeStatusBar(workspacePath, request) {
      if (!pluginServer) {
        throw new Error("Plugin server not available");
      }
      const result = await pluginServer.disposeStatusBar(workspacePath, request);
      if (!result.success) {
        throw new Error(result.error);
      }
    },

    async showQuickPick(workspacePath, request, timeoutMs) {
      if (!pluginServer) {
        throw new Error("Plugin server not available");
      }
      const result = await pluginServer.showQuickPick(workspacePath, request, timeoutMs);
      if (!result.success) {
        throw new Error(result.error);
      }
      return result.data;
    },

    async showInputBox(workspacePath, request, timeoutMs) {
      if (!pluginServer) {
        throw new Error("Plugin server not available");
      }
      const result = await pluginServer.showInputBox(workspacePath, request, timeoutMs);
      if (!result.success) {
        throw new Error(result.error);
      }
      return result.data;
    },
  };
}
