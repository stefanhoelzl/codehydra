/**
 * OpenCode Server Manager - manages one opencode serve instance per workspace.
 *
 * Instead of letting users spawn multiple opencode processes, CodeHydra manages
 * one server per workspace. The opencode CLI wrapper reads the port from the
 * CODEHYDRA_OPENCODE_PORT environment variable (set by the sidekick extension)
 * and redirects to `opencode attach`.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "http";
import type { ProcessRunner, SpawnedProcess } from "../../services/platform/process";
import {
  PROCESS_KILL_GRACEFUL_TIMEOUT_MS,
  PROCESS_KILL_FORCE_TIMEOUT_MS,
} from "../../services/platform/process";
import type { PortManager, HttpClient } from "../../services/platform/network";
import type { PathProvider } from "../../services/platform/path-provider";
import type { Logger } from "../../services/logging";
import type { IDisposable, Unsubscribe } from "./types";
import { waitForHealthy } from "../../services/platform/health-check";
import { Path } from "../../services/platform/path";
import type { PromptModel } from "../../shared/api/types";
import type { AgentServerManager, StopServerResult, RestartServerResult } from "../types";
import { OPENCODE_VERSION } from "../../services/binary-download/versions";

/**
 * Pending initial prompt to send when server becomes healthy.
 */
export interface PendingPrompt {
  readonly prompt: string;
  readonly agent?: string;
  readonly model?: PromptModel;
}

/**
 * Callback types for OpenCodeServerManager.
 */
export type ServerStartedCallback = (
  workspacePath: string,
  port: number,
  pendingPrompt: PendingPrompt | undefined
) => void;
/**
 * Callback for server stopped events.
 * @param workspacePath - Path to the workspace
 * @param isRestart - True if this stop is part of a restart (will be followed by start)
 */
export type ServerStoppedCallback = (workspacePath: string, isRestart: boolean) => void;

/**
 * Callback for workspace ready events.
 * Triggered when a wrapper start notification is received.
 */
export type WorkspaceReadyCallback = (workspacePath: string) => void;

/**
 * Server entry in the manager's internal map.
 * Uses a discriminated union to properly model starting, running, and restarting states.
 */
type ServerEntry =
  | { readonly state: "starting"; readonly startPromise: Promise<number> }
  | { readonly state: "running"; readonly port: number; readonly process: SpawnedProcess }
  | {
      readonly state: "restarting";
      readonly port: number;
      readonly process: SpawnedProcess;
      readonly restartPromise: Promise<RestartServerResult>;
    };

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
 * Options for starting a server.
 */
export interface StartServerOptions {
  /** Initial prompt to send after server becomes healthy */
  readonly initialPrompt?: {
    readonly prompt: string;
    readonly agent?: string;
    readonly model?: PromptModel;
  };
}

/**
 * MCP server configuration for OpenCode integration.
 */
export interface McpConfig {
  /** MCP server port */
  readonly port: number;
}

// Re-export result types from agent types for backward compatibility
export type { StopServerResult, RestartServerResult } from "../types";

/**
 * Manages OpenCode server instances for workspaces.
 * One server per workspace, with health check. Port stored in memory only.
 *
 * Implements AgentServerManager interface for use in the agent abstraction layer.
 */
export class OpenCodeServerManager implements AgentServerManager, IDisposable {
  private readonly processRunner: ProcessRunner;
  private readonly portManager: PortManager;
  private readonly httpClient: HttpClient;
  private readonly pathProvider: PathProvider;
  private readonly logger: Logger;
  private readonly config: Required<OpenCodeServerManagerConfig>;

  private readonly servers = new Map<string, ServerEntry>();
  private readonly startedCallbacks = new Set<ServerStartedCallback>();
  private readonly stoppedCallbacks = new Set<ServerStoppedCallback>();

  /**
   * Pending initial prompts to send when servers become healthy.
   * Key is normalized workspace path (via Path.toString()).
   */
  private readonly pendingPrompts = new Map<string, PendingPrompt>();

