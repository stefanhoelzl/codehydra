/**
 * PluginServerModule - Manages PluginServer lifecycle and API handler registration.
 *
 * Owns all PluginServer concerns:
 * - Starting/stopping the server
 * - Registering plugin API handlers that dispatch intents
 * - Pushing per-workspace config on open/delete
 *
 * Decoupled from code-server via onPortReady callback.
 */

import type { IntentModule } from "../intents/infrastructure/module";
import type { HookContext } from "../intents/infrastructure/operation";
import type { PluginServer, ApiCallHandlers } from "../../services/plugin-server/plugin-server";
import type { Dispatcher } from "../intents/infrastructure/dispatcher";
import type { Logger } from "../../services/logging/types";
import type { Workspace } from "../../shared/api/types";
import type {
  SetMetadataRequest,
  DeleteWorkspaceRequest,
  ExecuteCommandRequest,
  WorkspaceCreateRequest,
  PluginResult,
} from "../../shared/plugin-protocol";
import type { FinalizeHookInput, OpenWorkspaceIntent } from "../operations/open-workspace";
import type { DeleteWorkspaceIntent } from "../operations/delete-workspace";
import type { DeleteHookResult, DeletePipelineHookInput } from "../operations/delete-workspace";
import type { GetWorkspaceStatusIntent } from "../operations/get-workspace-status";
import type { GetAgentSessionIntent } from "../operations/get-agent-session";
import type { RestartAgentIntent } from "../operations/restart-agent";
import type { GetMetadataIntent } from "../operations/get-metadata";
import type { SetMetadataIntent } from "../operations/set-metadata";
import type { ResolveWorkspaceIntent } from "../operations/resolve-workspace";
import { APP_START_OPERATION_ID } from "../operations/app-start";
import { APP_SHUTDOWN_OPERATION_ID } from "../operations/app-shutdown";
import { OPEN_WORKSPACE_OPERATION_ID, INTENT_OPEN_WORKSPACE } from "../operations/open-workspace";
import {
  DELETE_WORKSPACE_OPERATION_ID,
  INTENT_DELETE_WORKSPACE,
} from "../operations/delete-workspace";
import { INTENT_GET_WORKSPACE_STATUS } from "../operations/get-workspace-status";
import { INTENT_GET_AGENT_SESSION } from "../operations/get-agent-session";
import { INTENT_RESTART_AGENT } from "../operations/restart-agent";
import { INTENT_GET_METADATA } from "../operations/get-metadata";
import { INTENT_SET_METADATA } from "../operations/set-metadata";
import { INTENT_RESOLVE_WORKSPACE } from "../operations/resolve-workspace";
import { getErrorMessage } from "../../services/errors";

// =============================================================================
// Dependency Interfaces
// =============================================================================

export interface PluginServerModuleDeps {
  readonly pluginServer: Pick<
    PluginServer,
    "start" | "close" | "setWorkspaceConfig" | "removeWorkspaceConfig" | "onApiCall" | "sendCommand"
  > | null;
  readonly dispatcher: Dispatcher;
  readonly logger: Logger;
  readonly onPortReady?: (port: number) => void;
}

// =============================================================================
// Factory
// =============================================================================

export function createPluginServerModule(deps: PluginServerModuleDeps): IntentModule {
  const { pluginServer, dispatcher, logger } = deps;

  return {
    name: "plugin-server",
    hooks: {
      [APP_START_OPERATION_ID]: {
        start: {
          handler: async (): Promise<void> => {
            if (!pluginServer) return;

            try {
              const port = await pluginServer.start();

              if (deps.onPortReady) {
                deps.onPortReady(port);
              }

              pluginServer.onApiCall(createPluginApiHandlers(pluginServer, dispatcher, logger));
              logger.info("Plugin API handlers registered");
            } catch (error) {
              const message = error instanceof Error ? error.message : "Unknown error";
              logger.warn("PluginServer start failed", { error: message });
            }
          },
        },
      },

      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async () => {
            if (pluginServer) {
              await pluginServer.close();
            }
          },
        },
      },

      [OPEN_WORKSPACE_OPERATION_ID]: {
        finalize: {
          handler: async (ctx: HookContext): Promise<void> => {
            const finalizeCtx = ctx as FinalizeHookInput;

            if (pluginServer && finalizeCtx.agentType) {
              const intent = ctx.intent as OpenWorkspaceIntent;
              const resetWorkspace = intent.payload.existingWorkspace === undefined;
              pluginServer.setWorkspaceConfig(
                finalizeCtx.workspacePath,
                finalizeCtx.envVars,
                finalizeCtx.agentType,
                resetWorkspace
              );
            }
          },
        },
      },

      [DELETE_WORKSPACE_OPERATION_ID]: {
        delete: {
          handler: async (ctx: HookContext): Promise<DeleteHookResult> => {
            const { workspacePath: wsPath } = ctx as DeletePipelineHookInput;
            const { payload } = ctx.intent as DeleteWorkspaceIntent;

            try {
              if (pluginServer) {
                pluginServer.removeWorkspaceConfig(wsPath);
              }
            } catch (error) {
              if (!payload.force) throw error;
              logger.warn("PluginServerModule: error in force mode (ignored)", {
                error: getErrorMessage(error),
              });
            }

            return {};
          },
        },
      },
    },
  };
}

