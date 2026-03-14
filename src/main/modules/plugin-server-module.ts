/**
 * PluginServerModule - Socket.IO server for VS Code extension communication.
 *
 * Closure-based module that manages the full plugin server lifecycle:
 * - Socket.IO server start/stop
 * - Client connection handling and authentication
 * - Per-workspace config management
 * - Plugin API event handlers that dispatch intents
 * - VS Code UI event proxying (notifications, status bar, quick pick, input box)
 * - VS Code command execution
 *
 * Provides `pluginPort` capability for code-server-module.
 */

import { Server, type Socket } from "socket.io";
import { createServer, type Server as HttpServer } from "node:http";

import type { IntentModule } from "../intents/infrastructure/module";
import type { HookContext } from "../intents/infrastructure/operation";
import type { Dispatcher } from "../intents/infrastructure/dispatcher";
import type { Logger } from "../../services/logging/types";
import { SILENT_LOGGER, logAtLevel } from "../../services/logging";
import { LogLevel } from "../../services/logging/types";
import type { PortManager } from "../../services/platform/network";
import type { Workspace } from "../../shared/api/types";
import type {
  ServerToClientEvents,
  ClientToServerEvents,
  SocketData,
  CommandRequest,
  PluginResult,
  PluginConfig,
  AgentType,
  SetMetadataRequest,
  DeleteWorkspaceRequest,
  DeleteWorkspaceResponse,
  ExecuteCommandRequest,
  WorkspaceCreateRequest,
  LogContext,
  ShowNotificationRequest,
  ShowNotificationResponse,
  StatusBarUpdateRequest,
  StatusBarDisposeRequest,
  ShowQuickPickRequest,
  ShowQuickPickResponse,
  ShowInputBoxRequest,
  ShowInputBoxResponse,
} from "../../shared/plugin-protocol";
import {
  COMMAND_TIMEOUT_MS,
  validateSetMetadataRequest,
  validateDeleteWorkspaceRequest,
  validateExecuteCommandRequest,
  validateWorkspaceCreateRequest,
  validateLogRequest,
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
import { Path } from "../../services/platform/path";

// =============================================================================
// Types
// =============================================================================

/** Socket.IO Server type with typed events. */
type TypedServer = Server<ClientToServerEvents, ServerToClientEvents, object, SocketData>;

/** Socket.IO Socket type with typed events. */
type TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents, object, SocketData>;

// =============================================================================
// Constants
// =============================================================================

/** Fixed status bar item ID -- single entry per workspace. */
const STATUS_BAR_ID = "mcp";

// =============================================================================
// Dependency Interfaces
// =============================================================================

export interface PluginServerModuleDeps {
  readonly portManager: Pick<PortManager, "findFreePort">;
  readonly dispatcher: Dispatcher;
  readonly logger: Logger;
  readonly options?: PluginServerOptions;
}

export interface PluginServerOptions {
  /** Socket.IO transports to use. Default: ["websocket"] */
  readonly transports?: readonly ("polling" | "websocket")[];
  /** Whether the app is running in development mode. Default: false */
  readonly isDevelopment?: boolean;
  /** Logger for extension-side logs. Default: SILENT_LOGGER */
  readonly extensionLogger?: Logger;
}

// =============================================================================
// Factory
// =============================================================================

export function createPluginServerModule(deps: PluginServerModuleDeps): IntentModule {
  const { portManager, dispatcher, logger } = deps;
  const transports: readonly ("polling" | "websocket")[] = deps.options?.transports ?? [
    "websocket",
  ];
  const isDevelopment = deps.options?.isDevelopment ?? false;
  const extensionLogger: Logger = deps.options?.extensionLogger ?? SILENT_LOGGER;

  // ---------------------------------------------------------------------------
  // Closure state (replaces PluginServer class fields)
  // ---------------------------------------------------------------------------

  let httpServer: HttpServer | null = null;
  let io: TypedServer | null = null;
  let port: number | null = null;
  const connections = new Map<string, TypedSocket>();
  const workspaceConfigs = new Map<
    string,
    { env: Record<string, string>; agentType: AgentType; resetWorkspace: boolean }
  >();

  /** Capability: pluginPort provided by start handler. */
  let capPluginPort: number | null = null;

  // ---------------------------------------------------------------------------
  // Server lifecycle functions
  // ---------------------------------------------------------------------------

  async function start(): Promise<number> {
    if (io) {
      return port!;
    }

    const assignedPort = await portManager.findFreePort();

    httpServer = createServer();
    io = new Server(httpServer, {
      transports: [...transports],
      cors: { origin: false },
    });

    setupEventHandlers();

    await new Promise<void>((resolve, reject) => {
      httpServer!.listen(assignedPort, "127.0.0.1", () => {
        port = assignedPort;
        logger.info("Started", { port: assignedPort });
        resolve();
      });
      httpServer!.on("error", reject);
    });

    return assignedPort;
  }

  async function close(): Promise<void> {
    if (!io) {
      return;
    }

    logger.info("Closing");

    for (const socket of connections.values()) {
      socket.disconnect(true);
    }
    connections.clear();
    workspaceConfigs.clear();

    await new Promise<void>((resolve) => {
      io!.close(() => {
        resolve();
      });
    });

    httpServer!.closeAllConnections();
    await new Promise<void>((resolve) => {
      httpServer!.close(() => {
        resolve();
      });
    });

    io = null;
    httpServer = null;
    port = null;

    logger.info("Closed");
  }

  // ---------------------------------------------------------------------------
  // Command sending
  // ---------------------------------------------------------------------------

  async function sendCommand(
    workspacePath: string,
    command: string,
    args?: readonly unknown[],
    timeoutMs: number = COMMAND_TIMEOUT_MS
  ): Promise<PluginResult<unknown>> {
    const normalized = new Path(workspacePath).toString();
    const socket = connections.get(normalized);

    if (!socket) {
      return { success: false, error: "Workspace not connected" };
    }

    if (!socket.connected) {
      connections.delete(normalized);
      return { success: false, error: "Workspace disconnected" };
    }

    const request: CommandRequest = args !== undefined ? { command, args } : { command };

    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        logger.warn("Command timeout", { workspace: normalized, command, timeoutMs });
        resolve({ success: false, error: "Command timed out" });
      }, timeoutMs);

      socket.emit("command", request, (result: PluginResult<unknown>) => {
        clearTimeout(timeoutId);
        logger.debug("Command result", {
          workspace: normalized,
          command,
          success: result.success,
        });
        resolve(result);
      });
    });
  }

  // ---------------------------------------------------------------------------
  // UI event sending
  // ---------------------------------------------------------------------------

  async function sendUiEvent<TReq, TRes>(
    workspacePath: string,
    event: keyof ServerToClientEvents,
    request: TReq,
    timeoutMs: number = COMMAND_TIMEOUT_MS
  ): Promise<PluginResult<TRes>> {
    const normalized = new Path(workspacePath).toString();
    const socket = connections.get(normalized);

    if (!socket) {
      return { success: false, error: "Workspace not connected" };
    }

    if (!socket.connected) {
      connections.delete(normalized);
      return { success: false, error: "Workspace disconnected" };
    }

    return new Promise((resolve) => {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      if (timeoutMs > 0) {
        timeoutId = setTimeout(() => {
          logger.warn("UI event timeout", { workspace: normalized, event, timeoutMs });
          resolve({ success: false, error: "UI event timed out" });
        }, timeoutMs);
      }

      // @ts-expect-error Dynamic event name - TypedSocket strict typing cannot accommodate generic event dispatch
      socket.emit(event, request, (result: PluginResult<TRes>) => {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        logger.debug("UI event result", {
          workspace: normalized,
          event,
          success: result.success,
        });
        resolve(result);
      });
    });
  }

  async function showNotification(
    workspacePath: string,
    request: ShowNotificationRequest,
    timeoutMs: number = COMMAND_TIMEOUT_MS
  ): Promise<PluginResult<ShowNotificationResponse>> {
    return sendUiEvent(workspacePath, "ui:showNotification", request, timeoutMs);
  }

  async function updateStatusBar(
    workspacePath: string,
    request: StatusBarUpdateRequest
  ): Promise<PluginResult<void>> {
    return sendUiEvent(workspacePath, "ui:statusBarUpdate", request);
  }

  async function disposeStatusBar(
    workspacePath: string,
    request: StatusBarDisposeRequest
  ): Promise<PluginResult<void>> {
    return sendUiEvent(workspacePath, "ui:statusBarDispose", request);
  }

  async function showQuickPick(
    workspacePath: string,
    request: ShowQuickPickRequest,
    timeoutMs: number = 0
  ): Promise<PluginResult<ShowQuickPickResponse>> {
    return sendUiEvent(workspacePath, "ui:showQuickPick", request, timeoutMs);
  }

  async function showInputBox(
    workspacePath: string,
    request: ShowInputBoxRequest,
    timeoutMs: number = 0
  ): Promise<PluginResult<ShowInputBoxResponse>> {
    return sendUiEvent(workspacePath, "ui:showInputBox", request, timeoutMs);
  }

  // ---------------------------------------------------------------------------
  // Workspace config management
  // ---------------------------------------------------------------------------

  function setWorkspaceConfig(
    workspacePath: string,
    env: Record<string, string>,
    agentType: AgentType,
    resetWorkspace: boolean
  ): void {
    const normalized = new Path(workspacePath).toString();
    workspaceConfigs.set(normalized, { env, agentType, resetWorkspace });
  }

  function removeWorkspaceConfig(workspacePath: string): void {
    const normalized = new Path(workspacePath).toString();
    workspaceConfigs.delete(normalized);
  }

  // ---------------------------------------------------------------------------
  // Auth validation
  // ---------------------------------------------------------------------------

  function isValidAuth(auth: unknown): auth is { workspacePath: string } {
    return (
      typeof auth === "object" &&
      auth !== null &&
      "workspacePath" in auth &&
      typeof (auth as { workspacePath: unknown }).workspacePath === "string" &&
      (auth as { workspacePath: string }).workspacePath.length > 0
    );
  }

  // ---------------------------------------------------------------------------
  // Socket.IO event handlers
  // ---------------------------------------------------------------------------

  function setupEventHandlers(): void {
    io!.on("connection", (socket: TypedSocket) => {
      const auth = socket.handshake.auth as unknown;

      if (!isValidAuth(auth)) {
        logger.warn("Connection rejected: invalid auth", {
          socketId: socket.id,
        });
        socket.disconnect(true);
        return;
      }

      let workspacePath: string;
      try {
        workspacePath = new Path(auth.workspacePath).toString();
      } catch {
        logger.warn("Connection rejected: invalid path", {
          socketId: socket.id,
          path: auth.workspacePath,
        });
        socket.disconnect(true);
        return;
      }

      socket.data.workspacePath = workspacePath;

      const existingSocket = connections.get(workspacePath);
      if (existingSocket) {
        logger.info("Disconnecting duplicate connection", {
          workspace: workspacePath,
          oldSocketId: existingSocket.id,
          newSocketId: socket.id,
        });
        existingSocket.disconnect(true);
      }

      connections.set(workspacePath, socket);
      logger.info("Client connected", {
        workspace: workspacePath,
        socketId: socket.id,
      });

      const storedConfig = workspaceConfigs.get(workspacePath);
      const env: Record<string, string> | null = storedConfig?.env ?? null;
      const agentTypeValue: AgentType | null = storedConfig?.agentType ?? null;
      const resetWorkspace: boolean = storedConfig?.resetWorkspace ?? true;

      const config: PluginConfig = {
        isDevelopment,
        env,
        agentType: agentTypeValue,
        resetWorkspace,
      };
      socket.emit("config", config);
      logger.debug("Config sent", {
        workspace: workspacePath,
        isDevelopment,
        hasEnv: env !== null,
        agentType: agentTypeValue,
      });

      socket.on("disconnect", (reason) => {
        const currentSocket = connections.get(workspacePath);
        if (currentSocket === socket) {
          connections.delete(workspacePath);
          logger.info("Client disconnected", {
            workspace: workspacePath,
            reason,
          });
        }
      });

      setupApiHandlers(socket, workspacePath);
    });
  }

  // ---------------------------------------------------------------------------
  // API event handler helpers
  // ---------------------------------------------------------------------------

  /**
   * Wrap a dispatcher call with error handling, returning a PluginResult.
   */
  async function handlePluginApiCall<T>(
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

  /**
   * Create a handler for no-argument API calls that dispatch intents directly.
   */
  function createNoArgHandler<R>(
    eventName: string,
    workspacePath: string,
    dispatchFn: () => Promise<R>
  ): (ack: (result: PluginResult<R>) => void) => void {
    return (ack) => {
      logger.debug("API call", { event: eventName, workspace: workspacePath });

      handlePluginApiCall(workspacePath, eventName, dispatchFn)
        .then((result) => ack(result))
        .catch((error) => {
          const message = getErrorMessage(error);
          logger.error("API handler error", {
            event: eventName,
            workspace: workspacePath,
            error: message,
          });
          ack({ success: false, error: message });
        });
    };
  }

  /**
   * Create a handler for validated API calls with request payload.
   */
  function createValidatedHandler<TReq, TValidated, R>(
    eventName: string,
    workspacePath: string,
    validator: (
      payload: unknown
    ) => { valid: true; request?: TValidated } | { valid: false; error: string },
    dispatchFn: (request: TValidated) => Promise<PluginResult<R>>,
    logContext?: (request: TReq) => Record<string, unknown>
  ): (request: TReq, ack: (result: PluginResult<R>) => void) => void {
    return (request, ack) => {
      const validation = validator(request);
      if (!validation.valid) {
        logger.warn("API call validation failed", {
          event: eventName,
          workspace: workspacePath,
          error: validation.error,
        });
        ack({ success: false, error: validation.error });
        return;
      }

      const validatedRequest = validation.request ?? (request as unknown as TValidated);
      logger.debug("API call", {
        event: eventName,
        workspace: workspacePath,
        ...logContext?.(request),
      });

      dispatchFn(validatedRequest)
        .then((result) => ack(result))
        .catch((error) => {
          const message = getErrorMessage(error);
          logger.error("API handler error", {
            event: eventName,
            workspace: workspacePath,
            error: message,
          });
          ack({ success: false, error: message });
        });
    };
  }

  // ---------------------------------------------------------------------------
  // API event handlers (dispatch intents directly)
  // ---------------------------------------------------------------------------

  function setupApiHandlers(socket: TypedSocket, workspacePath: string): void {
    // No-arg handlers
    socket.on(
      "api:workspace:getStatus",
      createNoArgHandler("api:workspace:getStatus", workspacePath, async () => {
        const intent: GetWorkspaceStatusIntent = {
          type: INTENT_GET_WORKSPACE_STATUS,
          payload: { workspacePath },
        };
        const result = await dispatcher.dispatch(intent);
        if (!result) {
          throw new Error("Get workspace status dispatch returned no result");
        }
        return result;
      })
    );

    socket.on(
      "api:workspace:getAgentSession",
      createNoArgHandler("api:workspace:getAgentSession", workspacePath, async () => {
        const intent: GetAgentSessionIntent = {
          type: INTENT_GET_AGENT_SESSION,
          payload: { workspacePath },
        };
        return dispatcher.dispatch(intent);
      })
    );

    socket.on(
      "api:workspace:restartAgentServer",
      createNoArgHandler("api:workspace:restartAgentServer", workspacePath, async () => {
        const intent: RestartAgentIntent = {
          type: INTENT_RESTART_AGENT,
          payload: { workspacePath },
        };
        const result = await dispatcher.dispatch(intent);
        if (result === undefined) {
          throw new Error("Restart agent dispatch returned no result");
        }
        return result;
      })
    );

    socket.on(
      "api:workspace:getMetadata",
      createNoArgHandler("api:workspace:getMetadata", workspacePath, async () => {
        const intent: GetMetadataIntent = {
          type: INTENT_GET_METADATA,
          payload: { workspacePath },
        };
        const result = await dispatcher.dispatch(intent);
        if (!result) {
          throw new Error("Get metadata dispatch returned no result");
        }
        return result as Record<string, string>;
      })
    );

    // Validated handlers
    socket.on(
      "api:workspace:setMetadata",
      createValidatedHandler<SetMetadataRequest, SetMetadataRequest, void>(
        "api:workspace:setMetadata",
        workspacePath,
        validateSetMetadataRequest,
        (req) =>
          handlePluginApiCall(workspacePath, "setMetadata", async () => {
            const intent: SetMetadataIntent = {
              type: INTENT_SET_METADATA,
              payload: {
                workspacePath,
                key: req.key,
                value: req.value,
              },
            };
            await dispatcher.dispatch(intent);
            return undefined;
          }),
        (req) => ({ key: req.key })
      )
    );

    socket.on(
      "api:workspace:delete",
      createValidatedHandler<
        DeleteWorkspaceRequest | undefined,
        DeleteWorkspaceRequest,
        DeleteWorkspaceResponse
      >(
        "api:workspace:delete",
        workspacePath,
        validateDeleteWorkspaceRequest,
        (req) =>
          handlePluginApiCall(workspacePath, "delete", async () => {
            const intent: DeleteWorkspaceIntent = {
              type: INTENT_DELETE_WORKSPACE,
              payload: {
                workspacePath,
                keepBranch: req.keepBranch ?? true,
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
          }),
        (req) => ({ keepBranch: !!req?.keepBranch })
      )
    );

    socket.on(
      "api:workspace:executeCommand",
      createValidatedHandler<ExecuteCommandRequest, ExecuteCommandRequest, unknown>(
        "api:workspace:executeCommand",
        workspacePath,
        validateExecuteCommandRequest,
        (req) =>
          handlePluginApiCall(workspacePath, "executeCommand", async () => {
            const intent: VscodeCommandIntent = {
              type: INTENT_VSCODE_COMMAND,
              payload: {
                workspacePath,
                command: req.command,
                args: req.args,
              },
            };
            return dispatcher.dispatch(intent);
          }),
        (req) => ({ command: req.command })
      )
    );

    socket.on(
      "api:workspace:create",
      createValidatedHandler<WorkspaceCreateRequest, WorkspaceCreateRequest, Workspace>(
        "api:workspace:create",
        workspacePath,
        validateWorkspaceCreateRequest,
        (req) =>
          handlePluginApiCall(workspacePath, "create", async () => {
            const resolved = await dispatcher.dispatch({
              type: INTENT_RESOLVE_WORKSPACE,
              payload: { workspacePath },
            } as ResolveWorkspaceIntent);

            const intent: OpenWorkspaceIntent = {
              type: INTENT_OPEN_WORKSPACE,
              payload: {
                projectPath: resolved.projectPath,
                workspaceName: req.name,
                base: req.base,
                ...(req.initialPrompt !== undefined && {
                  initialPrompt: req.initialPrompt,
                }),
                ...(req.stealFocus !== undefined && {
                  stealFocus: req.stealFocus,
                }),
              },
            };
            const result = await dispatcher.dispatch(intent);
            if (!result) {
              throw new Error("Create workspace dispatch returned no result");
            }
            return result as Workspace;
          }),
        (req) => ({ name: req.name, base: req.base })
      )
    );

    // Handle api:log (fire-and-forget - special case)
    socket.on("api:log", (request) => {
      const validation = validateLogRequest(request);
      if (!validation.valid) return;

      const context: LogContext = {
        ...(request.context ?? {}),
        workspace: workspacePath,
      };

      const level = request.level as LogLevel;
      logAtLevel(extensionLogger, level, request.message, context);
    });
  }

  // ---------------------------------------------------------------------------
  // Show message handler
  // ---------------------------------------------------------------------------

  async function handleShowMessage(
    workspacePath: string,
    type: string,
    message: string | null,
    hint: string | undefined,
    options: readonly string[] | undefined,
    timeoutMs: number | undefined
  ): Promise<string | null> {
    if (type === "status") {
      if (message === null) {
        const result = await disposeStatusBar(workspacePath, { id: STATUS_BAR_ID });
        if (!result.success) throw new Error(result.error);
        return null;
      }
      const result = await updateStatusBar(workspacePath, {
        id: STATUS_BAR_ID,
        text: message,
        ...(hint !== undefined && { tooltip: hint }),
      });
      if (!result.success) throw new Error(result.error);
      return null;
    }

    if (type === "info" || type === "warning" || type === "error") {
      const result = await showNotification(
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
        const result = await showQuickPick(
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
      const result = await showInputBox(
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

  // ---------------------------------------------------------------------------
  // Module definition
  // ---------------------------------------------------------------------------

  return {
    name: "plugin-server",
    hooks: {
      [APP_START_OPERATION_ID]: {
        start: {
          provides: () => ({ pluginPort: capPluginPort }),
          handler: async (): Promise<void> => {
            capPluginPort = null;

            try {
              capPluginPort = await start();
              logger.info("Plugin server started", { port: capPluginPort });
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
            await close();
          },
        },
      },

      [OPEN_WORKSPACE_OPERATION_ID]: {
        finalize: {
          handler: async (ctx: HookContext): Promise<void> => {
            const finalizeCtx = ctx as FinalizeHookInput;

            if (io && finalizeCtx.agentType) {
              const intent = ctx.intent as OpenWorkspaceIntent;
              const resetWs = intent.payload.existingWorkspace === undefined;
              setWorkspaceConfig(
                finalizeCtx.workspacePath,
                finalizeCtx.envVars,
                finalizeCtx.agentType,
                resetWs
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
              if (io) {
                removeWorkspaceConfig(wsPath);
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
            if (!io) {
              throw new Error("Plugin server not available");
            }

            const { workspacePath } = ctx as ShowHookInput;
            const intent = ctx.intent as VscodeShowMessageIntent;
            const { type, message, hint, options: msgOptions, timeoutMs } = intent.payload;

            return {
              result: await handleShowMessage(
                workspacePath,
                type,
                message,
                hint,
                msgOptions,
                timeoutMs
              ),
            };
          },
        },
      },

      [VSCODE_COMMAND_OPERATION_ID]: {
        execute: {
          handler: async (ctx: HookContext): Promise<ExecuteHookResult> => {
            if (!io) {
              throw new Error("Plugin server not available");
            }

            const { workspacePath } = ctx as ExecuteHookInput;
            const intent = ctx.intent as VscodeCommandIntent;
            const { command, args } = intent.payload;

            const commandResult = await sendCommand(workspacePath, command, args);
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