  private mcpConfig: McpConfig | null = null;

  /** Bridge HTTP server for receiving wrapper notifications (shared across all workspaces) */
  private bridgeServer: Server | null = null;
  /** Port the bridge server is listening on */
  private bridgePort: number | null = null;
  /** Promise for the in-progress bridge server start (prevents concurrent double-start) */
  private bridgeStartPromise: Promise<void> | null = null;
  /** Callbacks for workspace ready events (wrapper started) */
  private readonly workspaceReadyCallbacks = new Set<WorkspaceReadyCallback>();
  /** Handler called when workspace becomes active (WrapperStart) */
  private markActiveHandler: ((workspacePath: string) => void) | null = null;

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
   * @param options - Optional start options (e.g., initialPrompt)
   * @returns Allocated port number
   * @throws Error if server fails to start or health check times out
   */
  async startServer(workspacePath: string, options?: StartServerOptions): Promise<number> {
    // Store pending prompt if provided
    if (options?.initialPrompt) {
      this.setPendingPrompt(
        workspacePath,
        options.initialPrompt.prompt,
        options.initialPrompt.agent,
        options.initialPrompt.model
      );
    }

    // Check if already running/starting
    const existing = this.servers.get(workspacePath);
    if (existing) {
      if (existing.state === "starting") {
        return existing.startPromise;
      }
      return existing.port;
    }

    // Create the start promise (includes bridge initialization)
    // Set entry BEFORE any async work so concurrent callers (e.g. restartServer) can see it
    const startPromise = this.doStartWithBridge(workspacePath);
    this.servers.set(workspacePath, { state: "starting", startPromise });

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
   * Internal method that ensures bridge is running, then starts the server.
   */
  private async doStartWithBridge(workspacePath: string): Promise<number> {
    // Start bridge server if not running (shared across all workspaces)
    if (!this.bridgeStartPromise) {
      this.bridgeStartPromise = this.startBridgeServer();
    }
    await this.bridgeStartPromise;

    return this.doStartServer(workspacePath);
  }

  /**
   * Internal method to start the server.
   */
  private async doStartServer(workspacePath: string): Promise<number> {
    // Allocate a free port
    const port = await this.portManager.findFreePort();

    // Spawn server and wait for health check
    const proc = await this.spawnServerOnPort(workspacePath, port);

    // Update the server entry to running state
    this.servers.set(workspacePath, { state: "running", port, process: proc });

    // Consume pending prompt before firing callback
    const pendingPrompt = this.consumePendingPrompt(workspacePath);

    // pid is guaranteed to be defined since spawnServerOnPort validates it
    this.logger.info("Server started", { workspacePath, port, pid: proc.pid! });

    // Fire callback with pending prompt (caller handles sending)
    for (const callback of this.startedCallbacks) {
      callback(workspacePath, port, pendingPrompt);
    }

    return port;
  }

  /**
   * Spawn an OpenCode server and wait for it to be healthy.
   * Common implementation used by both doStartServer and startServerOnPort.
   *
   * @param workspacePath - Absolute path to the workspace
   * @param port - Port number to use
   * @returns The spawned process
   * @throws Error if server fails to spawn or health check times out
   */
  private async spawnServerOnPort(workspacePath: string, port: number): Promise<SpawnedProcess> {
    // Build environment variables with MCP config if available
    let env: NodeJS.ProcessEnv | undefined;
    if (this.mcpConfig) {
      // Use Path.toString() for the workspace path (already POSIX format).
      // Backslashes would become invalid escape sequences in JSON.
      const normalizedWorkspacePath = new Path(workspacePath).toString();
      env = {
        ...process.env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          mcp: {
            codehydra: {
              type: "remote",
              url: `http://127.0.0.1:${this.mcpConfig.port}/mcp`,
              headers: { "X-Workspace-Path": normalizedWorkspacePath },
              enabled: true,
            },
          },
        }),
      };
    }

