/**
 * Claude Code Server Manager - manages a single HTTP bridge server for all workspaces.
 *
 * Unlike OpenCode (one server per workspace), Claude Code uses one HTTP server
 * for all workspaces. The server receives hook notifications from Claude CLI
 * and routes them to the correct workspace based on the workspacePath in the payload.
 *
 * The HTTP server:
 * - Listens for POST /hook/:hookName requests from hook-handler.js
 * - Routes status updates to the correct workspace based on workspacePath in body
 * - Updates workspace status according to HOOK_STATUS_MAP
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "http";
import type { PortManager } from "../../services/platform/network";
import type { PathProvider } from "../../services/platform/path-provider";
import type { FileSystemLayer } from "../../services/platform/filesystem";
import type { Logger } from "../../services/logging";
import type {
  AgentServerManager,
  StopServerResult,
  RestartServerResult,
  AgentStatus,
} from "../types";
import { Path } from "../../services/platform/path";
import {
  type ClaudeCodeHookName,
  type ClaudeCodeBridgePayload,
  isValidHookName,
  getStatusChangeForHook,
} from "./types";
import hooksConfigTemplate from "./hooks.template.json";
import mcpConfigTemplate from "./mcp.template.json";
import type { NormalizedInitialPrompt } from "../../shared/api/types";

/**
 * Per-workspace state tracked by the server manager.
 */
export interface WorkspaceState {
  /** Current agent status */
  status: AgentStatus;
  /** Current session ID (from SessionStart hook) */
  sessionId?: string;
  /** Callbacks for status changes */
  statusCallbacks: Set<(status: AgentStatus) => void>;
  /** Flag set after PermissionRequest, cleared on PreToolUse */
  awaitingPermissionResolution?: boolean;
  /** Path to the initial prompt file (for getInitialPromptPath) */
  initialPromptPath?: Path;
}

/**
 * Callback for server started events.
 */
export type ServerStartedCallback = (workspacePath: string, port: number) => void;

/**
 * Callback for server stopped events.
 */
export type ServerStoppedCallback = (workspacePath: string, isRestart: boolean) => void;

/**
 * Callback for workspace ready events.
 * Triggered when status changes to idle, indicating the workspace
 * should be marked as loaded (clear loading screen).
 */
export type WorkspaceReadyCallback = (workspacePath: string) => void;

/**
 * Configuration for ClaudeCodeServerManager.
 */
export interface ClaudeCodeServerManagerConfig {
  /** Path to the hook-handler.js script */
  readonly hookHandlerPath?: string;
}

/**
 * MCP server configuration for Claude Code integration.
 */
export interface McpConfig {
  /** MCP server port */
  readonly port: number;
}

/**
 * Dependencies for ClaudeCodeServerManager.
 */
export interface ClaudeCodeServerManagerDeps {
  readonly portManager: PortManager;
  readonly pathProvider: PathProvider;
  readonly fileSystem: FileSystemLayer;
  readonly logger: Logger;
  readonly config?: ClaudeCodeServerManagerConfig;
}

/**
 * Claude Code Server Manager implementation.
 *
 * Key differences from OpenCode:
 * - Single HTTP server for ALL workspaces
 * - Hooks include workspacePath to route to correct workspace
 * - Status changes come from hooks, not SSE events
 */
export class ClaudeCodeServerManager implements AgentServerManager {
  private readonly portManager: PortManager;
  private readonly pathProvider: PathProvider;
  private readonly fileSystem: FileSystemLayer;
  private readonly logger: Logger;
  private readonly hookHandlerPath: string;

  /** Single HTTP server for all workspaces */
  private httpServer: Server | null = null;
  /** Port the server is listening on */
  private port: number | null = null;

  /** Per-workspace state */
  private readonly workspaces = new Map<string, WorkspaceState>();

  /** Callbacks for lifecycle events */
  private readonly startedCallbacks = new Set<ServerStartedCallback>();
  private readonly stoppedCallbacks = new Set<ServerStoppedCallback>();
  private readonly workspaceReadyCallbacks = new Set<WorkspaceReadyCallback>();

  /** MCP configuration (set before starting servers) */
  private mcpConfig: McpConfig | null = null;

  constructor(deps: ClaudeCodeServerManagerDeps) {
    this.portManager = deps.portManager;
    this.pathProvider = deps.pathProvider;
    this.fileSystem = deps.fileSystem;
    this.logger = deps.logger;

    // Default hook handler path uses runtime dir (outside ASAR in production)
    // Use toString() for POSIX-style paths - works on all platforms including Windows
    this.hookHandlerPath =
      deps.config?.hookHandlerPath ?? this.pathProvider.claudeCodeHookHandlerPath.toString();
  }

