/**
 * MCP API handlers factory.
 *
 * Creates a flat McpApiHandlers implementation that dispatches intents.
 * All operations — including UI and command — go through the dispatcher.
 */

import type { Dispatcher } from "../intents/lib/dispatcher";
import type { McpApiHandlers } from "../services/mcp-server/types";
import type { Workspace } from "../shared/api/types";
import { INTENT_GET_WORKSPACE_STATUS } from "../intents/operations/get-workspace-status";
import type { GetWorkspaceStatusIntent } from "../intents/operations/get-workspace-status";
import { INTENT_GET_METADATA } from "../intents/operations/get-metadata";
import type { GetMetadataIntent } from "../intents/operations/get-metadata";
import { INTENT_SET_METADATA } from "../intents/operations/set-metadata";
import type { SetMetadataIntent } from "../intents/operations/set-metadata";
import { INTENT_GET_AGENT_SESSION } from "../intents/operations/get-agent-session";
import type { GetAgentSessionIntent } from "../intents/operations/get-agent-session";
import { INTENT_RESTART_AGENT } from "../intents/operations/restart-agent";
import type { RestartAgentIntent } from "../intents/operations/restart-agent";
import { INTENT_OPEN_WORKSPACE } from "../intents/operations/open-workspace";
import type { OpenWorkspaceIntent } from "../intents/operations/open-workspace";
import { INTENT_DELETE_WORKSPACE } from "../intents/operations/delete-workspace";
import type { DeleteWorkspaceIntent } from "../intents/operations/delete-workspace";
import { INTENT_LIST_PROJECTS } from "../intents/operations/list-projects";
import type { ListProjectsIntent } from "../intents/operations/list-projects";
import { INTENT_VSCODE_SHOW_MESSAGE } from "../intents/operations/vscode-show-message";
import type { VscodeShowMessageIntent } from "../intents/operations/vscode-show-message";
import { INTENT_VSCODE_COMMAND } from "../intents/operations/vscode-command";
import type { VscodeCommandIntent } from "../intents/operations/vscode-command";

/**
 * Create McpApiHandlers that dispatch intents via the Dispatcher.
 */
export function createMcpHandlers(dispatcher: Dispatcher): McpApiHandlers {
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
      const intent: VscodeCommandIntent = {
        type: INTENT_VSCODE_COMMAND,
        payload: { workspacePath, command, args },
      };
      return dispatcher.dispatch(intent);
    },

    async showMessage(workspacePath, request) {
      const intent: VscodeShowMessageIntent = {
        type: INTENT_VSCODE_SHOW_MESSAGE,
        payload: { workspacePath, ...request },
      };
      return dispatcher.dispatch(intent);
    },
  };
}
