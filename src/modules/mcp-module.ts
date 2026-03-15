/**
 * McpModule - MCP server lifecycle management.
 *
 * Hook handlers:
 * - app:start / start: start MCP server, return mcpPort
 * - app:shutdown / stop: dispose MCP server
 *
 * McpServerManager is an internal implementation detail of this module.
 *
 * Workspace registration is no longer needed — the MCP server passes
 * workspacePath directly to API methods, and the intent system resolves
 * workspace identity via hook modules.
 */

import type { IntentModule } from "../intents/lib/module";
import { APP_START_OPERATION_ID } from "../intents/operations/app-start";
import { APP_SHUTDOWN_OPERATION_ID } from "../intents/operations/app-shutdown";
import type { PortManager } from "../boundaries/platform/network/network";
import type { McpApiHandlers } from "../services/mcp-server/types";
import type { Logger } from "../boundaries/platform/logging";
import { SILENT_LOGGER } from "../boundaries/platform/logging";
import type { IDisposable } from "../shared/types";
import {
  McpServer,
  createDefaultMcpServer,
  type McpServerFactory,
} from "../services/mcp-server/mcp-server";

// =============================================================================
// McpServerManager (module-private implementation)
// =============================================================================

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
  private readonly handlersFactory: () => McpApiHandlers;
  private readonly logger: Logger;
  private readonly serverFactory: McpServerFactory;

  private mcpServer: McpServer | null = null;
  private port: number | null = null;

  constructor(
    portManager: PortManager,
    handlersFactory: () => McpApiHandlers,
    logger?: Logger,
    config?: McpServerManagerConfig
  ) {
    this.portManager = portManager;
    this.handlersFactory = handlersFactory;
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
      this.mcpServer = new McpServer(this.handlersFactory(), this.serverFactory, this.logger);
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

// =============================================================================
// Dependencies
// =============================================================================

export interface McpModuleDeps {
  readonly portManager: PortManager;
  readonly handlersFactory: () => McpApiHandlers;
  readonly logger: Logger;
  readonly config?: McpServerManagerConfig;
}

// =============================================================================
// Module Factory
// =============================================================================

export function createMcpModule(deps: McpModuleDeps): IntentModule {
  const mcpServerManager = new McpServerManager(
    deps.portManager,
    deps.handlersFactory,
    deps.logger,
    deps.config
  );

  /** Capability: mcpPort provided by start handler. */
  let capMcpPort: number | undefined;

  return {
    name: "mcp",
    hooks: {
      [APP_START_OPERATION_ID]: {
        start: {
          provides: () => ({
            ...(capMcpPort !== undefined && { mcpPort: capMcpPort }),
          }),
          handler: async (): Promise<void> => {
            capMcpPort = undefined;
            capMcpPort = await mcpServerManager.start();
          },
        },
      },
      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async () => {
            await mcpServerManager.dispose();
          },
        },
      },
    },
  };
}