  /**
   * Start tracking a workspace.
   * Starts the HTTP server if this is the first workspace.
   *
   * @param workspacePath - Absolute path to the workspace
   * @returns Port number of the bridge server
   */
  async startServer(workspacePath: string): Promise<number> {
    // Normalize workspace path
    const normalizedPath = new Path(workspacePath).toString();

    // Check if workspace is already registered
    if (this.workspaces.has(normalizedPath)) {
      if (this.port === null) {
        throw new Error("Workspace registered but server not running - invalid state");
      }
      return this.port;
    }

    // Start HTTP server if this is the first workspace
    if (this.httpServer === null) {
      await this.startHttpServer();
    }

    // Register workspace
    this.workspaces.set(normalizedPath, {
      status: "none",
      statusCallbacks: new Set(),
    });

    // Generate config files for this workspace
    await this.generateConfigFiles(normalizedPath);

    this.logger.info("Workspace registered", { workspacePath: normalizedPath, port: this.port });

    // Fire started callback
    for (const callback of this.startedCallbacks) {
      callback(normalizedPath, this.port!);
    }

    return this.port!;
  }

  /**
   * Stop tracking a workspace.
   * Stops the HTTP server if this is the last workspace.
   *
   * @param workspacePath - Absolute path to the workspace
   * @param isRestart - True if this is part of a restart operation
   * @returns StopServerResult
   */
  async stopServer(workspacePath: string, isRestart = false): Promise<StopServerResult> {
    const normalizedPath = new Path(workspacePath).toString();

    // Check if workspace is registered
    if (!this.workspaces.has(normalizedPath)) {
      return { success: true };
    }

    // Remove workspace
    this.workspaces.delete(normalizedPath);

    // Fire stopped callback
    for (const callback of this.stoppedCallbacks) {
      callback(normalizedPath, isRestart);
    }

    this.logger.info("Workspace unregistered", { workspacePath: normalizedPath, isRestart });

    // Stop HTTP server if no more workspaces
    if (this.workspaces.size === 0 && this.httpServer !== null) {
      await this.stopHttpServer();
    }

    return { success: true };
  }

  /**
   * Restart tracking for a workspace.
   * Regenerates config files.
   *
   * @param workspacePath - Absolute path to the workspace
   * @returns RestartServerResult
   */
  async restartServer(workspacePath: string): Promise<RestartServerResult> {
    const normalizedPath = new Path(workspacePath).toString();

    // Check if workspace is registered
    if (!this.workspaces.has(normalizedPath)) {
      return {
        success: false,
        error: "Workspace not registered",
        serverStopped: false,
      };
    }

    // Stop and restart the workspace (preserving status callbacks)
    const state = this.workspaces.get(normalizedPath)!;
    const savedCallbacks = state.statusCallbacks;

    // Fire stopped callback with isRestart=true
    for (const callback of this.stoppedCallbacks) {
      callback(normalizedPath, true);
    }

    // Reset state but preserve callbacks
    this.workspaces.set(normalizedPath, {
      status: "none",
      statusCallbacks: savedCallbacks,
    });

    // Regenerate config files
    await this.generateConfigFiles(normalizedPath);

    // Fire started callback
    for (const callback of this.startedCallbacks) {
      callback(normalizedPath, this.port!);
    }

    this.logger.info("Workspace restarted", { workspacePath: normalizedPath, port: this.port });

    return { success: true, port: this.port! };
  }

  /**
   * Check if a workspace is being tracked.
   *
   * @param workspacePath - Absolute path to the workspace
   * @returns True if workspace is registered
   */
  isRunning(workspacePath: string): boolean {
    const normalizedPath = new Path(workspacePath).toString();
    return this.workspaces.has(normalizedPath);
  }

  /**
   * Get the bridge server port.
   * Returns the same port for all workspaces.
   *
   * @param workspacePath - Absolute path to the workspace
   * @returns Port number or undefined if workspace not registered
   */
  getPort(workspacePath: string): number | undefined {
    const normalizedPath = new Path(workspacePath).toString();
    if (!this.workspaces.has(normalizedPath)) {
      return undefined;
    }
    return this.port ?? undefined;
  }

