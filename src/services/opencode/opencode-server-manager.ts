/**
 * OpenCode Server Manager - manages one opencode serve instance per workspace.
 *
 * Instead of letting users spawn multiple opencode processes, CodeHydra manages
 * one server per workspace. The opencode CLI wrapper reads the port from the
 * CODEHYDRA_OPENCODE_PORT environment variable (set by the sidekick extension)
 * and redirects to `opencode attach`.
 */

import type { ProcessRunner, SpawnedProcess } from "../platform/process";
import {
  PROCESS_KILL_GRACEFUL_TIMEOUT_MS,
  PROCESS_KILL_FORCE_TIMEOUT_MS,
} from "../platform/process";
import type { PortManager, HttpClient } from "../platform/network";
import type { PathProvider } from "../platform/path-provider";
import type { Logger } from "../logging";
import type { IDisposable, Unsubscribe } from "./types";

/**
 * Callback types for OpenCodeServerManager.
 */
export type ServerStartedCallback = (workspacePath: string, port: number) => void;
export type ServerStoppedCallback = (workspacePath: string) => void;

/**
 * Server entry in the manager's internal map.
 */
interface ServerEntry {
  port: number;
  process: SpawnedProcess;
  startPromise: Promise<number> | null;
}

/**
 * Configuration options for OpenCodeServerManager.
 */
export interface OpenCodeServerManagerConfig {
  /** Timeout for health check in milliseconds. Default: 30000 */
  healthCheckTimeoutMs?: number;
  /** Interval between health check retries in milliseconds. Default: 500 */
  healthCheckIntervalMs?: number;
}

/**
 * MCP server configuration for OpenCode integration.
 */
export interface McpConfig {
  /** Path to the MCP config file */
  readonly configPath: string;
  /** MCP server port */
  readonly port: number;
}

/**
 * Result of stopping an OpenCode server.
 */
export interface StopServerResult {
  success: boolean;
  error?: string;
}

/**
 * Manages OpenCode server instances for workspaces.
 * One server per workspace, with health check. Port stored in memory only.
 */
export class OpenCodeServerManager implements IDisposable {
  private readonly processRunner: ProcessRunner;
  private readonly portManager: PortManager;
  private readonly httpClient: HttpClient;
  private readonly pathProvider: PathProvider;
  private readonly logger: Logger;
  private readonly config: Required<OpenCodeServerManagerConfig>;

  private readonly servers = new Map<string, ServerEntry>();
  private readonly startedCallbacks = new Set<ServerStartedCallback>();
  private readonly stoppedCallbacks = new Set<ServerStoppedCallback>();

  private mcpConfig: McpConfig | null = null;

  constructor(
    processRunner: ProcessRunner,
    portManager: PortManager,
    httpClient: HttpClient,
    pathProvider: PathProvider,
    logger: Logger,
    config?: OpenCodeServerManagerConfig
  ) {
    this.processRunner = processRunner;
    this.portManager = portManager;
    this.httpClient = httpClient;
    this.pathProvider = pathProvider;
    this.logger = logger;
    this.config = {
      healthCheckTimeoutMs: config?.healthCheckTimeoutMs ?? 30000,
      healthCheckIntervalMs: config?.healthCheckIntervalMs ?? 500,
    };
  }

  /**
   * Start an OpenCode server for a workspace.
   * Returns the port number on success.
   *
   * @param workspacePath - Absolute path to the workspace
   * @returns Allocated port number
   * @throws Error if server fails to start or health check times out
   */
  async startServer(workspacePath: string): Promise<number> {
    // Check if already running/starting
    const existing = this.servers.get(workspacePath);
    if (existing) {
      if (existing.startPromise) {
        return existing.startPromise;
      }
      return existing.port;
    }

    // Create the start promise
    const startPromise = this.doStartServer(workspacePath);

    // Store a placeholder entry while starting
    const placeholderEntry: ServerEntry = {
      port: 0,
      process: null as unknown as SpawnedProcess,
      startPromise,
    };
    this.servers.set(workspacePath, placeholderEntry);

    try {
      const port = await startPromise;
      return port;
    } catch (error) {
      // Clean up on failure
      this.servers.delete(workspacePath);
      throw error;
    }
  }

