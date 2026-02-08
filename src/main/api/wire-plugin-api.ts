/**
 * Wire PluginServer API handlers to CodeHydraApi.
 *
 * This module bridges incoming API calls from VS Code extensions to the main
 * application API. The PluginServer provides workspace path from the socket
 * connection, which is resolved to projectId/workspaceName.
 */

import nodePath from "node:path";
import { generateProjectId } from "./id-utils";
import type { PluginServer, ApiCallHandlers } from "../../services/plugin-server";
import type {
  SetMetadataRequest,
  DeleteWorkspaceRequest,
  ExecuteCommandRequest,
  WorkspaceCreateRequest,
  PluginResult,
} from "../../shared/plugin-protocol";
import type { ICodeHydraApi } from "../../shared/api/interfaces";
import type { ProjectId, WorkspaceName } from "../../shared/api/types";
import type { Logger } from "../../services/logging";
import { getErrorMessage } from "../../shared/error-utils";

/**
 * Interface for resolving workspace paths to project information.
 * Abstracted to allow testing without full AppState.
 */
export interface WorkspaceResolver {
  /**
   * Find the project that contains a workspace.
   * @param workspacePath - Absolute path to the workspace
   * @returns The project containing the workspace, or undefined if not found
   */
  findProjectForWorkspace(workspacePath: string): { path: string } | undefined;
}

/**
 * Wire PluginServer API handlers to CodeHydraApi.
 *
 * This bridges incoming API calls from VS Code extensions to the main
 * application API. The PluginServer provides workspace path from the
 * socket connection, which is resolved to projectId/workspaceName.
 *
 * @param pluginServer - The PluginServer instance
 * @param api - The CodeHydra API implementation
 * @param workspaceResolver - Resolver for workspace paths to projects
 * @param logger - Logger for API call logging
 */
export function wirePluginApi(
  pluginServer: PluginServer,
  api: ICodeHydraApi,
  workspaceResolver: WorkspaceResolver,
  logger: Logger
): void {
  /**
   * Resolve a workspace path to projectId and workspaceName.
   * Returns error result if workspace not found.
   */
  function resolveWorkspace(
    workspacePath: string
  ): { projectId: ProjectId; workspaceName: WorkspaceName } | PluginResult<never> {
    const project = workspaceResolver.findProjectForWorkspace(workspacePath);
    if (!project) {
      return { success: false, error: "Workspace not found" };
    }
    const projectId = generateProjectId(project.path);
    const workspaceName = nodePath.basename(workspacePath) as WorkspaceName;
    return { projectId, workspaceName };
  }

  /**
   * Wrap an API call with workspace resolution and error handling.
   */
  async function handleApiCall<T>(
    workspacePath: string,
    operation: string,
    fn: (projectId: ProjectId, workspaceName: WorkspaceName) => Promise<T>,
    logContext?: Record<string, unknown>
  ): Promise<PluginResult<T>> {
    const resolved = resolveWorkspace(workspacePath);
    if ("success" in resolved && resolved.success === false) {
      return resolved;
    }
    const { projectId, workspaceName } = resolved as {
      projectId: ProjectId;
      workspaceName: WorkspaceName;
    };

    try {
      const result = await fn(projectId, workspaceName);
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
      return handleApiCall(workspacePath, "getStatus", async (projectId, workspaceName) => {
        const status = await api.workspaces.getStatus(projectId, workspaceName);
        return status;
      });
    },

    async getAgentSession(workspacePath: string) {
      return handleApiCall(workspacePath, "getAgentSession", (projectId, workspaceName) =>
        api.workspaces.getAgentSession(projectId, workspaceName)
      );
    },

    async restartAgentServer(workspacePath: string) {
      return handleApiCall(workspacePath, "restartAgentServer", (projectId, workspaceName) =>
        api.workspaces.restartAgentServer(projectId, workspaceName)
      );
    },

    async getMetadata(workspacePath: string) {
      return handleApiCall(workspacePath, "getMetadata", async (projectId, workspaceName) => {
        const metadata = await api.workspaces.getMetadata(projectId, workspaceName);
        return metadata as Record<string, string>;
      });
    },

    async setMetadata(workspacePath: string, request: SetMetadataRequest) {
      return handleApiCall(
        workspacePath,
        "setMetadata",
        async (projectId, workspaceName) => {
          await api.workspaces.setMetadata(projectId, workspaceName, request.key, request.value);
          return undefined;
        },
        { key: request.key }
      );
    },

    async delete(workspacePath: string, request: DeleteWorkspaceRequest) {
      return handleApiCall(
        workspacePath,
        "delete",
        (projectId, workspaceName) =>
          api.workspaces.remove(projectId, workspaceName, {
            ...(request.keepBranch !== undefined && { keepBranch: request.keepBranch }),
          }),
        { keepBranch: !!request.keepBranch }
      );
    },

    async executeCommand(workspacePath: string, request: ExecuteCommandRequest) {
      return handleApiCall(
        workspacePath,
        "executeCommand",
        (projectId, workspaceName) =>
          api.workspaces.executeCommand(projectId, workspaceName, request.command, request.args),
        { command: request.command }
      );
    },

    async create(workspacePath: string, request: WorkspaceCreateRequest) {
      // For create, we only need the projectId from the caller's workspace
      // The new workspace will be created in the same project
      const project = workspaceResolver.findProjectForWorkspace(workspacePath);
      if (!project) {
        return { success: false, error: "Workspace not found" };
      }
      const projectId = generateProjectId(project.path);

      try {
        // Build options object conditionally to satisfy exactOptionalPropertyTypes
        const options =
          request.initialPrompt !== undefined || request.keepInBackground !== undefined
            ? {
                ...(request.initialPrompt !== undefined && {
                  initialPrompt: request.initialPrompt,
                }),
                ...(request.keepInBackground !== undefined && {
                  keepInBackground: request.keepInBackground,
                }),
              }
            : undefined;

        const workspace = await api.workspaces.create(
          projectId,
          request.name,
          request.base,
          options
        );
        logger.debug("create success", { workspace: workspacePath, name: request.name });
        return { success: true, data: workspace };
      } catch (error) {
        const message = getErrorMessage(error);
        logger.error("create error", {
          workspace: workspacePath,
          name: request.name,
          error: message,
        });
        return { success: false, error: message };
      }
    },
  };

  pluginServer.onApiCall(handlers);
  logger.info("Plugin API handlers registered");
}