  /**
   * Stop all workspaces for a project.
   *
   * @param projectPath - Absolute path to the project
   */
  async stopAllForProject(projectPath: string): Promise<void> {
    const normalizedProjectPath = new Path(projectPath).toString();
    const workspacesToStop = [...this.workspaces.keys()].filter((path) =>
      path.startsWith(normalizedProjectPath)
    );

    await Promise.all(workspacesToStop.map((path) => this.stopServer(path)));
  }

  /**
   * Subscribe to server started events.
   */
  onServerStarted(callback: ServerStartedCallback): () => void {
    this.startedCallbacks.add(callback);
    return () => this.startedCallbacks.delete(callback);
  }

  /**
   * Subscribe to server stopped events.
   */
  onServerStopped(callback: ServerStoppedCallback): () => void {
    this.stoppedCallbacks.add(callback);
    return () => this.stoppedCallbacks.delete(callback);
  }

  /**
   * Subscribe to workspace ready events.
   * Triggered when status changes to idle (from WrapperStart or SessionStart),
   * indicating the loading screen should be cleared.
   *
   * @param callback - Callback invoked with workspace path
   * @returns Unsubscribe function
   */
  onWorkspaceReady(callback: WorkspaceReadyCallback): () => void {
    this.workspaceReadyCallbacks.add(callback);
    return () => this.workspaceReadyCallbacks.delete(callback);
  }

  /**
   * Subscribe to status changes for a specific workspace.
   *
   * @param workspacePath - Absolute path to the workspace
   * @param callback - Callback invoked on status change
   * @returns Unsubscribe function
   */
  onStatusChange(workspacePath: string, callback: (status: AgentStatus) => void): () => void {
    const normalizedPath = new Path(workspacePath).toString();
    const state = this.workspaces.get(normalizedPath);

    if (!state) {
      // Return no-op if workspace not registered
      return () => {};
    }

    state.statusCallbacks.add(callback);
    return () => state.statusCallbacks.delete(callback);
  }

  /**
   * Get the current status for a workspace.
   *
   * @param workspacePath - Absolute path to the workspace
   * @returns Current status or "none" if not registered
   */
  getStatus(workspacePath: string): AgentStatus {
    const normalizedPath = new Path(workspacePath).toString();
    return this.workspaces.get(normalizedPath)?.status ?? "none";
  }

  /**
   * Get the session ID for a workspace.
   *
   * @param workspacePath - Absolute path to the workspace
   * @returns Session ID or undefined
   */
  getSessionId(workspacePath: string): string | undefined {
    const normalizedPath = new Path(workspacePath).toString();
    return this.workspaces.get(normalizedPath)?.sessionId;
  }

  /**
   * Set the MCP configuration.
   * Must be called before starting servers for MCP integration.
   *
   * @param config - MCP configuration
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
   * Set the initial prompt for a workspace.
   * Creates a temp directory and writes the prompt config to a JSON file.
   * The wrapper script will read and delete this file on first invocation.
   *
   * @param workspacePath - Absolute path to the workspace
   * @param config - Normalized initial prompt configuration
   */
  async setInitialPrompt(workspacePath: string, config: NormalizedInitialPrompt): Promise<void> {
    const normalizedPath = new Path(workspacePath).toString();
    const state = this.workspaces.get(normalizedPath);

    if (!state) {
      this.logger.warn("setInitialPrompt called for unknown workspace", {
        workspacePath: normalizedPath,
      });
      return;
    }

    try {
      // Create temp directory for the initial prompt file
      const tempDir = await this.fileSystem.mkdtemp("codehydra-initial-prompt-");

      // Build JSON content - extract modelID from model if present
      const jsonContent: { prompt: string; model?: string; agent?: string } = {
        prompt: config.prompt,
      };
      if (config.model !== undefined) {
        jsonContent.model = config.model.modelID;
      }
      if (config.agent !== undefined) {
        jsonContent.agent = config.agent;
      }

      // Write the initial prompt file
      const promptFilePath = new Path(tempDir, "initial-prompt.json");
      await this.fileSystem.writeFile(promptFilePath, JSON.stringify(jsonContent, null, 2));

      // Store the path for later retrieval
      state.initialPromptPath = promptFilePath;

      this.logger.info("Initial prompt file created", {
        workspacePath: normalizedPath,
        path: promptFilePath.toString(),
      });
    } catch (error) {
      this.logger.error(
        "Failed to create initial prompt file",
        { workspacePath: normalizedPath },
        error instanceof Error ? error : undefined
      );
      // Don't throw - initial prompt is optional, workspace should still work
    }
  }