  /**
   * Internal method to start the server.
   */
  private async doStartServer(workspacePath: string): Promise<number> {
    // Allocate a free port
    const port = await this.portManager.findFreePort();

    // Build environment variables with MCP config if available
    let env: NodeJS.ProcessEnv | undefined;
    if (this.mcpConfig) {
      env = {
        ...process.env,
        OPENCODE_CONFIG: this.mcpConfig.configPath,
        CODEHYDRA_WORKSPACE_PATH: workspacePath,
        CODEHYDRA_MCP_PORT: String(this.mcpConfig.port),
      };
      this.logger.debug("Starting with MCP env", {
        workspacePath,
        mcpPort: this.mcpConfig.port,
        configPath: this.mcpConfig.configPath,
      });
    }

    // Spawn opencode serve
    const opencodeCmd = this.pathProvider.opencodeBinaryPath;
    const proc = this.processRunner.run(opencodeCmd, ["serve", "--port", String(port)], {
      cwd: workspacePath,
      ...(env && { env }),
    });

    // Check if spawn failed
    if (proc.pid === undefined) {
      const result = await proc.wait();
      throw new Error(`Failed to spawn opencode: ${result.stderr}`);
    }

    // Wait for health check
    try {
      await this.waitForHealthCheck(port);
    } catch (error) {
      // Kill the process on health check failure
      await proc.kill(PROCESS_KILL_GRACEFUL_TIMEOUT_MS, PROCESS_KILL_FORCE_TIMEOUT_MS);
      throw error;
    }

    // Update the server entry
    const entry: ServerEntry = {
      port,
      process: proc,
      startPromise: null,
    };
    this.servers.set(workspacePath, entry);

    // Fire callback
    for (const callback of this.startedCallbacks) {
      callback(workspacePath, port);
    }

    this.logger.info("Server started", { workspacePath, port, pid: proc.pid });

    return port;
  }

  /**
   * Wait for health check to pass.
   */
  private async waitForHealthCheck(port: number): Promise<void> {
    const startTime = Date.now();
    const url = `http://127.0.0.1:${port}/path`;

    while (Date.now() - startTime < this.config.healthCheckTimeoutMs) {
      try {
        const response = await this.httpClient.fetch(url, { timeout: 2000 });
        if (response.ok) {
          return;
        }
      } catch {
        // Continue retrying
      }

      // Wait before next attempt
      await new Promise((resolve) => setTimeout(resolve, this.config.healthCheckIntervalMs));
    }

    throw new Error(`Health check timeout after ${this.config.healthCheckTimeoutMs}ms`);
  }

  /**
   * Stop an OpenCode server for a workspace.
   *
   * @param workspacePath - Absolute path to the workspace
   * @returns StopResult indicating success or failure
   */
  async stopServer(workspacePath: string): Promise<StopServerResult> {
    const entry = this.servers.get(workspacePath);
    if (!entry) {
      return { success: true };
    }

    // Wait for pending start
    if (entry.startPromise) {
      try {
        await entry.startPromise;
      } catch {
        // Start failed, but we still need to clean up
      }
    }

    // Get the current entry (may have been updated after startPromise resolved)
    const currentEntry = this.servers.get(workspacePath);
    let stopResult: StopServerResult = { success: true };

    if (currentEntry && currentEntry.process) {
      // Kill the process with 1s timeouts
      const killResult = await currentEntry.process.kill(
        PROCESS_KILL_GRACEFUL_TIMEOUT_MS,
        PROCESS_KILL_FORCE_TIMEOUT_MS
      );

      if (!killResult.success) {
        this.logger.warn("Failed to kill OpenCode server", {
          workspacePath,
          pid: currentEntry.process.pid ?? 0,
        });
        stopResult = { success: false, error: "Process did not terminate" };
      }
    }

    // Remove from map
    this.servers.delete(workspacePath);

    // Fire callback
    for (const callback of this.stoppedCallbacks) {
      callback(workspacePath);
    }

    this.logger.info("Server stopped", { workspacePath });

    return stopResult;
  }

  /**
   * Stop all servers for a project.
   * Stops servers whose path starts with the project path.
   *
   * @param projectPath - Absolute path to the project
   */
  async stopAllForProject(projectPath: string): Promise<void> {
    const workspaces = [...this.servers.keys()].filter((path) => path.startsWith(projectPath));

    await Promise.all(workspaces.map((path) => this.stopServer(path)));
  }

  /**
   * Get the port for a workspace.
   *
   * @param workspacePath - Absolute path to the workspace
   * @returns Port number or undefined if not running
   */
  getPort(workspacePath: string): number | undefined {
    const entry = this.servers.get(workspacePath);
    return entry?.port || undefined;
  }

  /**
   * Subscribe to server started events.
   */
  onServerStarted(callback: ServerStartedCallback): Unsubscribe {
    this.startedCallbacks.add(callback);
    return () => this.startedCallbacks.delete(callback);
  }

  /**
   * Subscribe to server stopped events.
   */
  onServerStopped(callback: ServerStoppedCallback): Unsubscribe {
    this.stoppedCallbacks.add(callback);
    return () => this.stoppedCallbacks.delete(callback);
  }

  /**
   * Set the MCP server configuration.
   * This must be called before starting servers if MCP integration is desired.
   *
   * @param config - MCP configuration with config path and port
   */
  setMcpConfig(config: McpConfig): void {
    this.mcpConfig = config;
    this.logger.debug("MCP config set", { configPath: config.configPath, port: config.port });
  }

  /**
   * Get the current MCP configuration.
   */
  getMcpConfig(): McpConfig | null {
    return this.mcpConfig;
  }

  /**
   * Dispose the manager, stopping all servers.
   */
  async dispose(): Promise<void> {
    const workspaces = [...this.servers.keys()];
    await Promise.all(workspaces.map((path) => this.stopServer(path)));
    this.startedCallbacks.clear();
    this.stoppedCallbacks.clear();
  }
}
