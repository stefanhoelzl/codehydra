/**
 * Wire PluginServer API handlers to CodeHydraApi.
 *
 * This module bridges incoming API calls from VS Code extensions to the main
 * application API. The PluginServer provides workspace path from the socket
 * connection, which is passed directly to workspacePath-based API methods.
 *
 * The `create` handler uses `callerWorkspacePath` so the intent system can
 * resolve the project from the calling workspace — no external registry needed.
 */

import type { PluginServer, ApiCallHandlers } from "../../services/plugin-server";
import type {
  SetMetadataRequest,
  DeleteWorkspaceRequest,
  ExecuteCommandRequest,
  WorkspaceCreateRequest,
  PluginResult,
} from "../../shared/plugin-protocol";
import type { ICodeHydraApi } from "../../shared/api/interfaces";
import type { Logger } from "../../services/logging";
import { getErrorMessage } from "../../shared/error-utils";

/**
 * Wire PluginServer API handlers to CodeHydraApi.
 *
 * All operations pass workspacePath directly. The `create` handler uses
 * `callerWorkspacePath` to let the intent system resolve the project.
 *
 * @param pluginServer - The PluginServer instance
 * @param api - The CodeHydra API implementation
 * @param logger - Logger for API call logging
 */
export function wirePluginApi(
  pluginServer: PluginServer,
  api: ICodeHydraApi,
  logger: Logger
): void {
  /**
   * Wrap an API call with error handling.
   */
  async function handleApiCall<T>(
    workspacePath: string,
    operation: string,
    fn: () => Promise<T>,
    logContext?: Record<string, unknown>
  ): Promise<PluginResult<T>> {
    try {
      const result = await fn();
      logger.debug(`${operation} success`, { workspace: workspacePath, ...logContext });
      return { success: true, data: result };
    } catch (error) {
      const message = getErrorMessage(error);
      logger.error(`${operation} error`, {
        workspace: workspacePath,
        error: message,
        ...logContext,
      });
      return { success: false, error: message };
    }
  }

  const handlers: ApiCallHandlers = {
    async getStatus(workspacePath: string) {
      return handleApiCall(workspacePath, "getStatus", () =>
        api.workspaces.getStatus(workspacePath)
      );
    },

    async getAgentSession(workspacePath: string) {
      return handleApiCall(workspacePath, "getAgentSession", () =>
        api.workspaces.getAgentSession(workspacePath)
      );
    },

    async restartAgentServer(workspacePath: string) {
      return handleApiCall(workspacePath, "restartAgentServer", () =>
        api.workspaces.restartAgentServer(workspacePath)
      );
    },

    async getMetadata(workspacePath: string) {
      return handleApiCall(workspacePath, "getMetadata", async () => {
        const metadata = await api.workspaces.getMetadata(workspacePath);
        return metadata as Record<string, string>;
      });
    },

    async setMetadata(workspacePath: string, request: SetMetadataRequest) {
      return handleApiCall(
        workspacePath,
        "setMetadata",
        async () => {
          await api.workspaces.setMetadata(workspacePath, request.key, request.value);
          return undefined;
        },
        { key: request.key }
      );
    },

    async delete(workspacePath: string, request: DeleteWorkspaceRequest) {
      return handleApiCall(
        workspacePath,
        "delete",
        () =>
          api.workspaces.remove(workspacePath, {
            ...(request.keepBranch !== undefined && { keepBranch: request.keepBranch }),
          }),
        { keepBranch: !!request.keepBranch }
      );
    },

    async executeCommand(workspacePath: string, request: ExecuteCommandRequest) {
      return handleApiCall(
        workspacePath,
        "executeCommand",
        () => api.workspaces.executeCommand(workspacePath, request.command, request.args),
        { command: request.command }
      );
    },

    async create(workspacePath: string, request: WorkspaceCreateRequest) {
      return handleApiCall(
        workspacePath,
        "create",
        () => {
          // Build options object conditionally to satisfy exactOptionalPropertyTypes
          const options: Record<string, unknown> = {
            callerWorkspacePath: workspacePath,
          };
          if (request.initialPrompt !== undefined) {
            options.initialPrompt = request.initialPrompt;
          }
          if (request.keepInBackground !== undefined) {
            options.keepInBackground = request.keepInBackground;
          }

          return api.workspaces.create(undefined, request.name, request.base, options);
        },
        { name: request.name }
      );
    },
  };

  pluginServer.onApiCall(handlers);
  logger.info("Plugin API handlers registered");
}