  /**
   * Get the path to the initial prompt file for a workspace.
   * Returns undefined if no initial prompt was set.
   *
   * @param workspacePath - Absolute path to the workspace
   * @returns Path to the initial prompt file, or undefined
   */
  getInitialPromptPath(workspacePath: string): Path | undefined {
    const normalizedPath = new Path(workspacePath).toString();
    return this.workspaces.get(normalizedPath)?.initialPromptPath;
  }

  /**
   * Dispose the server manager, stopping all workspaces and the HTTP server.
   */
  async dispose(): Promise<void> {
    // Stop all workspaces
    const workspaces = [...this.workspaces.keys()];
    await Promise.all(workspaces.map((path) => this.stopServer(path)));

    // Stop HTTP server if still running
    if (this.httpServer !== null) {
      await this.stopHttpServer();
    }

    // Clear callbacks
    this.startedCallbacks.clear();
    this.stoppedCallbacks.clear();
    this.workspaceReadyCallbacks.clear();
  }

  /**
   * Start the HTTP bridge server.
   */
  private async startHttpServer(): Promise<void> {
    // Allocate a port
    this.port = await this.portManager.findFreePort();

    // Create HTTP server
    this.httpServer = createServer((req, res) => {
      this.handleRequest(req, res);
    });

    // Start listening (port is guaranteed to be set from findFreePort above)
    const port = this.port;
    await new Promise<void>((resolve, reject) => {
      this.httpServer!.once("error", reject);
      this.httpServer!.listen(port, "127.0.0.1", () => {
        this.httpServer!.removeListener("error", reject);
        resolve();
      });
    });

    this.logger.info("Bridge server started", { port: this.port });
  }

