/**
 * PluginServer - Socket.IO server for VS Code extension communication.
 *
 * Provides bidirectional communication between CodeHydra (server) and
 * VS Code extensions (clients) running in each workspace.
 *
 * Architecture:
 * - Server runs in Electron main process
 * - Each workspace connects via Socket.IO client in the codehydra extension
 * - Commands are sent from server to client with acknowledgment callbacks
 */

import { Server, type Socket } from "socket.io";
import { createServer, type Server as HttpServer } from "node:http";
import type { Logger } from "../logging";
import { SILENT_LOGGER, logAtLevel } from "../logging";
import type { PortManager } from "../platform/network";
import {
  type ServerToClientEvents,
  type ClientToServerEvents,
  type SocketData,
  type CommandRequest,
  type PluginResult,
  type SetMetadataRequest,
  type DeleteWorkspaceRequest,
  type DeleteWorkspaceResponse,
  type ExecuteCommandRequest,
  type WorkspaceCreateRequest,
  type PluginConfig,
  type LogContext,
  type AgentType,
  COMMAND_TIMEOUT_MS,
  SHUTDOWN_DISCONNECT_TIMEOUT_MS,
  validateSetMetadataRequest,
  validateDeleteWorkspaceRequest,
  validateExecuteCommandRequest,
  validateWorkspaceCreateRequest,
  validateLogRequest,
} from "../../shared/plugin-protocol";
import { LogLevel } from "../logging/types";
import type { WorkspaceStatus, Workspace, AgentSession } from "../../shared/api/types";
import { getErrorMessage } from "../errors";
import { Path } from "../platform/path";

// ============================================================================
// Types
// ============================================================================

/**
 * Socket.IO Server type with typed events.
 */
type TypedServer = Server<ClientToServerEvents, ServerToClientEvents, object, SocketData>;

/**
 * Socket.IO Socket type with typed events.
 */
type TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents, object, SocketData>;

// ============================================================================
// API Callback Types
// ============================================================================

/**
 * Callback handlers for workspace API calls.
 * Each handler receives the workspace path and returns a PluginResult.
 */
export interface ApiCallHandlers {
  /**
   * Handle getStatus request.
   * @param workspacePath - Normalized workspace path
   * @returns Status result or error
   */
  getStatus(workspacePath: string): Promise<PluginResult<WorkspaceStatus>>;

  /**
   * Handle getAgentSession request.
   * @param workspacePath - Normalized workspace path
   * @returns Session info (null if not running) or error
   */
  getAgentSession(workspacePath: string): Promise<PluginResult<AgentSession | null>>;

  /**
   * Handle restartAgentServer request.
   * @param workspacePath - Normalized workspace path
   * @returns Port number after restart or error
   */
  restartAgentServer(workspacePath: string): Promise<PluginResult<number>>;

  /**
   * Handle getMetadata request.
   * @param workspacePath - Normalized workspace path
   * @returns Metadata record or error
   */
  getMetadata(workspacePath: string): Promise<PluginResult<Record<string, string>>>;

  /**
   * Handle setMetadata request.
   * @param workspacePath - Normalized workspace path
   * @param request - The validated set metadata request
   * @returns Void result or error
   */
  setMetadata(workspacePath: string, request: SetMetadataRequest): Promise<PluginResult<void>>;

  /**
   * Handle delete request.
   * @param workspacePath - Normalized workspace path
   * @param request - The validated delete request (optional keepBranch)
   * @returns Deletion started confirmation or error
   */
  delete(
    workspacePath: string,
    request: DeleteWorkspaceRequest
  ): Promise<PluginResult<DeleteWorkspaceResponse>>;

  /**
   * Handle executeCommand request.
   * @param workspacePath - Normalized workspace path
   * @param request - The validated execute command request
   * @returns Command result or error
   */
  executeCommand(
    workspacePath: string,
    request: ExecuteCommandRequest
  ): Promise<PluginResult<unknown>>;

  /**
   * Handle create request.
   * @param workspacePath - Normalized workspace path (caller's workspace, used to determine project)
   * @param request - The validated create request
   * @returns Created workspace or error
   */
  create(workspacePath: string, request: WorkspaceCreateRequest): Promise<PluginResult<Workspace>>;
}

// ============================================================================
// PluginServer
// ============================================================================

