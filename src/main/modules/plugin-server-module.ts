/**
 * PluginServerModule - Manages PluginServer lifecycle and API handler registration.
 *
 * Owns all PluginServer concerns:
 * - Starting/stopping the server
 * - Registering plugin API handlers that dispatch intents
 * - Pushing per-workspace config on open/delete
 * - Handling vscode:show-message and vscode:command intents
 *
 * Provides `pluginPort` capability for code-server-module.
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
import type { VscodeShowMessageIntent } from "../operations/vscode-show-message";
import type { ShowHookInput, ShowHookResult } from "../operations/vscode-show-message";
import type { VscodeCommandIntent } from "../operations/vscode-command";
import type { ExecuteHookInput, ExecuteHookResult } from "../operations/vscode-command";
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
import { VSCODE_SHOW_MESSAGE_OPERATION_ID } from "../operations/vscode-show-message";
import { VSCODE_COMMAND_OPERATION_ID } from "../operations/vscode-command";
import { INTENT_VSCODE_COMMAND } from "../operations/vscode-command";
import { getErrorMessage } from "../../services/errors";

// =============================================================================
// Constants
// =============================================================================

/** Fixed status bar item ID — single entry per workspace. */
const STATUS_BAR_ID = "mcp";

// =============================================================================
// Dependency Interfaces
// =============================================================================

export interface PluginServerModuleDeps {
  readonly pluginServer: Pick<
    PluginServer,
    | "start"
    | "close"
    | "setWorkspaceConfig"
    | "removeWorkspaceConfig"
    | "onApiCall"
    | "sendCommand"
    | "showNotification"
    | "updateStatusBar"
    | "disposeStatusBar"
    | "showQuickPick"
    | "showInputBox"
  > | null;
  readonly dispatcher: Dispatcher;
  readonly logger: Logger;
}

// =============================================================================
// Factory
// =============================================================================

export function createPluginServerModule(deps: PluginServerModuleDeps): IntentModule {
  const { pluginServer, dispatcher, logger } = deps;

  /** Capability: pluginPort provided by start handler. */
  let capPluginPort: number | null = null;

  return {
    name: "plugin-server",
    hooks: {
      [APP_START_OPERATION_ID]: {
        start: {
          provides: () => ({ pluginPort: capPluginPort }),
          handler: async (): Promise<void> => {
            capPluginPort = null;
            if (!pluginServer) return;

            try {
              capPluginPort = await pluginServer.start();

              pluginServer.onApiCall(createPluginApiHandlers(dispatcher, logger));
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

      [VSCODE_SHOW_MESSAGE_OPERATION_ID]: {
        show: {
          handler: async (ctx: HookContext): Promise<ShowHookResult> => {
            if (!pluginServer) {
              throw new Error("Plugin server not available");
            }

            const { workspacePath } = ctx as ShowHookInput;
            const intent = ctx.intent as VscodeShowMessageIntent;
            const { type, message, hint, options, timeoutMs } = intent.payload;

            return {
              result: await handleShowMessage(
                pluginServer,
                workspacePath,
                type,
                message,
                hint,
                options,
                timeoutMs
              ),
            };
          },
        },
      },

      [VSCODE_COMMAND_OPERATION_ID]: {
        execute: {
          handler: async (ctx: HookContext): Promise<ExecuteHookResult> => {
            if (!pluginServer) {
              throw new Error("Plugin server not available");
            }

            const { workspacePath } = ctx as ExecuteHookInput;
            const intent = ctx.intent as VscodeCommandIntent;
            const { command, args } = intent.payload;

            const commandResult = await pluginServer.sendCommand(workspacePath, command, args);
            if (!commandResult.success) {
              throw new Error(commandResult.error);
            }

            return { result: commandResult.data };
          },
        },
      },
    },
  };
}

// =============================================================================
// Show Message Handler
// =============================================================================

type PluginServerUi = Pick<
  PluginServer,
  "showNotification" | "updateStatusBar" | "disposeStatusBar" | "showQuickPick" | "showInputBox"
>;

async function handleShowMessage(
  ps: PluginServerUi,
  workspacePath: string,
  type: string,
  message: string | null,
  hint: string | undefined,
  options: readonly string[] | undefined,
  timeoutMs: number | undefined
): Promise<string | null> {
  if (type === "status") {
    if (message === null) {
      const result = await ps.disposeStatusBar(workspacePath, { id: STATUS_BAR_ID });
      if (!result.success) throw new Error(result.error);
      return null;
    }
    const result = await ps.updateStatusBar(workspacePath, {
      id: STATUS_BAR_ID,
      text: message,
      ...(hint !== undefined && { tooltip: hint }),
    });
    if (!result.success) throw new Error(result.error);
    return null;
  }

  if (type === "info" || type === "warning" || type === "error") {
    const result = await ps.showNotification(
      workspacePath,
      {
        severity: type,
        message: message!,
        ...(options !== undefined && { actions: [...options] }),
      },
      timeoutMs
    );
    if (!result.success) throw new Error(result.error);
    return result.data.action;
  }

  if (type === "select") {
    if (options !== undefined) {
      const result = await ps.showQuickPick(
        workspacePath,
        {
          items: options.map((label) => ({ label })),
          ...(hint !== undefined && { placeholder: hint }),
        },
        timeoutMs
      );
      if (!result.success) throw new Error(result.error);
      return result.data.selected;
    }

    // No options = free text input
    const result = await ps.showInputBox(
      workspacePath,
      {
        ...(message !== null && { prompt: message }),
        ...(hint !== undefined && { placeholder: hint }),
      },
      timeoutMs
    );
    if (!result.success) throw new Error(result.error);
    return result.data.value;
  }

  throw new Error(`Unknown show-message type: ${type}`);
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
function createPluginApiHandlers(dispatcher: Dispatcher, logger: Logger): ApiCallHandlers {
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
          const intent: VscodeCommandIntent = {
            type: INTENT_VSCODE_COMMAND,
            payload: {
              workspacePath,
              command: request.command,
              args: request.args,
            },
          };
          return dispatcher.dispatch(intent);
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
