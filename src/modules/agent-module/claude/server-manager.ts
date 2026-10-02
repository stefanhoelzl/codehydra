/**
 * Claude Code Server Manager - manages a single HTTP bridge server for all workspaces.
 *
 * Unlike OpenCode (one server per workspace), Claude Code uses one HTTP server
 * for all workspaces. The server receives hook notifications from Claude CLI
 * and routes them to the correct workspace based on the workspaceRef in the payload.
 *
 * The HTTP server:
 * - Listens for POST /hook/:hookName requests from hook-handler.js
 * - Routes status updates to the correct workspace based on workspaceRef in body
 * - Updates workspace status according to HOOK_STATUS_MAP
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "http";
import type { LocalSocketClient, PortManager } from "../../../boundaries/platform/network";
import type { PathProvider } from "../../../boundaries/platform/path-provider";
import type { FileSystemBoundary } from "../../../boundaries/platform/filesystem";
import type { Logger } from "../../../boundaries/platform/logging";
import type {
  AgentServerManager,
  StopServerResult,
  RestartServerResult,
  AgentActivity,
  McpConfig,
  AgentPromptConfig,
  AgentMessage,
  AgentMessageOptions,
} from "../types";
import { AgentUnreachableError } from "../types";
import { errorCode, getErrorMessage, toError } from "../../../shared/error-utils";
import { workspaceNameOf } from "../../../utils/ref";
import { ConditionWaiters } from "../wait-until";
import { inboxPayload } from "./inbox-message";
import { Path } from "../../../utils/path/path";
import type { WorkspaceRef } from "../../../intents/contract";
import {
  type ClaudeCodeHookName,
  type ClaudeCodeBridgePayload,
  isValidHookName,
  WRAPPER_HOOK_NAMES,
  registeredHooks,
} from "./types";
import { deriveStatus, INITIAL_HOOK_FLAGS, type HookFlags } from "./hook-status";

/** Node reports ERR_SERVER_NOT_RUNNING when close() is called on a server that is already down. */
function isServerNotRunning(error: Error): boolean {
  return errorCode(error) === "ERR_SERVER_NOT_RUNNING";
}

/**
 * One hook registration, in Claude's *exec form*.
 *
 * `args` is what selects exec form: Claude spawns `command` directly with this
 * argument vector and no shell at all. Shell form — a single command string —
 * cannot be written portably here, because Claude picks the shell per platform:
 * `sh` on macOS and Linux, Git Bash on Windows, PowerShell when Git Bash is
 * absent. A quoted path works in the first two and PowerShell reads a leading
 * quoted token as a string literal rather than a command, so it would need a
 * `&` prefix that the others would then choke on. Exec form has no such
 * problem: every element is one argument exactly as written, spaces and
 * backslashes included.
 */
interface ClaudeHookCommand {
  readonly type: "command";
  readonly command: string;
  readonly args: readonly string[];
}

/** One registration under a hook name, optionally scoped by matcher. */
interface ClaudeHookMatcher {
  readonly matcher?: string;
  readonly hooks: readonly ClaudeHookCommand[];
}

/**
 * The file handed to `claude --settings`. Claude merges it with the user's own
 * settings, so it carries only what CodeHydra needs.
 */
export interface ClaudeSettingsFile {
  readonly hooks: Readonly<Record<string, readonly ClaudeHookMatcher[]>>;
}