/**
 * Socket.IO server for VS Code extension communication.
 *
 * Manages connections from VS Code extensions in each workspace
 * and provides command execution with acknowledgment support.
 *
 * @example
 * ```typescript
 * const server = new PluginServer(portManager, logger);
 * await server.start();
 *
 * // Send command to a workspace
 * const result = await server.sendCommand(
 *   '/path/to/workspace',
 *   'workbench.action.closeSidebar',
 *   []
 * );
 *
 * // Cleanup
 * await server.close();
 * ```
 */

/**
 * Configuration options for PluginServer.
 */
export interface PluginServerOptions {
  /** Socket.IO transports to use. Default: ["websocket"] */
  readonly transports?: readonly ("polling" | "websocket")[];
  /** Whether the app is running in development mode. Default: false */
  readonly isDevelopment?: boolean;
  /** Logger for extension-side logs. Default: SILENT_LOGGER */
  readonly extensionLogger?: Logger;
}

export class PluginServer {
  private readonly portManager: PortManager;
  private readonly logger: Logger;
  private readonly extensionLogger: Logger;
  private readonly transports: readonly ("polling" | "websocket")[];
  private readonly isDevelopment: boolean;
  private httpServer: HttpServer | null = null;
  private io: TypedServer | null = null;
  private port: number | null = null;

  /**
   * Map of normalized workspace paths to connected sockets.
   */
  private readonly connections = new Map<string, TypedSocket>();

  /**
   * Per-workspace config storage for env vars and agent type.
   * Populated by CodeServerModule during finalize, cleaned up during delete.
   */
  private readonly workspaceConfigs = new Map<
    string,
    { env: Record<string, string>; agentType: AgentType }
  >();

  /**
   * API call handlers registered via onApiCall().
   */
  private apiHandlers: ApiCallHandlers | null = null;

  /**
   * Create a new PluginServer instance.
   *
   * @param portManager - Port manager for finding free ports
   * @param logger - Optional logger (defaults to silent no-op logger)
   * @param options - Optional configuration options
   */
  constructor(portManager: PortManager, logger?: Logger, options?: PluginServerOptions) {
    this.portManager = portManager;
    this.logger = logger ?? SILENT_LOGGER;
    this.extensionLogger = options?.extensionLogger ?? SILENT_LOGGER;
    this.transports = options?.transports ?? ["websocket"];
    this.isDevelopment = !!options?.isDevelopment;
  }

  /**
   * Start the Socket.IO server on a dynamically allocated port.
   *
   * @returns The port the server is listening on
   * @throws Error if server fails to start
   */
  async start(): Promise<number> {
    if (this.io) {
      // Already started
      return this.port!;
    }

    const port = await this.portManager.findFreePort();

    this.httpServer = createServer();
    this.io = new Server(this.httpServer, {
      // Transports are configurable - websocket is default for production,
      // but tests may use polling due to vitest's module transformation issues
      transports: [...this.transports],
      // Disable CORS since we're local-only
      cors: {
        origin: false,
      },
    });

    this.setupEventHandlers();

    await new Promise<void>((resolve, reject) => {
      // Listen on 127.0.0.1 only for security (avoid IPv4/IPv6 resolution issues)
      this.httpServer!.listen(port, "127.0.0.1", () => {
        this.port = port;
        this.logger.info("Started", { port });
        resolve();
      });
      this.httpServer!.on("error", reject);
    });

    return port;
  }

  /**
   * Get the port the server is listening on.
   *
   * @returns Port number or null if not started
   */
  getPort(): number | null {
    return this.port;
  }

  /**
   * Check if a workspace is connected.
   *
   * @param workspacePath - Path to the workspace
   * @returns True if connected
   */
  isConnected(workspacePath: string): boolean {
    const normalized = new Path(workspacePath).toString();
    return this.connections.has(normalized);
  }

  /**
   * Send a command to a connected workspace.
   *
   * @param workspacePath - Path to the workspace
   * @param command - VS Code command identifier
   * @param args - Optional arguments to pass to the command
   * @param timeoutMs - Timeout for acknowledgment (default: COMMAND_TIMEOUT_MS)
   * @returns Result of the command execution
   */
  async sendCommand(
    workspacePath: string,
    command: string,
    args?: readonly unknown[],
    timeoutMs: number = COMMAND_TIMEOUT_MS
  ): Promise<PluginResult<unknown>> {
    const normalized = new Path(workspacePath).toString();
    const socket = this.connections.get(normalized);

    if (!socket) {
      return { success: false, error: "Workspace not connected" };
    }

    if (!socket.connected) {
      // Socket exists but is disconnected (shouldn't happen but handle gracefully)
      this.connections.delete(normalized);
      return { success: false, error: "Workspace disconnected" };
    }

    const request: CommandRequest = args !== undefined ? { command, args } : { command };

    return new Promise((resolve) => {
      // Set up timeout
      const timeoutId = setTimeout(() => {
        this.logger.warn("Command timeout", { workspace: normalized, command, timeoutMs });
        resolve({ success: false, error: "Command timed out" });
      }, timeoutMs);

      // Send command with acknowledgment callback
      socket.emit("command", request, (result: PluginResult<unknown>) => {
        clearTimeout(timeoutId);
        this.logger.debug("Command result", {
          workspace: normalized,
          command,
          success: result.success,
        });
        resolve(result);
      });
    });
  }

