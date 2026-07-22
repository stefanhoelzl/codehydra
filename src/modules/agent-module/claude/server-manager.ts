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
import type { PortManager } from "../../../boundaries/platform/network";
import type { PathProvider } from "../../../boundaries/platform/path-provider";
import type { FileSystemBoundary } from "../../../boundaries/platform/filesystem";
import type { Logger } from "../../../boundaries/platform/logging";
import type {
  AgentServerManager,
  StopServerResult,
  RestartServerResult,
  AgentStatus,
  McpConfig,
  AgentPromptConfig,
} from "../types";
import { Path } from "../../../utils/path/path";
import {
  type ClaudeCodeHookName,
  type ClaudeCodeBridgePayload,
  isValidHookName,
  getStatusChangeForHook,
  taskKeepsBusy,
  WRAPPER_HOOK_NAMES,
} from "./types";
import hooksConfigTemplate from "./hooks.template.json";
import mcpConfigTemplate from "./mcp.template.json";

/** Node reports ERR_SERVER_NOT_RUNNING when close() is called on a server that is already down. */
function isServerNotRunning(error: Error): boolean {
  return (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING";
}

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
  /**
   * Flag set while the workspace is parked on an AskUserQuestion (the main agent
   * is blocked on the user). Set by PreToolUse(AskUserQuestion), cleared by
   * PostToolUse(AskUserQuestion). While set, busy transitions from concurrent
   * sub-agent tool activity on this shared workspace bridge are suppressed so the
   * workspace stays idle until the user answers.
   */
  awaitingUserInputResolution?: boolean;
  /** Flag set when PreCompact arrives while busy, cleared on SessionStart */
  ignoreNextSessionStart?: boolean;
  /** Path to the initial prompt file (for getInitialPromptPath) */
  initialPromptPath?: Path;
  /** Path to the no-session marker file (for getNoSessionMarkerPath) */
  noSessionMarkerPath?: Path;
  /** Flag: first WrapperStart should set status to busy (a non-empty initial prompt) */
  busyOnWrapperStart?: boolean;
  /**
   * True when the last Stop was suppressed because background tasks keep the
   * workspace busy — running shells and/or background sub-agents, read from the
   * Stop payload's background_tasks. Also suppresses the ~60s-lagging idle_prompt.
   */
  busyForBackgroundTasks?: boolean;
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
 * Configuration for ClaudeCodeServerManager.
 */
export interface ClaudeCodeServerManagerConfig {
  /** Path to the hook-handler.js script */
  readonly hookHandlerPath?: string;
}

/**
 * Dependencies for ClaudeCodeServerManager.
 */
export interface ClaudeCodeServerManagerDeps {
  readonly portManager: PortManager;
  readonly pathProvider: PathProvider;
  readonly fileSystem: FileSystemBoundary;
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
  private readonly fileSystem: FileSystemBoundary;
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

  /** Handler called when workspace becomes active (first idle) */
  private markActiveHandler: ((workspacePath: string) => void) | null = null;

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
      deps.config?.hookHandlerPath ??
      this.pathProvider.runtimePath("bin/claude-code-hook-handler.cjs").toString();
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
   * Set handler called when workspace becomes active (first idle).
   * The handler is invoked with the normalized workspace path.
   */
  setMarkActiveHandler(handler: (workspacePath: string) => void): void {
    this.markActiveHandler = handler;
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
   * @param config - Resolved agent launch configuration
   */
  async setInitialPrompt(workspacePath: string, config: AgentPromptConfig): Promise<void> {
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
      const jsonContent: {
        prompt: string;
        model?: string;
        permissionMode?: string;
        agentName?: string;
      } = {
        prompt: config.prompt ?? "",
      };
      if (config.model !== undefined) {
        jsonContent.model = config.model.modelID;
      }
      if (config.permissionMode !== undefined) {
        jsonContent.permissionMode = config.permissionMode;
      }
      if (config.agentName !== undefined) {
        jsonContent.agentName = config.agentName;
      }

      // Write the initial prompt file
      const promptFilePath = new Path(tempDir, "initial-prompt.json");
      await this.fileSystem.writeFile(promptFilePath, JSON.stringify(jsonContent, null, 2));

      // Store the path for later retrieval
      state.initialPromptPath = promptFilePath;

      // Show "busy" on the first WrapperStart only when there is a prompt for
      // the agent to process. Permission mode is irrelevant (even plan mode
      // works on the prompt); an empty prompt (e.g. only an agent or permission
      // mode was chosen) has nothing to run, so it starts "idle".
      state.busyOnWrapperStart = (config.prompt ?? "").trim() !== "";

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
   * Create a no-session marker file for a new workspace.
   * The marker tells the wrapper to skip --continue on first launch.
   * It is deleted by the wrapper on first invocation so subsequent runs
   * will attempt session resume.
   *
   * @param workspacePath - Absolute path to the workspace
   */
  async setNoSessionMarker(workspacePath: string): Promise<void> {
    const normalizedPath = new Path(workspacePath).toString();
    const state = this.workspaces.get(normalizedPath);

    if (!state) {
      this.logger.warn("setNoSessionMarker called for unknown workspace", {
        workspacePath: normalizedPath,
      });
      return;
    }

    try {
      const markerDir = this.pathProvider.tempPath("claude/no-session");
      await this.fileSystem.mkdir(markerDir);

      const safeWorkspaceName = this.getConfigDirName(normalizedPath);
      const markerPath = new Path(markerDir, safeWorkspaceName);
      await this.fileSystem.writeFile(markerPath, "");

      state.noSessionMarkerPath = markerPath;

      this.logger.debug("No-session marker created", {
        workspacePath: normalizedPath,
        path: markerPath.toString(),
      });
    } catch (error) {
      this.logger.error(
        "Failed to create no-session marker",
        { workspacePath: normalizedPath },
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Get the path to the no-session marker file for a workspace.
   * Returns undefined if no marker was set.
   *
   * @param workspacePath - Absolute path to the workspace
   * @returns Path to the marker file, or undefined
   */
  getNoSessionMarkerPath(workspacePath: string): Path | undefined {
    const normalizedPath = new Path(workspacePath).toString();
    return this.workspaces.get(normalizedPath)?.noSessionMarkerPath;
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
    this.markActiveHandler = null;
  }

  /**
   * Start the HTTP bridge server.
   */
  private async startHttpServer(): Promise<void> {
    const server = createServer((req, res) => {
      this.handleRequest(req, res);
    });

    // Bind and discover the port in one step. Asking for a free port first and
    // binding it afterwards loses the port between the two: the probe socket is
    // still being torn down by the kernel, so listen() can fail with EADDRINUSE.
    try {
      this.port = await this.portManager.listenOnFreePort(server, "127.0.0.1");
    } catch (error) {
      // Leave no half-started server behind: dispose() would later call close()
      // on a handle-less server and reject with ERR_SERVER_NOT_RUNNING.
      this.httpServer = null;
      this.port = null;
      throw error;
    }

    this.httpServer = server;
    this.logger.info("Bridge server started", { port: this.port });
  }

  /**
   * Stop the HTTP bridge server.
   */
  private async stopHttpServer(): Promise<void> {
    const server = this.httpServer;
    if (server === null) {
      return;
    }

    const port = this.port;
    // Drop the references first: whatever happens below, this manager must not
    // keep pointing at a server it has already closed.
    this.httpServer = null;
    this.port = null;

    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        // A server that is already down is the state we wanted anyway.
        if (err && !isServerNotRunning(err)) {
          this.logger.warn("Error closing bridge server", { error: err.message });
          reject(err);
        } else {
          resolve();
        }
      });
    });

    this.logger.info("Bridge server stopped", { port });
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

    // WrapperStart/WrapperEnd are no longer accepted over HTTP — they are driven
    // by the sidekick via triggerWrapperLifecycle(). Reject stray POSTs.
    if (WRAPPER_HOOK_NAMES.has(hookName)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Hook not accepted over HTTP: ${hookName}` }));
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
   * Trigger a wrapper lifecycle transition for a workspace.
   *
   * Replaces the wrapper's HTTP POST of WrapperStart/WrapperEnd: invoked via the
   * agent:lifecycle intent when the sidekick reports the agent terminal opening
   * ("WrapperStart") or closing ("WrapperEnd"). Routes through the same state
   * machine as all other hooks (status, markActive, subagent cleanup).
   * Idempotent and a no-op for unknown workspaces.
   */
  triggerWrapperLifecycle(workspacePath: string, hookName: "WrapperStart" | "WrapperEnd"): void {
    this.handleHook(hookName, { workspacePath });
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
      this.logger.silly("Hook received for unknown workspace", {
        hookName,
        workspacePath: normalizedPath,
      });
      return;
    }

    // Update session ID if present
    if (session_id) {
      state.sessionId = session_id;
    }

    // A Stop/StopFailure carrying an agent_id is a *sub-agent's* turn end, not the
    // main agent's (the main agent's Stop has no agent_id). Sub-agent turn-ends
    // must not drive the workspace status — the main agent's own Stop does that,
    // and background sub-agents are already reflected in that Stop's
    // background_tasks. Ignore it entirely.
    if ((hookName === "Stop" || hookName === "StopFailure") && payload.agent_id) {
      this.logger.silly("Ignoring sub-agent Stop for main status", {
        hookName,
        workspacePath: normalizedPath,
        agentId: payload.agent_id,
      });
      return;
    }

    // Determine status change for this hook
    let newStatus = getStatusChangeForHook(hookName);

    // When a workspace has a non-plan initial prompt, override WrapperStart and
    // SessionStart to busy so there is no idle blip before UserPromptSubmit.
    if (state.busyOnWrapperStart && (hookName === "WrapperStart" || hookName === "SessionStart")) {
      newStatus = "busy";
      if (hookName === "SessionStart") {
        state.busyOnWrapperStart = false;
      }
    }

    // A tool starting while the workspace reads idle means the agent is
    // actually working — flip to busy. Two paths reach here:
    //  1. Permission resolution: PermissionRequest transitioned us to idle
    //     (waiting for the user); once approved, the tool runs.
    //  2. Bash-mode ("!cmd") turns: Claude Code runs a user-typed shell command
    //     without emitting UserPromptSubmit, so the ensuing agent turn never
    //     flipped to busy. The first tool call is the earliest reliable signal
    //     that the agent is working. (A text-only reply has no hook and can't
    //     be caught here.)
    // PreToolUse while already busy (normal mid-turn tool use) is a no-op.
    if (hookName === "PreToolUse" && state.status === "idle") {
      newStatus = "busy";
    }

    // AskUserQuestion parks the workspace on the user: the main agent is blocked
    // until the user answers. It surfaces as a normal tool
    // (PreToolUse → PermissionRequest → PostToolUse, all tool_name
    // "AskUserQuestion"), but the generic handling above can't cope when
    // sub-agents run concurrently:
    //  - the "PreToolUse while idle → busy" rule would un-park us the moment a
    //    *sub-agent's* tool call fires, not the user's answer;
    //  - concurrent sub-agent tool calls emit PostToolUse (→busy) on this same
    //    workspace bridge, which would immediately overwrite the idle.
    // So we bracket it explicitly: PreToolUse(AskUserQuestion) parks (→idle),
    // PostToolUse(AskUserQuestion) unparks (→busy); while parked, every busy
    // transition is suppressed (guard near the end of this method). This block
    // runs after the generalized PreToolUse rule so the park wins.
    if (hookName === "PreToolUse" && payload.tool_name === "AskUserQuestion") {
      state.awaitingUserInputResolution = true;
      newStatus = "idle";
    } else if (
      (hookName === "PostToolUse" || hookName === "PostToolUseFailure") &&
      payload.tool_name === "AskUserQuestion"
    ) {
      // Unpark on either outcome (answered or cancelled/errored) so the flag can
      // never get stuck and keep the workspace suppressed to idle.
      state.awaitingUserInputResolution = false;
      newStatus = "busy";
    }

    // Special handling for compaction flow:
    // PreCompact while busy sets flag (automatic compaction mid-turn).
    // Stop/StopFailure between PreCompact and SessionStart is suppressed so the
    // workspace doesn't blip to idle while compaction is running.
    // SessionStart during compaction stays busy instead of going idle.
    // Manual /compact starts from idle, so flag is NOT set and SessionStart goes idle normally.
    // Terminal hooks (WrapperEnd, SessionEnd) clear the flag as defensive cleanup.
    if (hookName === "PreCompact" && state.status === "busy") {
      state.ignoreNextSessionStart = true;
    } else if (
      (hookName === "Stop" || hookName === "StopFailure") &&
      state.ignoreNextSessionStart
    ) {
      newStatus = null;
    } else if (hookName === "SessionStart" && state.ignoreNextSessionStart) {
      state.ignoreNextSessionStart = false;
      newStatus = "busy";
    } else if (
      (hookName === "WrapperEnd" || hookName === "SessionEnd") &&
      state.ignoreNextSessionStart
    ) {
      state.ignoreNextSessionStart = false;
    }

    // Notification types that indicate the agent is waiting for user input.
    // idle_prompt: agent is at its idle prompt (recovers from failed compaction).
    // permission_prompt: agent is waiting for permission (redundant with PermissionRequest).
    // elicitation_dialog: agent is waiting for MCP elicitation input.
    if (
      hookName === "Notification" &&
      (payload.notification_type === "idle_prompt" ||
        payload.notification_type === "permission_prompt" ||
        payload.notification_type === "elicitation_dialog")
    ) {
      // idle_prompt fires ~60s after the main thread goes quiet — which also
      // happens while the main agent waits on background tasks (a running shell
      // or a background sub-agent). When the preceding Stop was suppressed for
      // that reason (busyForBackgroundTasks), this idle_prompt is just its
      // lagging echo, so suppress it too and stay busy. The other two types
      // genuinely need the user, so they still transition to idle.
      if (payload.notification_type === "idle_prompt" && state.busyForBackgroundTasks) {
        newStatus = null;
        this.logger.debug("Idle suppressed for background tasks", {
          workspacePath: normalizedPath,
        });
      } else {
        newStatus = "idle";
        state.ignoreNextSessionStart = false;
      }
    }

    // Sub-agent status is derived from the Stop payload's background_tasks below
    // (background sub-agents surface there as type "subagent"), so SubagentStart/
    // SubagentStop no longer drive status — they stay subscribed for logging only.
    // A synchronous sub-agent runs nested inside its parent Agent tool call, so
    // no Stop fires while it runs and the workspace stays busy from the tool.

    // Background task handling: the Stop payload carries background_tasks — the
    // live list of still-running background work (shells and background
    // sub-agents). taskKeepsBusy() decides which keep the workspace busy:
    // sub-agents always do; shells do by default, unless invoked through the
    // `ch-bg` wrapper (its marker in the command opts the shell out). When any
    // qualifies, the idle transition is suppressed and the decision is stashed so
    // the ~60s-later idle_prompt Notification (handled above) stays suppressed
    // too. When a task finishes, Claude Code re-invokes the agent
    // (UserPromptSubmit), which clears the stash — the next Stop re-evaluates from
    // fresh ground truth. PermissionRequest is deliberately NOT suppressed.
    //
    // StopFailure carries no background_tasks (it's an API error — rate limit,
    // auth, max-tokens — and the payload omits the field), so it always goes idle
    // to surface the stuck main agent regardless of background work; clear the
    // stash there.
    if (hookName === "Stop") {
      const tasks = Array.isArray(payload.background_tasks) ? payload.background_tasks : [];
      const busyTasks = tasks.filter((task) => taskKeepsBusy(task));
      state.busyForBackgroundTasks = busyTasks.length > 0;
      if (busyTasks.length > 0) {
        newStatus = null;
        this.logger.debug("Idle suppressed for background tasks", {
          workspacePath: normalizedPath,
          tasks: busyTasks.map((task) => task.command ?? task.agent_type ?? task.type).join(", "),
        });
      }
    } else if (hookName === "StopFailure") {
      state.busyForBackgroundTasks = false;
    }
    if (hookName === "UserPromptSubmit") {
      state.busyForBackgroundTasks = false;
      state.awaitingUserInputResolution = false;
    }

    // Terminal hooks clear background-task state as defensive cleanup
    if (hookName === "WrapperEnd" || hookName === "SessionEnd") {
      state.busyForBackgroundTasks = false;
      state.awaitingUserInputResolution = false;
    }

    // While parked on an AskUserQuestion the main agent is blocked on the user;
    // any "busy" computed above comes from concurrent sub-agent tool activity on
    // this shared workspace bridge, not real main-agent progress. Suppress it so
    // the workspace stays idle. The AskUserQuestion PostToolUse clears the flag
    // above before reaching here, so the user's answer still returns us to busy.
    if (state.awaitingUserInputResolution && newStatus === "busy") {
      newStatus = null;
      this.logger.debug("Busy suppressed while parked on AskUserQuestion", {
        workspacePath: normalizedPath,
        hookName,
      });
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

      // When status becomes idle, or WrapperStart fires (even if busy due to initial prompt),
      // mark the workspace active.
      if (hookName === "WrapperStart" || newStatus === "idle") {
        this.markActiveHandler?.(normalizedPath);
      }
    } else if (
      hookName === "Stop" &&
      newStatus === "idle" &&
      state.status === "idle" &&
      !state.awaitingUserInputResolution
    ) {
      // The main agent's Stop landed on an already-idle workspace — a turn ran
      // that we never saw start. Bash-mode ("!cmd") turns emit only a Stop (no
      // UserPromptSubmit, no PreToolUse), so a text-only reply never flipped the
      // workspace to busy. Emit a synthetic busy→idle edge so the "agent
      // finished" signal (badge/chime) still fires — the transition is what
      // matters, not the dwell time, so this is a plain synchronous edge rather
      // than a timed flash.
      this.emitBusyIdleEdge(normalizedPath, state);
    }
  }

  /**
   * Emit a synthetic busy→idle status edge (the workspace ends back at idle).
   * Used when a main-agent turn completes that we never saw start, so the
   * status-change consumers still see the "finished" edge. The status-cache
   * dedup layer treats each emission as a distinct edge, so no dwell time is
   * needed. Final status is idle, so a following real turn proceeds normally.
   */
  private emitBusyIdleEdge(workspacePath: string, state: WorkspaceState): void {
    this.logger.info("Emitting busy→idle edge for untracked turn", { workspacePath });
    state.status = "busy";
    for (const callback of state.statusCallbacks) {
      callback("busy");
    }
    state.status = "idle";
    for (const callback of state.statusCallbacks) {
      callback("idle");
    }
    this.markActiveHandler?.(workspacePath);
  }

  /**
   * Generate config files for a workspace.
   * Creates both hooks.json and mcp.json in the workspace's config directory.
   */
  private async generateConfigFiles(workspacePath: string): Promise<void> {
    // Config directory is in the app data, not in the workspace
    // Using a hash of workspace path to make it unique
    const configDir = this.pathProvider.dataPath("claude/configs");

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
    await this.generateConfigFromTemplate(hooksConfigTemplate, hooksConfigPath, variables);

    // Generate MCP config
    const mcpConfigPath = new Path(workspaceConfigDir, "codehydra-mcp.json");
    await this.generateConfigFromTemplate(mcpConfigTemplate, mcpConfigPath, variables);

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
   * Generate a config file from a JSON template with variable substitution.
   */
  private async generateConfigFromTemplate(
    template: unknown,
    targetPath: Path,
    variables: Record<string, string>
  ): Promise<void> {
    let content = JSON.stringify(template, null, 2);

    // Substitute variables
    for (const [key, value] of Object.entries(variables)) {
      const pattern = new RegExp(`\\$\\{${key}\\}`, "g");
      content = content.replace(pattern, value);
    }

    await this.fileSystem.writeFile(targetPath, content);
  }

  /**
   * Get the path to a config file in the workspace's config directory.
   */
  private configFilePath(workspacePath: string, filename: string): Path {
    const normalizedPath = new Path(workspacePath).toString();
    const safeWorkspaceName = this.getConfigDirName(normalizedPath);
    return new Path(this.pathProvider.dataPath("claude/configs"), safeWorkspaceName, filename);
  }

  /**
   * Get the path to the hooks config file for a workspace.
   * This is used by the Provider to set environment variables.
   */
  getHooksConfigPath(workspacePath: string): Path {
    return this.configFilePath(workspacePath, "codehydra-hooks.json");
  }

  /**
   * Get the path to the MCP config file for a workspace.
   * This is used by the Provider to set environment variables.
   */
  getMcpConfigPath(workspacePath: string): Path {
    return this.configFilePath(workspacePath, "codehydra-mcp.json");
  }
}
