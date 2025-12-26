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
import path from "node:path";
import type { Logger } from "../logging";
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
  type PluginConfig,
  COMMAND_TIMEOUT_MS,
  normalizeWorkspacePath,
  validateSetMetadataRequest,
  validateDeleteWorkspaceRequest,
} from "../../shared/plugin-protocol";
import type { WorkspaceStatus } from "../../shared/api/types";

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
   * Handle getOpencodePort request.
   * @param workspacePath - Normalized workspace path
   * @returns Port number (null if not running) or error
   */
  getOpencodePort(workspacePath: string): Promise<PluginResult<number | null>>;

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
 * No-op logger implementation for when no logger is provided.
 */
const SILENT_LOGGER: Logger = {
  silly: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * Configuration options for PluginServer.
 */
export interface PluginServerOptions {
  /** Socket.IO transports to use. Default: ["websocket"] */
  readonly transports?: readonly ("polling" | "websocket")[];
  /** Whether the app is running in development mode. Default: false */
  readonly isDevelopment?: boolean;
}

export class PluginServer {
  private readonly portManager: PortManager;
  private readonly logger: Logger;
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
   * Callbacks to invoke when a client connects.
   * Each callback receives the normalized workspace path.
   */
  private readonly connectCallbacks = new Set<(workspacePath: string) => void>();

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
      // Listen on localhost only for security
      this.httpServer!.listen(port, "localhost", () => {
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
    const normalized = normalizeWorkspacePath(workspacePath);
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
    const normalized = normalizeWorkspacePath(workspacePath);
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
   * Register a callback to be invoked when a client connects.
   *
   * The callback is invoked AFTER connection validation succeeds.
   * Rejected connections do not trigger the callback.
   *
   * @param callback - Function to call with normalized workspace path
   * @returns Unsubscribe function to remove the callback
   *
   * @example
   * ```typescript
   * const unsubscribe = server.onConnect((workspacePath) => {
   *   console.log(`Workspace connected: ${workspacePath}`);
   * });
   *
   * // Later, to stop receiving notifications:
   * unsubscribe();
   * ```
   */
  onConnect(callback: (workspacePath: string) => void): () => void {
    this.connectCallbacks.add(callback);
    return () => {
      this.connectCallbacks.delete(callback);
    };
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

      const workspacePath = normalizeWorkspacePath(auth.workspacePath);

      // Validate workspacePath is an absolute path
      if (!path.isAbsolute(workspacePath)) {
        this.logger.warn("Connection rejected: relative path", {
          socketId: socket.id,
          path: workspacePath,
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

      // Send config event with development mode flag
      const config: PluginConfig = { isDevelopment: this.isDevelopment };
      socket.emit("config", config);
      this.logger.debug("Config sent", {
        workspace: workspacePath,
        isDevelopment: this.isDevelopment,
      });

      // Invoke connect callbacks
      for (const callback of this.connectCallbacks) {
        try {
          callback(workspacePath);
        } catch (error) {
          // Log error but don't crash server or prevent other callbacks
          const message = error instanceof Error ? error.message : String(error);
          this.logger.error("Connect callback error", {
            workspace: workspacePath,
            error: message,
          });
        }
      }

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
    // Handle api:workspace:getStatus
    socket.on("api:workspace:getStatus", (ack) => {
      if (!this.apiHandlers) {
        this.logger.warn("API call without handlers registered", {
          event: "api:workspace:getStatus",
          workspace: workspacePath,
        });
        ack({ success: false, error: "API handlers not registered" });
        return;
      }

      this.logger.debug("API call", { event: "api:workspace:getStatus", workspace: workspacePath });

      this.apiHandlers
        .getStatus(workspacePath)
        .then((result) => {
          ack(result);
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.error("API handler error", {
            event: "api:workspace:getStatus",
            workspace: workspacePath,
            error: message,
          });
          ack({ success: false, error: message });
        });
    });

    // Handle api:workspace:getOpencodePort
    socket.on("api:workspace:getOpencodePort", (ack) => {
      if (!this.apiHandlers) {
        this.logger.warn("API call without handlers registered", {
          event: "api:workspace:getOpencodePort",
          workspace: workspacePath,
        });
        ack({ success: false, error: "API handlers not registered" });
        return;
      }

      this.logger.debug("API call", {
        event: "api:workspace:getOpencodePort",
        workspace: workspacePath,
      });

      this.apiHandlers
        .getOpencodePort(workspacePath)
        .then((result) => {
          ack(result);
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.error("API handler error", {
            event: "api:workspace:getOpencodePort",
            workspace: workspacePath,
            error: message,
          });
          ack({ success: false, error: message });
        });
    });

    // Handle api:workspace:getMetadata
    socket.on("api:workspace:getMetadata", (ack) => {
      if (!this.apiHandlers) {
        this.logger.warn("API call without handlers registered", {
          event: "api:workspace:getMetadata",
          workspace: workspacePath,
        });
        ack({ success: false, error: "API handlers not registered" });
        return;
      }

      this.logger.debug("API call", {
        event: "api:workspace:getMetadata",
        workspace: workspacePath,
      });

      this.apiHandlers
        .getMetadata(workspacePath)
        .then((result) => {
          ack(result);
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.error("API handler error", {
            event: "api:workspace:getMetadata",
            workspace: workspacePath,
            error: message,
          });
          ack({ success: false, error: message });
        });
    });

    // Handle api:workspace:setMetadata
    socket.on("api:workspace:setMetadata", (request, ack) => {
      if (!this.apiHandlers) {
        this.logger.warn("API call without handlers registered", {
          event: "api:workspace:setMetadata",
          workspace: workspacePath,
        });
        ack({ success: false, error: "API handlers not registered" });
        return;
      }

      // Validate request before invoking handler
      const validation = validateSetMetadataRequest(request);
      if (!validation.valid) {
        this.logger.warn("API call validation failed", {
          event: "api:workspace:setMetadata",
          workspace: workspacePath,
          error: validation.error,
        });
        ack({ success: false, error: validation.error });
        return;
      }

      this.logger.debug("API call", {
        event: "api:workspace:setMetadata",
        workspace: workspacePath,
        key: request.key,
      });

      this.apiHandlers
        .setMetadata(workspacePath, request)
        .then((result) => {
          ack(result);
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.error("API handler error", {
            event: "api:workspace:setMetadata",
            workspace: workspacePath,
            error: message,
          });
          ack({ success: false, error: message });
        });
    });

    // Handle api:workspace:delete
    socket.on("api:workspace:delete", (request, ack) => {
      if (!this.apiHandlers) {
        this.logger.warn("API call without handlers registered", {
          event: "api:workspace:delete",
          workspace: workspacePath,
        });
        ack({ success: false, error: "API handlers not registered" });
        return;
      }

      // Validate request before invoking handler
      const validation = validateDeleteWorkspaceRequest(request);
      if (!validation.valid) {
        this.logger.warn("API call validation failed", {
          event: "api:workspace:delete",
          workspace: workspacePath,
          error: validation.error,
        });
        ack({ success: false, error: validation.error });
        return;
      }

      this.logger.debug("API call", {
        event: "api:workspace:delete",
        workspace: workspacePath,
        keepBranch: !!validation.request.keepBranch,
      });

      this.apiHandlers
        .delete(workspacePath, validation.request)
        .then((result) => {
          ack(result);
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.error("API handler error", {
            event: "api:workspace:delete",
            workspace: workspacePath,
            error: message,
          });
          ack({ success: false, error: message });
        });
    });
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