  /**
   * Store config data for a workspace.
   * Called by CodeServerModule during finalize to push env vars and agent type.
   *
   * @param workspacePath - Workspace path (will be normalized)
   * @param env - Environment variables for terminal integration
   * @param agentType - Agent type for terminal launching
   */
  setWorkspaceConfig(
    workspacePath: string,
    env: Record<string, string>,
    agentType: AgentType
  ): void {
    const normalized = new Path(workspacePath).toString();
    this.workspaceConfigs.set(normalized, { env, agentType });
  }

  /**
   * Remove stored config data for a workspace.
   * Called by CodeServerModule during delete to clean up.
   *
   * @param workspacePath - Workspace path (will be normalized)
   */
  removeWorkspaceConfig(workspacePath: string): void {
    const normalized = new Path(workspacePath).toString();
    this.workspaceConfigs.delete(normalized);
  }

  /**
   * Register handlers for workspace API calls from extensions.
   *
   * This method must be called before any clients connect to enable API handling.
   * Only one set of handlers can be registered; subsequent calls replace previous handlers.
   *
   * The PluginServer routes incoming API events to these handlers, passing the
   * workspace path from the socket connection. The handlers are responsible for
   * resolving workspace identifiers and delegating to the appropriate API layer.
   *
   * @param handlers - Object containing handler functions for each API method
   *
   * @example
   * ```typescript
   * server.onApiCall({
   *   async getStatus(workspacePath) {
   *     // Resolve workspace and return status
   *     return { success: true, data: { isDirty: false, agent: { type: 'none' } } };
   *   },
   *   async getMetadata(workspacePath) {
   *     return { success: true, data: { base: 'main', note: 'test' } };
   *   },
   *   async setMetadata(workspacePath, request) {
   *     // Update metadata in git config
   *     return { success: true, data: undefined };
   *   },
   * });
   * ```
   */
  onApiCall(handlers: ApiCallHandlers): void {
    this.apiHandlers = handlers;
  }

  /**
   * Send shutdown command and wait for extension host to disconnect.
   *
   * This is a best-effort operation for workspace deletion cleanup.
   * Waits for socket disconnect (not just ack) as confirmation that
   * the extension host process has terminated.
   *
   * @param workspacePath - Normalized workspace path
   * @param options - Optional configuration
   * @returns Promise that resolves when disconnected or timeout
   */
  async sendExtensionHostShutdown(
    workspacePath: string,
    options?: { timeoutMs?: number }
  ): Promise<void> {
    const timeoutMs = options?.timeoutMs ?? SHUTDOWN_DISCONNECT_TIMEOUT_MS;

    // Best-effort: handle invalid paths gracefully (empty, relative, etc.)
    let normalized: string;
    try {
      normalized = new Path(workspacePath).toString();
    } catch {
      this.logger.debug("Shutdown skipped: invalid workspace path", { path: workspacePath });
      return;
    }

    const socket = this.connections.get(normalized);

    if (!socket) {
      this.logger.debug("Shutdown skipped: workspace not connected", { workspace: normalized });
      return;
    }

    return new Promise<void>((resolve) => {
      let resolved = false;

      const cleanup = (): void => {
        if (!resolved) {
          resolved = true;
          socket.off("disconnect", disconnectHandler);
          clearTimeout(timeoutId);
        }
      };

      const disconnectHandler = (): void => {
        this.logger.debug("Shutdown complete: socket disconnected", { workspace: normalized });
        cleanup();
        resolve();
      };

      const timeoutId = setTimeout(() => {
        this.logger.warn("Shutdown timeout: proceeding anyway", {
          workspace: normalized,
          timeoutMs,
        });
        cleanup();
        resolve();
      }, timeoutMs);

      // Set up listener BEFORE emit to avoid race condition
      socket.once("disconnect", disconnectHandler);

      this.logger.debug("Sending shutdown", { workspace: normalized });
      socket.emit("shutdown", (result) => {
        // Ack received - extension is about to exit
        // Don't resolve here - wait for actual disconnect
        if (!result.success) {
          this.logger.warn("Shutdown ack error", { workspace: normalized, error: result.error });
        }
      });
    });
  }

