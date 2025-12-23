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
import type { SetMetadataRequest, PluginResult } from "../../shared/plugin-protocol";
import type { ICodeHydraApi } from "../../shared/api/interfaces";
import type { ProjectId, WorkspaceName } from "../../shared/api/types";
import type { Logger } from "../../services/logging";

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

  const handlers: ApiCallHandlers = {
    async getStatus(workspacePath: string) {
      const resolved = resolveWorkspace(workspacePath);
      if ("success" in resolved && resolved.success === false) {
        return resolved;
      }
      const { projectId, workspaceName } = resolved as {
        projectId: ProjectId;
        workspaceName: WorkspaceName;
      };

      try {
        const status = await api.workspaces.getStatus(projectId, workspaceName);
        logger.debug("getStatus result", {
          workspace: workspacePath,
          isDirty: status.isDirty,
          agentType: status.agent.type,
        });
        return { success: true, data: status };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("getStatus error", { workspace: workspacePath, error: message });
        return { success: false, error: message };
      }
    },

    async getOpencodePort(workspacePath: string) {
      const resolved = resolveWorkspace(workspacePath);
      if ("success" in resolved && resolved.success === false) {
        return resolved;
      }
      const { projectId, workspaceName } = resolved as {
        projectId: ProjectId;
        workspaceName: WorkspaceName;
      };

      try {
        const port = await api.workspaces.getOpencodePort(projectId, workspaceName);
        logger.debug("getOpencodePort result", {
          workspace: workspacePath,
          port,
        });
        return { success: true, data: port };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("getOpencodePort error", { workspace: workspacePath, error: message });
        return { success: false, error: message };
      }
    },

    async getMetadata(workspacePath: string) {
      const resolved = resolveWorkspace(workspacePath);
      if ("success" in resolved && resolved.success === false) {
        return resolved;
      }
      const { projectId, workspaceName } = resolved as {
        projectId: ProjectId;
        workspaceName: WorkspaceName;
      };

      try {
        const metadata = await api.workspaces.getMetadata(projectId, workspaceName);
        logger.debug("getMetadata result", {
          workspace: workspacePath,
          keyCount: Object.keys(metadata).length,
        });
        return { success: true, data: metadata as Record<string, string> };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("getMetadata error", { workspace: workspacePath, error: message });
        return { success: false, error: message };
      }
    },

    async setMetadata(workspacePath: string, request: SetMetadataRequest) {
      const resolved = resolveWorkspace(workspacePath);
      if ("success" in resolved && resolved.success === false) {
        return resolved;
      }
      const { projectId, workspaceName } = resolved as {
        projectId: ProjectId;
        workspaceName: WorkspaceName;
      };

      try {
        await api.workspaces.setMetadata(projectId, workspaceName, request.key, request.value);
        logger.debug("setMetadata success", { workspace: workspacePath, key: request.key });
        return { success: true, data: undefined };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("setMetadata error", {
          workspace: workspacePath,
          key: request.key,
          error: message,
        });
        return { success: false, error: message };
      }
    },
  };

  pluginServer.onApiCall(handlers);
  logger.info("Plugin API handlers registered");
}