// =============================================================================
// Plugin API Handlers
// =============================================================================

/**
 * Wrap a dispatcher call with error handling, returning a PluginResult.
 */
async function handlePluginApiCall<T>(
  workspacePath: string,
  operation: string,
  fn: () => Promise<T>,
  logger: Logger,
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

/**
 * Create plugin API handlers that dispatch intents directly.
 */
function createPluginApiHandlers(
  pluginServer: Pick<PluginServer, "sendCommand">,
  dispatcher: Dispatcher,
  logger: Logger
): ApiCallHandlers {
  return {
    async getStatus(workspacePath: string) {
      return handlePluginApiCall(
        workspacePath,
        "getStatus",
        async () => {
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
        logger
      );
    },

    async getAgentSession(workspacePath: string) {
      return handlePluginApiCall(
        workspacePath,
        "getAgentSession",
        async () => {
          const intent: GetAgentSessionIntent = {
            type: INTENT_GET_AGENT_SESSION,
            payload: { workspacePath },
          };
          return dispatcher.dispatch(intent);
        },
        logger
      );
    },

    async restartAgentServer(workspacePath: string) {
      return handlePluginApiCall(
        workspacePath,
        "restartAgentServer",
        async () => {
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
        logger
      );
    },

    async getMetadata(workspacePath: string) {
      return handlePluginApiCall(
        workspacePath,
        "getMetadata",
        async () => {
          const intent: GetMetadataIntent = {
            type: INTENT_GET_METADATA,
            payload: { workspacePath },
          };
          const result = await dispatcher.dispatch(intent);
          if (!result) {
            throw new Error("Get metadata dispatch returned no result");
          }
          return result as Record<string, string>;
        },
        logger
      );
    },

    async setMetadata(workspacePath: string, request: SetMetadataRequest) {
      return handlePluginApiCall(
        workspacePath,
        "setMetadata",
        async () => {
          const intent: SetMetadataIntent = {
            type: INTENT_SET_METADATA,
            payload: {
              workspacePath,
              key: request.key,
              value: request.value,
            },
          };
          await dispatcher.dispatch(intent);
          return undefined;
        },
        logger,
        { key: request.key }
      );
    },

    async delete(workspacePath: string, request: DeleteWorkspaceRequest) {
      return handlePluginApiCall(
        workspacePath,
        "delete",
        async () => {
          const intent: DeleteWorkspaceIntent = {
            type: INTENT_DELETE_WORKSPACE,
            payload: {
              workspacePath,
              keepBranch: request.keepBranch ?? true,
              force: false,
              removeWorktree: true,
            },
          };
          const handle = dispatcher.dispatch(intent);
          if (!(await handle.accepted)) {
            return { started: false };
          }
          void handle;
          return { started: true };
        },
        logger,
        { keepBranch: request.keepBranch ?? true }
      );
    },

    async executeCommand(workspacePath: string, request: ExecuteCommandRequest) {
      return handlePluginApiCall(
        workspacePath,
        "executeCommand",
        async () => {
          const result = await pluginServer.sendCommand(
            workspacePath,
            request.command,
            request.args
          );
          if (!result.success) {
            throw new Error(result.error);
          }
          return result.data;
        },
        logger,
        { command: request.command }
      );
    },

    async create(workspacePath: string, request: WorkspaceCreateRequest) {
      return handlePluginApiCall(
        workspacePath,
        "create",
        async () => {
          // Resolve workspacePath → projectPath before dispatching workspace:open
          const resolved = await dispatcher.dispatch({
            type: INTENT_RESOLVE_WORKSPACE,
            payload: { workspacePath },
          } as ResolveWorkspaceIntent);

          const intent: OpenWorkspaceIntent = {
            type: INTENT_OPEN_WORKSPACE,
            payload: {
              projectPath: resolved.projectPath,
              workspaceName: request.name,
              base: request.base,
              ...(request.initialPrompt !== undefined && {
                initialPrompt: request.initialPrompt,
              }),
              ...(request.stealFocus !== undefined && {
                stealFocus: request.stealFocus,
              }),
            },
          };
          const result = await dispatcher.dispatch(intent);
          if (!result) {
            throw new Error("Create workspace dispatch returned no result");
          }
          return result as Workspace;
        },
        logger,
        { name: request.name }
      );
    },
  };
}
