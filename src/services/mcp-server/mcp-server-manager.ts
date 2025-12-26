/**
 * MCP Server Manager.
 *
 * Manages the lifecycle of the MCP server including port allocation and cleanup.
 * The MCP config file is written during VS Code setup, not at runtime.
 */

import type { PortManager } from "../platform/network";
import type { PathProvider } from "../platform/path-provider";
import type { ICoreApi } from "../../shared/api/interfaces";
import type { Logger } from "../logging";
import type { IDisposable } from "./types";
import type { WorkspaceLookup } from "./workspace-resolver";
import { McpServer, createDefaultMcpServer, type McpServerFactory } from "./mcp-server";

/**
 * Silent logger for when no logger is provided.
 */
const SILENT_LOGGER: Logger = {
  silly: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

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
 * - Provide the config path (from PathProvider) and port for OpenCodeServerManager
 */
export class McpServerManager implements IDisposable {
  private readonly portManager: PortManager;
  private readonly pathProvider: PathProvider;
  private readonly api: ICoreApi;
  private readonly appState: WorkspaceLookup;
  private readonly logger: Logger;
  private readonly serverFactory: McpServerFactory;

  private mcpServer: McpServer | null = null;
  private port: number | null = null;

  constructor(
    portManager: PortManager,
    pathProvider: PathProvider,
    api: ICoreApi,
    appState: WorkspaceLookup,
    logger?: Logger,
    config?: McpServerManagerConfig
  ) {
    this.portManager = portManager;
    this.pathProvider = pathProvider;
    this.api = api;
    this.appState = appState;
    this.logger = logger ?? SILENT_LOGGER;
    this.serverFactory = config?.serverFactory ?? createDefaultMcpServer;
  }

  /**
   * Start the MCP server.
   *
   * Allocates a port and starts the server. The config file is written during
   * VS Code setup, not at runtime.
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
      this.mcpServer = new McpServer(this.api, this.appState, this.serverFactory, this.logger);
      await this.mcpServer.start(this.port);

      this.logger.info("Manager started", {
        port: this.port,
        configPath: this.pathProvider.mcpConfigPath,
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
    this.logger.info("Manager stopped");
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
   * Get the path to the MCP config file.
   * The config file is written during VS Code setup.
   *
   * @returns Config file path from PathProvider
   */
  getConfigPath(): string {
    return this.pathProvider.mcpConfigPath;
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