  /**
   * Close the server and disconnect all clients.
   */
  async close(): Promise<void> {
    if (!this.io) {
      return;
    }

    this.logger.info("Closing");

    // Disconnect all sockets
    for (const socket of this.connections.values()) {
      socket.disconnect(true);
    }
    this.connections.clear();
    this.workspaceConfigs.clear();

    // Close Socket.IO server
    await new Promise<void>((resolve) => {
      this.io!.close(() => {
        resolve();
      });
    });

    // Close HTTP server
    await new Promise<void>((resolve) => {
      this.httpServer!.close(() => {
        resolve();
      });
    });

    this.io = null;
    this.httpServer = null;
    this.port = null;

    this.logger.info("Closed");
  }

  /**
   * Set up Socket.IO event handlers.
   */
  private setupEventHandlers(): void {
    this.io!.on("connection", (socket: TypedSocket) => {
      const auth = socket.handshake.auth as unknown;

      // Validate auth contains workspacePath
      if (!this.isValidAuth(auth)) {
        this.logger.warn("Connection rejected: invalid auth", {
          socketId: socket.id,
        });
        socket.disconnect(true);
        return;
      }

      // Normalize and validate workspacePath (Path throws on relative paths)
      let workspacePath: string;
      try {
        workspacePath = new Path(auth.workspacePath).toString();
      } catch {
        this.logger.warn("Connection rejected: invalid path", {
          socketId: socket.id,
          path: auth.workspacePath,
        });
        socket.disconnect(true);
        return;
      }

      // Store workspace path in socket data
      socket.data.workspacePath = workspacePath;

      // Check for existing connection from same workspace
      const existingSocket = this.connections.get(workspacePath);
      if (existingSocket) {
        this.logger.info("Disconnecting duplicate connection", {
          workspace: workspacePath,
          oldSocketId: existingSocket.id,
          newSocketId: socket.id,
        });
        existingSocket.disconnect(true);
      }

      // Register new connection
      this.connections.set(workspacePath, socket);
      this.logger.info("Client connected", {
        workspace: workspacePath,
        socketId: socket.id,
      });

      // Get config data from per-workspace storage
      const storedConfig = this.workspaceConfigs.get(workspacePath);
      const env: Record<string, string> | null = storedConfig?.env ?? null;
      const agentType: AgentType | null = storedConfig?.agentType ?? null;

      // Send config event with all startup data
      const config: PluginConfig = {
        isDevelopment: this.isDevelopment,
        env,
        agentType,
      };
      socket.emit("config", config);
      this.logger.debug("Config sent", {
        workspace: workspacePath,
        isDevelopment: this.isDevelopment,
        hasEnv: env !== null,
        agentType,
      });

      // Handle disconnection
      socket.on("disconnect", (reason) => {
        // Only remove if this is still the registered socket for this workspace
        // (prevents race condition where new socket connects before old one disconnects)
        const currentSocket = this.connections.get(workspacePath);
        if (currentSocket === socket) {
          this.connections.delete(workspacePath);
          this.logger.info("Client disconnected", {
            workspace: workspacePath,
            reason,
          });
        }
      });

      // Set up API event handlers
      this.setupApiHandlers(socket, workspacePath);
    });
  }

