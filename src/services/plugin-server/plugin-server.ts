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
  COMMAND_TIMEOUT_MS,
  normalizeWorkspacePath,
} from "../../shared/plugin-protocol";

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
}

export class PluginServer {
  private readonly portManager: PortManager;
  private readonly logger: Logger;
  private readonly transports: readonly ("polling" | "websocket")[];
  private httpServer: HttpServer | null = null;
  private io: TypedServer | null = null;
  private port: number | null = null;

  /**
   * Map of normalized workspace paths to connected sockets.
   */
  private readonly connections = new Map<string, TypedSocket>();

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