/** One stdio MCP server entry. */
interface ClaudeMcpServer {
  readonly type: "stdio";
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/**
 * The file handed to `claude --mcp-config`. Merged with the user's own, like
 * the settings file.
 */
export interface ClaudeMcpConfigFile {
  readonly mcpServers: Readonly<Record<string, ClaudeMcpServer>>;
}

/**
 * Build Claude's settings file: one registration per hook we want sent.
 *
 * Exec form, so a path is never handed to a shell to re-split. An install
 * directory containing a space (`C:\Users\Jane Doe\...`, `/home/jane doe/...`)
 * used to break every hook silently; as an argv element it needs no quoting at
 * all.
 *
 * Built here rather than substituted into a checked-in JSON template. A
 * template meant pasting values into already-serialized text, which is how a
 * native Windows path put an invalid `\U` escape inside a JSON string and made
 * the file unparseable. Returning an object and letting `JSON.stringify` see
 * the real values makes escaping structural instead of something each value has
 * to be safe for.
 */
export function buildSettingsFile(
  hookHandlerPath: string,
  interpreter: string
): ClaudeSettingsFile {
  const hooks: Record<string, ClaudeHookMatcher[]> = {};
  for (const [name, register] of registeredHooks()) {
    hooks[name] = [
      {
        ...(register.matcher !== undefined && { matcher: register.matcher }),
        hooks: [{ type: "command", command: interpreter, args: [hookHandlerPath, name] }],
      },
    ];
  }
  return { hooks };
}

/**
 * The interpreter the hook command runs under.
 *
 * The MCP entry passes the bundled interpreter explicitly so `ch mcp` "needs
 * nothing on PATH" — but the hook command used a bare `node`, and the bin
 * directory ships no node, so hooks quietly depended on the user having one
 * installed. Same generated file, opposite assumptions. Prefer the bundled
 * interpreter and fall back only when there is none to offer.
 */
function hookInterpreter(mcpConfig: McpConfig | null, logger: Logger): string {
  if (mcpConfig !== null) return mcpConfig.nodePath;
  logger.warn(
    "No MCP config yet; hook commands will use `node` from PATH, which CodeHydra does not ship"
  );
  return "node";
}

/**
 * Build Claude's MCP config: the one stdio server that reaches CodeHydra.
 *
 * `ch mcp` is given everything explicitly at launch — interpreter, bundle, port
 * and token — so the shim reads no state file and needs nothing on PATH.
 *
 * With no config the server is omitted rather than written with empty strings:
 * the template used to emit `command: ""`, so an agent started before the
 * API server bound was handed an MCP server whose launch command was the
 * empty string. The file itself is still written — the wrapper refuses to
 * launch without `_CH_CLAUDE_MCP_CONFIG` pointing at one — and Claude merges an
 * empty `mcpServers` harmlessly.
 */
export function buildMcpConfigFile(
  workspaceRef: string,
  mcpConfig: McpConfig | null
): ClaudeMcpConfigFile {
  if (mcpConfig === null) return { mcpServers: {} };
  return {
    mcpServers: {
      codehydra: {
        type: "stdio",
        command: mcpConfig.nodePath,
        args: [mcpConfig.cliPath, "mcp"],
        env: {
          _CH_WORKSPACE: workspaceRef,
          _CH_API_PORT: String(mcpConfig.port),
          _CH_API_TOKEN: mcpConfig.token,
        },
      },
    },
  };
}

/**
 * A safe directory name for a workspace's generated files: its name for
 * readability (anything outside `[A-Za-z0-9._-]` replaced), plus a hash of the
 * whole ref for uniqueness and to keep the path short.
 */
export function configDirName(workspaceRef: WorkspaceRef): string {
  let hash = 0;
  for (let i = 0; i < workspaceRef.length; i++) {
    hash = (hash << 5) - hash + workspaceRef.charCodeAt(i);
    hash = hash & hash; // Convert to 32bit integer
  }
  const name = workspaceNameOf(workspaceRef).replace(/[^A-Za-z0-9._-]/g, "_");
  return `${name}-${Math.abs(hash).toString(16)}`;
}

/**
 * Per-workspace state tracked by the server manager.
 */
export interface WorkspaceState {
  /** Current agent status */
  status: AgentActivity;
  /** Current session ID (from SessionStart hook) */
  sessionId?: string;
  /**
   * The running session's inbox (from SessionStart), cleared when the session
   * or its terminal ends. Present exactly when a message can be delivered.
   */
  inbox?: { readonly socketPath: string; readonly token: string | undefined };
  /**
   * The flags the hook rules keep (see hook-status.ts). `terminalOpen` without
   * an inbox means `claude` is still starting: it reads idle already, and a
   * message sent now waits for SessionStart rather than failing.
   */
  flags: HookFlags;
  /** Callbacks for status changes */
  statusCallbacks: Set<(status: AgentActivity) => void>;
  /** Path to the initial prompt file (for getInitialPromptPath) */
  initialPromptPath?: Path;
  /** Path to the no-session marker file (for getNoSessionMarkerPath) */
  noSessionMarkerPath?: Path;
  /**
   * Armed when WrapperStart reads busy for an initial prompt, cleared by
   * SessionStart. Firing means `claude` is waiting on the user before its
   * session starts (the folder trust dialog), so the workspace goes idle.
   */
  startupTimer?: ReturnType<typeof setTimeout>;
  /**
   * Called by the first SessionStart after the initial prompt file was written:
   * the session the wrapper launched with the prompt is up.
   */
  onInitialPromptDelivered?: () => void;
}

/**
 * Callback for server started events.
 */
export type ServerStartedCallback = (workspaceRef: WorkspaceRef, port: number) => void;

/**
 * Callback for server stopped events.
 */
export type ServerStoppedCallback = (workspaceRef: WorkspaceRef, isRestart: boolean) => void;

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
  /** Writes messages into a session's inbox socket. */
  readonly localSocketClient: LocalSocketClient;
  readonly pathProvider: PathProvider;
  readonly fileSystem: FileSystemBoundary;
  readonly logger: Logger;
  readonly config?: ClaudeCodeServerManagerConfig;
}