    // Spawn opencode serve
    const opencodeCmd = this.pathProvider.getBinaryPath("opencode", OPENCODE_VERSION).toNative();
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

    return proc;
  }

  /**
   * Wait for health check to pass.
   */
  private async waitForHealthCheck(port: number): Promise<void> {
    const url = `http://127.0.0.1:${port}/path`;

    await waitForHealthy({
      checkFn: async () => {
        const response = await this.httpClient.fetch(url, { timeout: 2000 });
        return response.ok;
      },
      timeoutMs: this.config.healthCheckTimeoutMs,
      intervalMs: this.config.healthCheckIntervalMs,
      errorMessage: `Health check timeout after ${this.config.healthCheckTimeoutMs}ms`,
    });
  }

  /**
   * Stop an OpenCode server for a workspace.
   *
   * @param workspacePath - Absolute path to the workspace
   * @param isRestart - True if this stop is part of a restart operation
   * @returns StopResult indicating success or failure
   */
  async stopServer(workspacePath: string, isRestart = false): Promise<StopServerResult> {
    const entry = this.servers.get(workspacePath);
    if (!entry) {
      return { success: true };
    }

    // Wait for pending start
    if (entry.state === "starting") {
      try {
        await entry.startPromise;
      } catch {
        // Start failed, but we still need to clean up
      }
    }

    // Get the current entry (may have been updated after startPromise resolved)
    const currentEntry = this.servers.get(workspacePath);
    let stopResult: StopServerResult = { success: true };

    // Kill the process if we have a running or restarting server
    if (currentEntry && (currentEntry.state === "running" || currentEntry.state === "restarting")) {
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

    // Remove from map (but NOT if restarting - the restart will update the entry)
    const finalEntry = this.servers.get(workspacePath);
    if (finalEntry?.state !== "restarting") {
      this.servers.delete(workspacePath);
    }

    // Fire callback with isRestart flag
    for (const callback of this.stoppedCallbacks) {
      callback(workspacePath, isRestart);
    }

    this.logger.info("Server stopped", { workspacePath, isRestart });

    return stopResult;
  }

  /**
   * Restart an OpenCode server for a workspace, preserving the same port.
   *
   * Note: This method is NOT async to ensure idempotency - when called multiple
   * times concurrently, it returns the SAME promise object. If it were async,
   * each call would create a new wrapper Promise.
   *
   * @param workspacePath - Absolute path to the workspace
   * @returns RestartServerResult with port on success, or error details on failure
   */
  restartServer(workspacePath: string): Promise<RestartServerResult> {
    const entry = this.servers.get(workspacePath);

    // If already restarting, return the in-progress promise (idempotent)
    if (entry?.state === "restarting") {
      return entry.restartPromise;
    }

    // If starting, wait for start to complete, then restart
    if (entry?.state === "starting") {
      return entry.startPromise
        .then(() => this.restartServer(workspacePath))
        .catch(() => ({
          success: false as const,
          error: "Server failed to start",
          serverStopped: false,
        }));
    }

    // If not running, can't restart
    if (!entry || entry.state !== "running") {
      return Promise.resolve({
        success: false as const,
        error: "Server not running",
        serverStopped: false,
      });
    }

    // Get the current port and process to preserve
    const port = entry.port;
    const process = entry.process;

    // Use a deferred promise pattern to set state BEFORE any async work
    // This prevents race conditions where concurrent calls both see "running" state
    let resolveRestart!: (result: RestartServerResult) => void;
    let rejectRestart!: (error: Error) => void;
    const restartPromise = new Promise<RestartServerResult>((resolve, reject) => {
      resolveRestart = resolve;
      rejectRestart = reject;
    });

    // Store entry while restarting BEFORE calling doRestartServer
    // (keep process reference so stopServer can kill it)
    this.servers.set(workspacePath, { state: "restarting", port, process, restartPromise });

    // Kick off the restart and resolve the deferred promise
    this.doRestartServer(workspacePath, port).then(resolveRestart).catch(rejectRestart);

    return restartPromise;
  }

  /**
   * Internal method to perform the restart.
   */
  private async doRestartServer(workspacePath: string, port: number): Promise<RestartServerResult> {
    // Stop the server first (with isRestart=true to preserve session ID)
    const stopResult = await this.stopServer(workspacePath, true);
    if (!stopResult.success) {
      return {
        success: false,
        error: stopResult.error ?? "Failed to stop server",
        serverStopped: true,
      };
    }

    // Start the server on the same port
    try {
      const newPort = await this.startServerOnPort(workspacePath, port);
      return { success: true, port: newPort };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message, serverStopped: true };
    }
  }

  /**
   * Start an OpenCode server for a workspace on a specific port.
   * Used by restartServer to preserve the same port.
   *
   * @param workspacePath - Absolute path to the workspace
   * @param port - Port number to use
   * @returns Allocated port number
   * @throws Error if server fails to start or health check times out
   */
  private async startServerOnPort(workspacePath: string, port: number): Promise<number> {
    // Spawn server and wait for health check
    const proc = await this.spawnServerOnPort(workspacePath, port);

    // Update the server entry to running state
    this.servers.set(workspacePath, { state: "running", port, process: proc });

    // pid is guaranteed to be defined since spawnServerOnPort validates it
    this.logger.info("Server started", { workspacePath, port, pid: proc.pid! });

    // Fire callback (no pending prompt for restart scenarios)
    for (const callback of this.startedCallbacks) {
      callback(workspacePath, port, undefined);
    }

    return port;
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
    if (entry?.state === "running" || entry?.state === "restarting") {
      return entry.port;
    }
    return undefined;
  }

  /**
   * Check if server is running for a workspace.
   *
   * @param workspacePath - Absolute path to the workspace
   * @returns True if server is running (including during restart)
   */
  isRunning(workspacePath: string): boolean {
    const entry = this.servers.get(workspacePath);
    return entry?.state === "running" || entry?.state === "restarting";
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
   * Get the bridge server port.
   * Returns null if bridge server is not running.
   */
  getBridgePort(): number | null {
    return this.bridgePort;
  }

  /**
   * Subscribe to workspace ready events.
   * Triggered when a wrapper start notification is received,
   * indicating the loading screen should be cleared.
   *
   * @param callback - Callback invoked with workspace path
   * @returns Unsubscribe function
   */
  onWorkspaceReady(callback: WorkspaceReadyCallback): Unsubscribe {
    this.workspaceReadyCallbacks.add(callback);
    return () => this.workspaceReadyCallbacks.delete(callback);
  }

  /**
   * Set handler called when workspace becomes active (WrapperStart).
   * The handler is invoked with the normalized workspace path.
   */
  setMarkActiveHandler(handler: (workspacePath: string) => void): void {
    this.markActiveHandler = handler;
  }

  /**
   * Set the MCP server configuration.
   * This must be called before starting servers if MCP integration is desired.
   *
   * @param config - MCP configuration with config path and port
   */
  setMcpConfig(config: McpConfig): void {
    this.mcpConfig = config;
    this.logger.debug("MCP config set", { port: config.port });
  }

  /**
   * Get the current MCP configuration.
   */
  getMcpConfig(): McpConfig | null {
    return this.mcpConfig;
  }

  /**
   * Store a pending initial prompt to send when the server becomes healthy.
   *
   * @param workspacePath - Absolute path to the workspace
   * @param prompt - The prompt text to send
   * @param agent - Optional agent name to use
   * @param model - Optional model to use
   */
  setPendingPrompt(
    workspacePath: string,
    prompt: string,
    agent?: string,
    model?: PromptModel
  ): void {
    const normalizedPath = new Path(workspacePath).toString();
    // Build object conditionally for exactOptionalPropertyTypes
    const entry: { prompt: string; agent?: string; model?: PromptModel } = { prompt };
    if (agent !== undefined) {
      entry.agent = agent;
    }
    if (model !== undefined) {
      entry.model = model;
    }
    this.pendingPrompts.set(normalizedPath, entry);
    this.logger.debug("Pending prompt stored", {
      workspacePath: normalizedPath,
      promptLength: prompt.length,
      ...(agent !== undefined && { agent }),
      ...(model !== undefined && { model: `${model.providerID}/${model.modelID}` }),
    });
  }

  /**
   * Consume (retrieve and remove) a pending initial prompt.
   *
   * @param workspacePath - Absolute path to the workspace
   * @returns The pending prompt data, or undefined if none exists
   */
  consumePendingPrompt(
    workspacePath: string
  ): { prompt: string; agent?: string; model?: PromptModel } | undefined {
    const normalizedPath = new Path(workspacePath).toString();
    const pending = this.pendingPrompts.get(normalizedPath);
    if (pending) {
      this.pendingPrompts.delete(normalizedPath);
      this.logger.debug("Pending prompt consumed", { workspacePath: normalizedPath });
    }
    return pending;
  }

  /**
   * Start the bridge HTTP server for receiving wrapper notifications.
   * Allocates a port and listens for POST /hook/WrapperStart requests.
   */
  private async startBridgeServer(): Promise<void> {
    const server = createServer((req, res) => {
      this.handleBridgeRequest(req, res);
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        // Use port 0 to let the OS assign a free port
        server.listen(0, "127.0.0.1", () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
    } catch (error) {
      // Reset promise so next attempt can retry
      this.bridgeStartPromise = null;
      throw error;
    }

    // Read the OS-assigned port from the listening server
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : null;
    if (port === null) {
      server.close();
      this.bridgeStartPromise = null;
      throw new Error("Bridge server started but could not determine port");
    }

    this.bridgeServer = server;
    this.bridgePort = port;
    this.logger.info("Bridge server started", { port });
  }

  /**
   * Stop the bridge HTTP server.
   */
  private async stopBridgeServer(): Promise<void> {
    if (this.bridgeServer === null) {
      this.bridgeStartPromise = null;
      return;
    }

    try {
      await new Promise<void>((resolve, reject) => {
        this.bridgeServer!.close((err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    } catch (error) {
      // Bridge server may not have been listening (e.g., listen failed)
      this.logger.warn("Error closing bridge server", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    this.logger.info("Bridge server stopped", { port: this.bridgePort });
    this.bridgeServer = null;
    this.bridgePort = null;
    this.bridgeStartPromise = null;
  }

  /**
   * Handle an incoming bridge HTTP request.
   */
  private handleBridgeRequest(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.bridgePort}`);
    if (url.pathname !== "/hook/WrapperStart") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });

    req.on("end", () => {
      try {
        const payload = JSON.parse(body) as { workspacePath: string };
        const normalizedPath = new Path(payload.workspacePath).toString();

        this.logger.debug("WrapperStart received", { workspacePath: normalizedPath });

        for (const callback of this.workspaceReadyCallbacks) {
          callback(normalizedPath);
        }

        this.markActiveHandler?.(normalizedPath);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
      } catch (error) {
        this.logger.warn("Failed to parse bridge payload", {
          error: error instanceof Error ? error.message : String(error),
        });
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON body" }));
      }
    });

    req.on("error", (error) => {
      this.logger.warn("Bridge request error", { error: error.message });
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal error" }));
    });
  }

  /**
   * Dispose the manager, stopping all servers.
   */
  async dispose(): Promise<void> {
    const workspaces = [...this.servers.keys()];
    await Promise.all(workspaces.map((path) => this.stopServer(path)));
    this.startedCallbacks.clear();
    this.stoppedCallbacks.clear();
    this.workspaceReadyCallbacks.clear();
    this.markActiveHandler = null;
    await this.stopBridgeServer();
  }
}