  /**
   * Set up API event handlers for a connected socket.
   *
   * @param socket - The connected socket
   * @param workspacePath - Normalized workspace path for this connection
   */
  private setupApiHandlers(socket: TypedSocket, workspacePath: string): void {
    // No-arg handlers (getStatus, getAgentSession, getMetadata)
    socket.on(
      "api:workspace:getStatus",
      this.createNoArgHandler("api:workspace:getStatus", workspacePath, (h) => h.getStatus)
    );

    socket.on(
      "api:workspace:getAgentSession",
      this.createNoArgHandler(
        "api:workspace:getAgentSession",
        workspacePath,
        (h) => h.getAgentSession
      )
    );

    socket.on(
      "api:workspace:restartAgentServer",
      this.createNoArgHandler(
        "api:workspace:restartAgentServer",
        workspacePath,
        (h) => h.restartAgentServer
      )
    );

    socket.on(
      "api:workspace:getMetadata",
      this.createNoArgHandler("api:workspace:getMetadata", workspacePath, (h) => h.getMetadata)
    );

    // Validated handlers (setMetadata, delete, executeCommand)
    socket.on(
      "api:workspace:setMetadata",
      this.createValidatedHandler<SetMetadataRequest, SetMetadataRequest, void>(
        "api:workspace:setMetadata",
        workspacePath,
        validateSetMetadataRequest,
        (h, req) => h.setMetadata(workspacePath, req),
        (req) => ({ key: req.key })
      )
    );

    socket.on(
      "api:workspace:delete",
      this.createValidatedHandler<
        DeleteWorkspaceRequest | undefined,
        DeleteWorkspaceRequest,
        DeleteWorkspaceResponse
      >(
        "api:workspace:delete",
        workspacePath,
        validateDeleteWorkspaceRequest,
        (h, req) => h.delete(workspacePath, req),
        (req) => ({ keepBranch: !!req?.keepBranch })
      )
    );

    socket.on(
      "api:workspace:executeCommand",
      this.createValidatedHandler<ExecuteCommandRequest, ExecuteCommandRequest, unknown>(
        "api:workspace:executeCommand",
        workspacePath,
        validateExecuteCommandRequest,
        (h, req) => h.executeCommand(workspacePath, req),
        (req) => ({ command: req.command })
      )
    );

    socket.on(
      "api:workspace:create",
      this.createValidatedHandler<WorkspaceCreateRequest, WorkspaceCreateRequest, Workspace>(
        "api:workspace:create",
        workspacePath,
        validateWorkspaceCreateRequest,
        (h, req) => h.create(workspacePath, req),
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
      logAtLevel(this.extensionLogger, level, request.message, context);
    });
  }

  /**
   * Create a handler for no-argument API calls.
   */
  private createNoArgHandler<R>(
    eventName: string,
    workspacePath: string,
    getHandler: (handlers: ApiCallHandlers) => (workspacePath: string) => Promise<PluginResult<R>>
  ): (ack: (result: PluginResult<R>) => void) => void {
    return (ack) => {
      if (!this.apiHandlers) {
        this.logger.warn("API call without handlers registered", {
          event: eventName,
          workspace: workspacePath,
        });
        ack({ success: false, error: "API handlers not registered" });
        return;
      }

      this.logger.debug("API call", { event: eventName, workspace: workspacePath });

      getHandler(this.apiHandlers)(workspacePath)
        .then((result) => ack(result))
        .catch((error) => {
          const message = getErrorMessage(error);
          this.logger.error("API handler error", {
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
  private createValidatedHandler<TReq, TValidated, R>(
    eventName: string,
    workspacePath: string,
    validator: (
      payload: unknown
    ) => { valid: true; request?: TValidated } | { valid: false; error: string },
    invokeHandler: (handlers: ApiCallHandlers, request: TValidated) => Promise<PluginResult<R>>,
    logContext?: (request: TReq) => Record<string, unknown>
  ): (request: TReq, ack: (result: PluginResult<R>) => void) => void {
    return (request, ack) => {
      if (!this.apiHandlers) {
        this.logger.warn("API call without handlers registered", {
          event: eventName,
          workspace: workspacePath,
        });
        ack({ success: false, error: "API handlers not registered" });
        return;
      }

      const validation = validator(request);
      if (!validation.valid) {
        this.logger.warn("API call validation failed", {
          event: eventName,
          workspace: workspacePath,
          error: validation.error,
        });
        ack({ success: false, error: validation.error });
        return;
      }

      const validatedRequest = validation.request ?? (request as unknown as TValidated);
      this.logger.debug("API call", {
        event: eventName,
        workspace: workspacePath,
        ...logContext?.(request),
      });

      invokeHandler(this.apiHandlers, validatedRequest)
        .then((result) => ack(result))
        .catch((error) => {
          const message = getErrorMessage(error);
          this.logger.error("API handler error", {
            event: eventName,
            workspace: workspacePath,
            error: message,
          });
          ack({ success: false, error: message });
        });
    };
  }

  /**
   * Validate auth object contains required workspacePath string.
   */
  private isValidAuth(auth: unknown): auth is { workspacePath: string } {
    return (
      typeof auth === "object" &&
      auth !== null &&
      "workspacePath" in auth &&
      typeof (auth as { workspacePath: unknown }).workspacePath === "string" &&
      (auth as { workspacePath: string }).workspacePath.length > 0
    );
  }
}
