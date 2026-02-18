/**
 * MCP Server Manager.
 *
 * Manages the lifecycle of the MCP server including port allocation and cleanup.
 */

import type { PortManager } from "../platform/network";
import type { PathProvider } from "../platform/path-provider";
import type { ICoreApi } from "../../shared/api/interfaces";
import type { Logger } from "../logging";
import { SILENT_LOGGER } from "../logging";
import type { IDisposable } from "../../shared/types";
import type { McpResolvedWorkspace } from "./types";
import { McpServer, createDefaultMcpServer, type McpServerFactory } from "./mcp-server";
import { Path } from "../platform/path";

/**
 * Configuration options for McpServerManager.
 */
export interface McpServerManagerConfig {
  /** Optional MCP server factory for testing */
  serverFactory?: McpServerFactory;
}

/**
 * Manages the MCP server lifecycle.
 *
 * Responsibilities:
 * - Allocate a dynamic port for the MCP server
 * - Start/stop the MCP server
 * - Provide the port for OpenCodeServerManager
 */
export class McpServerManager implements IDisposable {
  private readonly portManager: PortManager;
  private readonly api: ICoreApi;
  private readonly logger: Logger;
  private readonly serverFactory: McpServerFactory;

  private mcpServer: McpServer | null = null;
  private port: number | null = null;

  // Workspace identity registry (queued until server starts)
  private pendingRegistrations = new Map<string, McpResolvedWorkspace>();

  constructor(
    portManager: PortManager,
    pathProvider: PathProvider,
    api: ICoreApi,
    logger?: Logger,
    config?: McpServerManagerConfig
  ) {
    void pathProvider; // Kept in constructor signature for backward compatibility
    this.portManager = portManager;
    this.api = api;
    this.logger = logger ?? SILENT_LOGGER;
    this.serverFactory = config?.serverFactory ?? createDefaultMcpServer;
  }

  /**
   * Start the MCP server.
   *
   * Allocates a port and starts the server.
   *
   * @returns The port the server is listening on
   * @throws Error if server fails to start
   */
  async start(): Promise<number> {
    if (this.mcpServer?.isRunning()) {
      this.logger.warn("Server already running");
      return this.port!;
    }

    try {
      // Allocate a free port
      this.port = await this.portManager.findFreePort();
      this.logger.info("Allocated port", { port: this.port });

      // Create and start the MCP server
      this.mcpServer = new McpServer(this.api, this.serverFactory, this.logger);

      // Replay any registrations that arrived before the server started
      for (const identity of this.pendingRegistrations.values()) {
        this.mcpServer.registerWorkspace(identity);
      }
      this.pendingRegistrations.clear();

      await this.mcpServer.start(this.port);

      this.logger.info("Manager started", {
        port: this.port,
      });

      return this.port;
    } catch (error) {
      // Clean up on failure
      await this.stop();
      throw error;
    }
  }

  /**
   * Stop the MCP server.
   */
  async stop(): Promise<void> {
    if (this.mcpServer) {
      await this.mcpServer.stop();
      this.mcpServer = null;
    }

    this.port = null;
    this.pendingRegistrations.clear();
    this.logger.info("Manager stopped");
  }

  /**
   * Register a workspace for MCP tool resolution.
   * If the server is running, delegates immediately; otherwise queues for replay on start.
   */
  registerWorkspace(identity: McpResolvedWorkspace): void {
    if (this.mcpServer) {
      this.mcpServer.registerWorkspace(identity);
    } else {
      this.pendingRegistrations.set(new Path(identity.workspacePath).toString(), identity);
    }
  }

  /**
   * Unregister a workspace from MCP tool resolution.
   */
  unregisterWorkspace(workspacePath: string): void {
    const normalizedPath = new Path(workspacePath).toString();
    if (this.mcpServer) {
      this.mcpServer.unregisterWorkspace(workspacePath);
    } else {
      this.pendingRegistrations.delete(normalizedPath);
    }
  }

  /**
   * Get the port the MCP server is running on.
   *
   * @returns Port number or null if not running
   */
  getPort(): number | null {
    return this.port;
  }

  /**
   * Check if the server is running.
   */
  isRunning(): boolean {
    return this.mcpServer?.isRunning() ?? false;
  }

  /**
   * Dispose the manager (alias for stop).
   */
  async dispose(): Promise<void> {
    await this.stop();
  }
}