/**
 * How long a message waits for a `claude` whose terminal is open but which has
 * not yet announced its inbox (SessionStart): the TUI is booting.
 */
const STARTING_AGENT_WAIT_MS = 30_000;

/**
 * How long a workspace with an initial prompt reads busy before its session
 * starts. Claude fires no hook while a dialog blocks its startup (folder trust),
 * so past this the workspace goes idle: it is waiting on the user.
 */
const STARTUP_BUSY_TIMEOUT_MS = 60_000;

/**
 * Claude Code Server Manager implementation.
 *
 * Key differences from OpenCode:
 * - Single HTTP server for ALL workspaces
 * - Hooks include workspaceRef to route to correct workspace
 * - Status changes come from hooks, not SSE events
 */
export class ClaudeCodeServerManager implements AgentServerManager {
  private readonly portManager: PortManager;
  private readonly localSocketClient: LocalSocketClient;
  private readonly pathProvider: PathProvider;
  private readonly fileSystem: FileSystemBoundary;
  private readonly logger: Logger;
  private readonly hookHandlerPath: string;

  /** Single HTTP server for all workspaces */
  private httpServer: Server | null = null;
  /** Port the server is listening on */
  private port: number | null = null;

  /** Per-workspace state */
  private readonly workspaces = new Map<WorkspaceRef, WorkspaceState>();

  /** Senders waiting for a workspace's session inbox to appear. */
  private readonly inboxWaiters = new ConditionWaiters();

  /** Callbacks for lifecycle events */
  private readonly startedCallbacks = new Set<ServerStartedCallback>();
  private readonly stoppedCallbacks = new Set<ServerStoppedCallback>();

  /** Handler called when workspace becomes active (first idle) */
  private markActiveHandler: ((workspaceRef: WorkspaceRef) => void) | null = null;

  /** MCP configuration (set before starting servers) */
  private mcpConfig: McpConfig | null = null;

  constructor(deps: ClaudeCodeServerManagerDeps) {
    this.portManager = deps.portManager;
    this.localSocketClient = deps.localSocketClient;
    this.pathProvider = deps.pathProvider;
    this.fileSystem = deps.fileSystem;
    this.logger = deps.logger;

    // Default hook handler path uses runtime dir (outside ASAR in production).
    // Native, not POSIX: the command that carries it is quoted, so backslashes
    // are safe, and the shell is handed the path the OS actually uses.
    this.hookHandlerPath =
      deps.config?.hookHandlerPath ??
      this.pathProvider.runtimePath("bin/claude-code-hook-handler.cjs").toNative();
  }