  /**
   * Stop the HTTP bridge server.
   */
  private async stopHttpServer(): Promise<void> {
    if (this.httpServer === null) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.close((err) => {
        if (err) {
          this.logger.warn("Error closing bridge server", { error: err.message });
          reject(err);
        } else {
          resolve();
        }
      });
    });

    this.logger.info("Bridge server stopped", { port: this.port });
    this.httpServer = null;
    this.port = null;
  }

  /**
   * Handle an incoming HTTP request.
   */
  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    // Only accept POST requests
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    // Parse URL to get hook name
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
    const pathMatch = url.pathname.match(/^\/hook\/([^/]+)$/);

    if (!pathMatch) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    const hookName = pathMatch[1]!;

    // Validate hook name
    if (!isValidHookName(hookName)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Unknown hook: ${hookName}` }));
      return;
    }

    // Read request body
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });

    req.on("end", () => {
      try {
        const payload = JSON.parse(body) as ClaudeCodeBridgePayload;
        this.handleHook(hookName, payload);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
      } catch (error) {
        this.logger.warn("Failed to parse hook payload", {
          hookName,
          error: error instanceof Error ? error.message : String(error),
        });
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON body" }));
      }
    });

    req.on("error", (error) => {
      this.logger.warn("Request error", { hookName, error: error.message });
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal error" }));
    });
  }

  /**
   * Handle a hook notification.
   */
  private handleHook(hookName: ClaudeCodeHookName, payload: ClaudeCodeBridgePayload): void {
    this.logger.silly("Hook payload received", { hookName, payload: JSON.stringify(payload) });

    const { workspacePath, session_id } = payload;

    // Normalize workspace path
    const normalizedPath = new Path(workspacePath).toString();

    // Find workspace state
    const state = this.workspaces.get(normalizedPath);
    if (!state) {
      this.logger.warn("Hook received for unknown workspace", {
        hookName,
        workspacePath: normalizedPath,
      });
      return;
    }

    // Update session ID if present
    if (session_id) {
      state.sessionId = session_id;
    }

    // Determine status change for this hook
    let newStatus = getStatusChangeForHook(hookName);

    // Special handling for permission resolution flow:
    // PermissionRequest sets flag, PreToolUse clears it and transitions to busy
    if (hookName === "PermissionRequest") {
      state.awaitingPermissionResolution = true;
    } else if (hookName === "PreToolUse" && state.awaitingPermissionResolution) {
      state.awaitingPermissionResolution = false;
      newStatus = "busy";
    }

    this.logger.debug("Hook received", {
      hookName,
      workspacePath: normalizedPath,
      currentStatus: state.status,
      newStatus: newStatus ?? "(no change)",
    });

    // Update status if hook causes a change
    if (newStatus !== null && newStatus !== state.status) {
      const oldStatus = state.status;
      state.status = newStatus;

      this.logger.info("Status changed", {
        workspacePath: normalizedPath,
        from: oldStatus,
        to: newStatus,
        hookName,
      });

      // Notify subscribers
      for (const callback of state.statusCallbacks) {
        callback(newStatus);
      }

      // When status becomes idle, notify workspace is ready (clears loading screen)
      if (newStatus === "idle") {
        for (const callback of this.workspaceReadyCallbacks) {
          callback(normalizedPath);
        }
      }
    }
  }

  /**
   * Generate config files for a workspace.
   * Creates both hooks.json and mcp.json in the workspace's config directory.
   */
  private async generateConfigFiles(workspacePath: string): Promise<void> {
    // Config directory is in the app data, not in the workspace
    // Using a hash of workspace path to make it unique
    const configDir = new Path(this.pathProvider.dataRootDir, "claude", "configs");

    // Generate a safe directory name from workspace path
    const safeWorkspaceName = this.getConfigDirName(workspacePath);
    const workspaceConfigDir = new Path(configDir, safeWorkspaceName);

    // Ensure config directory exists
    await this.fileSystem.mkdir(workspaceConfigDir);

    // Variables for template substitution
    const variables: Record<string, string> = {
      HOOK_HANDLER_PATH: this.hookHandlerPath,
      BRIDGE_PORT: String(this.port),
      WORKSPACE_PATH: workspacePath,
      MCP_PORT: String(this.mcpConfig?.port ?? 0),
    };

    // Generate hooks config
    const hooksConfigPath = new Path(workspaceConfigDir, "codehydra-hooks.json");
    await this.generateHooksConfig(hooksConfigPath, variables);

    // Generate MCP config
    const mcpConfigPath = new Path(workspaceConfigDir, "codehydra-mcp.json");
    await this.generateMcpConfig(mcpConfigPath, variables);

    this.logger.debug("Config files generated", {
      workspacePath,
      configDir: workspaceConfigDir.toString(),
    });
  }

  /**
   * Generate a safe directory name for workspace configs.
   * Uses a hash to avoid path length issues and special characters.
   */
  private getConfigDirName(workspacePath: string): string {
    // Simple hash function for workspace path
    let hash = 0;
    for (let i = 0; i < workspacePath.length; i++) {
      const char = workspacePath.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32bit integer
    }

    // Get the last component of the path for readability
    const pathObj = new Path(workspacePath);
    const basename = pathObj.basename;

    // Combine basename with hash for uniqueness and readability
    return `${basename}-${Math.abs(hash).toString(16)}`;
  }

  /**
   * Generate hooks config file from template.
   */
  private async generateHooksConfig(
    targetPath: Path,
    variables: Record<string, string>
  ): Promise<void> {
    let content = JSON.stringify(hooksConfigTemplate, null, 2);

    // Substitute variables
    for (const [key, value] of Object.entries(variables)) {
      const pattern = new RegExp(`\\$\\{${key}\\}`, "g");
      content = content.replace(pattern, value);
    }

    await this.fileSystem.writeFile(targetPath, content);
  }

  /**
   * Generate MCP config file from template.
   */
  private async generateMcpConfig(
    targetPath: Path,
    variables: Record<string, string>
  ): Promise<void> {
    let content = JSON.stringify(mcpConfigTemplate, null, 2);

    // Substitute variables
    for (const [key, value] of Object.entries(variables)) {
      const pattern = new RegExp(`\\$\\{${key}\\}`, "g");
      content = content.replace(pattern, value);
    }

    await this.fileSystem.writeFile(targetPath, content);
  }

  /**
   * Get the path to the hooks config file for a workspace.
   * This is used by the Provider to set environment variables.
   */
  getHooksConfigPath(workspacePath: string): Path {
    const normalizedPath = new Path(workspacePath).toString();
    const safeWorkspaceName = this.getConfigDirName(normalizedPath);
    return new Path(
      this.pathProvider.dataRootDir,
      "claude",
      "configs",
      safeWorkspaceName,
      "codehydra-hooks.json"
    );
  }

  /**
   * Get the path to the MCP config file for a workspace.
   * This is used by the Provider to set environment variables.
   */
  getMcpConfigPath(workspacePath: string): Path {
    const normalizedPath = new Path(workspacePath).toString();
    const safeWorkspaceName = this.getConfigDirName(normalizedPath);
    return new Path(
      this.pathProvider.dataRootDir,
      "claude",
      "configs",
      safeWorkspaceName,
      "codehydra-mcp.json"
    );
  }
}