  /**
   * Start tracking a workspace.
   * Starts the HTTP server if this is the first workspace.
   *
   * Needs no path: Claude runs in the agent terminal, not in a process spawned
   * here, and the files generated for it are named after the ref.
   *
   * @param workspaceRef - The workspace's ref, which its agent and hooks name it by
   * @returns Port number of the bridge server
   */
  async startServer(workspaceRef: WorkspaceRef): Promise<number> {
    // Check if workspace is already registered
    if (this.workspaces.has(workspaceRef)) {
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
    this.workspaces.set(workspaceRef, {
      status: "none",
      flags: INITIAL_HOOK_FLAGS,
      statusCallbacks: new Set(),
    });

    // Generate config files for this workspace
    await this.generateConfigFiles(workspaceRef);

    this.logger.scoped({ workspace: workspaceRef }).info("Workspace registered", {
      port: this.port,
    });

    // Fire started callback
    for (const callback of this.startedCallbacks) {
      callback(workspaceRef, this.port!);
    }

    return this.port!;
  }

  /**
   * Stop tracking a workspace.
   * Stops the HTTP server if this is the last workspace.
   *
   * @param workspaceRef - The workspace
   * @param isRestart - True if this is part of a restart operation
   * @returns StopServerResult
   */
  async stopServer(workspaceRef: WorkspaceRef, isRestart = false): Promise<StopServerResult> {
    const state = this.workspaces.get(workspaceRef);
    if (state === undefined) {
      return { success: true };
    }

    // Remove workspace
    clearTimeout(state.startupTimer);
    this.workspaces.delete(workspaceRef);
    this.inboxWaiters.notify();

    // Fire stopped callback
    for (const callback of this.stoppedCallbacks) {
      callback(workspaceRef, isRestart);
    }

    this.logger.scoped({ workspace: workspaceRef }).info("Workspace unregistered", { isRestart });

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
   * @param workspaceRef - The workspace
   * @returns RestartServerResult
   */
  async restartServer(workspaceRef: WorkspaceRef): Promise<RestartServerResult> {
    const state = this.workspaces.get(workspaceRef);
    if (state === undefined) {
      return {
        success: false,
        error: "Workspace not registered",
      };
    }

    // Stop and restart the workspace (preserving status callbacks). A restart
    // leaves a running `claude` alone, so its inbox is still the one to use.
    const savedCallbacks = state.statusCallbacks;
    const savedInbox = state.inbox;
    clearTimeout(state.startupTimer);

    // Fire stopped callback with isRestart=true
    for (const callback of this.stoppedCallbacks) {
      callback(workspaceRef, true);
    }

    // Reset state but preserve callbacks
    this.workspaces.set(workspaceRef, {
      status: "none",
      flags: { ...INITIAL_HOOK_FLAGS, terminalOpen: state.flags.terminalOpen },
      statusCallbacks: savedCallbacks,
      ...(savedInbox !== undefined && { inbox: savedInbox }),
    });

    // Regenerate config files
    await this.generateConfigFiles(workspaceRef);

    // Fire started callback
    for (const callback of this.startedCallbacks) {
      callback(workspaceRef, this.port!);
    }

    this.logger.scoped({ workspace: workspaceRef }).info("Workspace restarted", {
      port: this.port,
    });

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
   */
  setMarkActiveHandler(handler: (workspaceRef: WorkspaceRef) => void): void {
    this.markActiveHandler = handler;
  }

  /**
   * Subscribe to status changes for a specific workspace.
   *
   * @param workspaceRef - The workspace
   * @param callback - Callback invoked on status change
   * @returns Unsubscribe function
   */
  onStatusChange(
    workspaceRef: WorkspaceRef,
    callback: (status: AgentActivity) => void
  ): () => void {
    const state = this.workspaces.get(workspaceRef);

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
   * @param workspaceRef - The workspace
   * @returns Session ID or undefined
   */
  getSessionId(workspaceRef: WorkspaceRef): string | undefined {
    return this.workspaces.get(workspaceRef)?.sessionId;
  }

  /**
   * Deliver a message into the workspace's running Claude session, through the
   * inbox socket its SessionStart hook announced.
   *
   * Waits up to `options.waitMs` for a session to announce one (after a wake,
   * or reopening the agent terminal) — and, whatever `waitMs` says, for a
   * `claude` whose terminal is open but which has not announced one yet: it is
   * starting, not absent. Resolves once the socket has taken the message —
   * whether Claude hands it to the model or holds it for its user's approval is
   * Claude's inbound policy, not ours.
   *
   * @throws AgentUnreachableError when no session is reachable in time
   * @throws when the socket write fails
   */
  async sendMessage(
    workspaceRef: WorkspaceRef,
    message: AgentMessage,
    options: AgentMessageOptions
  ): Promise<void> {
    const stateOf = () => this.workspaces.get(workspaceRef);
    // A caller that asked to wait has just (re)started the agent, whose terminal
    // may not even report open yet. Otherwise wait only for one already
    // starting, and give up the moment its terminal closes.
    const asked = options.waitMs > 0;
    const starting = !asked && stateOf()?.flags.terminalOpen === true;
    const waitMs = asked ? options.waitMs : starting ? STARTING_AGENT_WAIT_MS : 0;

    const reachable = await this.inboxWaiters.waitUntil(() => {
      const state = stateOf();
      if (state === undefined || state.inbox !== undefined) return true;
      return starting && !state.flags.terminalOpen;
    }, waitMs);
    const inbox = stateOf()?.inbox;
    if (!reachable || inbox === undefined) {
      throw new AgentUnreachableError(
        "No Claude session is running in this workspace (its agent terminal is closed, " +
          "or the agent has not started yet)."
      );
    }

    await this.localSocketClient.send(inbox.socketPath, inboxPayload(message, inbox.token));
    this.logger.scoped({ workspace: workspaceRef }).info("Message delivered to Claude inbox", {
      from: message.from,
      length: message.text.length,
    });
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
   * @param workspaceRef - The workspace
   * @param config - Resolved agent launch configuration
   * @param onDelivered - Called on the first SessionStart after the file is written
   */
  async setInitialPrompt(
    workspaceRef: WorkspaceRef,
    config: AgentPromptConfig,
    onDelivered?: () => void
  ): Promise<void> {
    const log = this.logger.scoped({ workspace: workspaceRef });
    const state = this.workspaces.get(workspaceRef);

    if (!state) {
      log.warn("setInitialPrompt called for unknown workspace");
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
      state.flags = { ...state.flags, busyOnWrapperStart: (config.prompt ?? "").trim() !== "" };

      if (onDelivered !== undefined) {
        state.onInitialPromptDelivered = onDelivered;
      }

      log.info("Initial prompt file created", { path: promptFilePath.toString() });
    } catch (error) {
      log.error("Failed to create initial prompt file", undefined, toError(error));
      // Don't throw - initial prompt is optional, workspace should still work
    }
  }

  /**
   * Get the path to the initial prompt file for a workspace.
   * Returns undefined if no initial prompt was set.
   *
   * @param workspaceRef - The workspace
   * @returns Path to the initial prompt file, or undefined
   */
  getInitialPromptPath(workspaceRef: WorkspaceRef): Path | undefined {
    return this.workspaces.get(workspaceRef)?.initialPromptPath;
  }

  /**
   * Create a no-session marker file for a new workspace.
   * The marker tells the wrapper to skip --continue on first launch.
   * It is deleted by the wrapper on first invocation so subsequent runs
   * will attempt session resume.
   *
   * @param workspaceRef - The workspace
   */
  async setNoSessionMarker(workspaceRef: WorkspaceRef): Promise<void> {
    const log = this.logger.scoped({ workspace: workspaceRef });
    const state = this.workspaces.get(workspaceRef);

    if (!state) {
      log.warn("setNoSessionMarker called for unknown workspace");
      return;
    }

    try {
      const markerDir = this.pathProvider.tempPath("claude/no-session");
      await this.fileSystem.mkdir(markerDir);

      const markerPath = new Path(markerDir, configDirName(workspaceRef));
      await this.fileSystem.writeFile(markerPath, "");

      state.noSessionMarkerPath = markerPath;

      log.debug("No-session marker created", { path: markerPath.toString() });
    } catch (error) {
      log.error("Failed to create no-session marker", undefined, toError(error));
    }
  }

  /**
   * Get the path to the no-session marker file for a workspace.
   * Returns undefined if no marker was set.
   *
   * @param workspaceRef - The workspace
   * @returns Path to the marker file, or undefined
   */
  getNoSessionMarkerPath(workspaceRef: WorkspaceRef): Path | undefined {
    return this.workspaces.get(workspaceRef)?.noSessionMarkerPath;
  }

  /**
   * Dispose the server manager, stopping all workspaces and the HTTP server.
   */
  async dispose(): Promise<void> {
    // Stop all workspaces
    const workspaces = [...this.workspaces.keys()];
    await Promise.all(workspaces.map((workspaceRef) => this.stopServer(workspaceRef)));

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
          error: getErrorMessage(error),
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
  triggerWrapperLifecycle(
    workspaceRef: WorkspaceRef,
    hookName: "WrapperStart" | "WrapperEnd"
  ): void {
    this.handleHook(hookName, { workspaceRef });
  }

  /**
   * Handle a hook notification.
   */
  private handleHook(hookName: ClaudeCodeHookName, payload: ClaudeCodeBridgePayload): void {
    this.logger.silly("Hook payload received", { hookName, payload: JSON.stringify(payload) });

    const { session_id } = payload;

    // A hook names its workspace by ref (`_CH_WORKSPACE`, added by the hook
    // handler). A ref that is not tracked here is not routed anywhere.
    const workspaceRef = payload.workspaceRef as WorkspaceRef | undefined;
    const state = workspaceRef !== undefined ? this.workspaces.get(workspaceRef) : undefined;
    if (workspaceRef === undefined || state === undefined) {
      this.logger.silly("Hook received for unknown workspace", {
        hookName,
        workspaceRef: workspaceRef ?? null,
      });
      return;
    }

    // Update session ID if present
    if (session_id) {
      state.sessionId = session_id;
    }

    // Track the session's inbox: announced by SessionStart (every start,
    // resume, /clear and compaction), gone with the session or its terminal.
    if (hookName === "SessionStart" && payload._ch_messaging?.socket) {
      state.inbox = {
        socketPath: payload._ch_messaging.socket,
        token: payload._ch_messaging.token,
      };
      this.inboxWaiters.notify();
    } else if (hookName === "SessionEnd" || hookName === "WrapperEnd") {
      delete state.inbox;
    }
    if (hookName === "SessionStart" && state.onInitialPromptDelivered !== undefined) {
      const onDelivered = state.onInitialPromptDelivered;
      delete state.onInitialPromptDelivered;
      onDelivered();
    }
    const result = deriveStatus(
      {
        flags: state.flags,
        status: state.status,
        startupTimerArmed: state.startupTimer !== undefined,
      },
      hookName,
      payload
    );
    const log = this.logger.scoped({ workspace: workspaceRef });
    if (result.kind === "ignored") {
      log.silly(
        result.reason === "subagent-stop"
          ? "Ignoring sub-agent Stop for main status"
          : "Ignoring sub-agent PreToolUse for main status",
        {
          hookName,
          agentId: payload.agent_id ?? null,
          ...(hookName === "PreToolUse" && { toolName: payload.tool_name ?? null }),
        }
      );
      return;
    }

    state.flags = result.flags;
    // A closed terminal ends any wait for a `claude` that was still starting.
    if (hookName === "WrapperEnd") this.inboxWaiters.notify();
    if (result.startupTimer === "arm") {
      state.startupTimer = setTimeout(
        () => this.handleStartupTimeout(workspaceRef, state),
        STARTUP_BUSY_TIMEOUT_MS
      );
    } else if (result.startupTimer === "clear") {
      clearTimeout(state.startupTimer);
      delete state.startupTimer;
    }
    for (const suppression of result.suppressed) {
      if (suppression.reason === "background-tasks") {
        log.debug(
          "Idle suppressed for background tasks",
          suppression.tasks !== undefined ? { tasks: suppression.tasks } : undefined
        );
      } else {
        log.debug("Busy suppressed while parked on AskUserQuestion", { hookName });
      }
    }

    const newStatus = result.status;
    log.debug("Hook received", {
      hookName,
      currentStatus: state.status,
      newStatus: newStatus ?? "(no change)",
    });

    if (newStatus !== null && newStatus !== state.status) {
      this.changeStatus(workspaceRef, state, newStatus, hookName);
    } else if (result.untrackedTurn) {
      // A turn ran that was never seen to start. Emit a synthetic busy→idle
      // edge so the "agent finished" signal (badge/chime) still fires — the
      // transition is what matters, not the dwell time, so this is a plain
      // synchronous edge rather than a timed flash.
      this.emitBusyIdleEdge(workspaceRef, state);
    }
  }

  /**
   * Set a workspace's status and notify its subscribers.
   */
  private changeStatus(
    workspaceRef: WorkspaceRef,
    state: WorkspaceState,
    newStatus: AgentActivity,
    hookName: ClaudeCodeHookName | "StartupTimeout"
  ): void {
    const oldStatus = state.status;
    state.status = newStatus;

    this.logger
      .scoped({ workspace: workspaceRef })
      .info("Status changed", { from: oldStatus, to: newStatus, hookName });

    // Notify subscribers
    for (const callback of state.statusCallbacks) {
      callback(newStatus);
    }

    // When status becomes idle, or WrapperStart fires (even if busy due to initial prompt),
    // mark the workspace active.
    if (hookName === "WrapperStart" || newStatus === "idle") {
      this.markActiveHandler?.(workspaceRef);
    }
  }

  /**
   * The session of a workspace with an initial prompt has not started within
   * STARTUP_BUSY_TIMEOUT_MS of its terminal opening. Claude is blocked on the
   * user before its session starts (the folder trust dialog), so read idle.
   * `busyOnWrapperStart` stays set: once the user answers, SessionStart turns
   * the workspace busy again for the prompt it then runs.
   */
  private handleStartupTimeout(workspaceRef: WorkspaceRef, state: WorkspaceState): void {
    delete state.startupTimer;
    if (this.workspaces.get(workspaceRef) !== state || state.status !== "busy") {
      return;
    }
    this.logger
      .scoped({ workspace: workspaceRef })
      .info("Session not started, waiting on the user", { timeoutMs: STARTUP_BUSY_TIMEOUT_MS });
    this.changeStatus(workspaceRef, state, "idle", "StartupTimeout");
  }

  /**
   * Emit a synthetic busy→idle status edge (the workspace ends back at idle).
   * Used when a main-agent turn completes that we never saw start, so the
   * status-change consumers still see the "finished" edge. The status-cache
   * dedup layer treats each emission as a distinct edge, so no dwell time is
   * needed. Final status is idle, so a following real turn proceeds normally.
   */
  private emitBusyIdleEdge(workspaceRef: WorkspaceRef, state: WorkspaceState): void {
    this.logger
      .scoped({ workspace: workspaceRef })
      .info("Emitting busy→idle edge for untracked turn");
    state.status = "busy";
    for (const callback of state.statusCallbacks) {
      callback("busy");
    }
    state.status = "idle";
    for (const callback of state.statusCallbacks) {
      callback("idle");
    }
    this.markActiveHandler?.(workspaceRef);
  }

  /**
   * Generate config files for a workspace.
   * Creates both hooks.json and mcp.json in the workspace's config directory.
   */
  private async generateConfigFiles(workspaceRef: WorkspaceRef): Promise<void> {
    // Config directory is in the app temp dir, not in the workspace.
    // Temp, not data: the generated files bake in this launch's bridge port,
    // API server port and API token, so a file that outlives the launch is not
    // just garbage but actively wrong. temp-dir-module clears the temp root on
    // every app:start, which is exactly the lifetime these files want.
    const workspaceConfigDir = new Path(
      this.pathProvider.tempPath("claude/configs"),
      configDirName(workspaceRef)
    );

    // Ensure config directory exists
    await this.fileSystem.mkdir(workspaceConfigDir);

    // Generate the two files Claude is launched with.
    await this.writeJsonFile(
      new Path(workspaceConfigDir, "codehydra-hooks.json"),
      buildSettingsFile(this.hookHandlerPath, hookInterpreter(this.mcpConfig ?? null, this.logger))
    );
    await this.writeJsonFile(
      new Path(workspaceConfigDir, "codehydra-mcp.json"),
      buildMcpConfigFile(workspaceRef, this.mcpConfig ?? null)
    );

    this.logger
      .scoped({ workspace: workspaceRef })
      .debug("Config files generated", { configDir: workspaceConfigDir.toString() });
  }

  /**
   * Write one generated config file.
   *
   * The single place these objects are serialized, so the guarantee the agent
   * depends on — that a native path or a token survives into valid JSON — has
   * one home rather than one per call site.
   */
  private async writeJsonFile(targetPath: Path, value: unknown): Promise<void> {
    await this.fileSystem.writeFile(targetPath, JSON.stringify(value, null, 2));
  }

  /**
   * Get the path to a config file in the workspace's config directory.
   */
  private configFilePath(workspaceRef: WorkspaceRef, filename: string): Path {
    return new Path(
      this.pathProvider.tempPath("claude/configs"),
      configDirName(workspaceRef),
      filename
    );
  }

  /**
   * Get the path to the hooks config file for a workspace.
   * This is used by the Provider to set environment variables.
   */
  getHooksConfigPath(workspaceRef: WorkspaceRef): Path {
    return this.configFilePath(workspaceRef, "codehydra-hooks.json");
  }

  /**
   * Get the path to the MCP config file for a workspace.
   * This is used by the Provider to set environment variables.
   */
  getMcpConfigPath(workspaceRef: WorkspaceRef): Path {
    return this.configFilePath(workspaceRef, "codehydra-mcp.json");
  }

  /**
   * Get the path to the CodeHydra system prompt appended to every Claude session.
   *
   * Same resolution as the hook handler: the runtime dir, which is outside the
   * ASAR in production so claude (a separate process) can read it. The file is
   * identical for every workspace, so it is not generated per workspace — it is
   * composed at build time from resources/prompts (shared + the Claude appendix).
   */
  getSystemPromptPath(): Path {
    return this.pathProvider.runtimePath("bin/codehydra-prompt-claude.md");
  }
}
