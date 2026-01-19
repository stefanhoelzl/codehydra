import * as vscode from "vscode";
import * as path from "path";
import { io } from "socket.io-client";
import type { CodehydraApi } from "../api";
import type {
  TypedSocket,
  PluginResult,
  PluginConfig,
  CommandRequest,
  LogContext,
  WorkspaceCreateRequest,
  InitialPrompt,
  AgentSession,
  AgentType,
} from "./types";
import {
  reconstructVscodeObjects,
  type VscodeFactories,
} from "../../../src/shared/vscode-serialization";

let socket: TypedSocket | null = null;
let isConnected = false;
let pendingReady: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];

/** Timeout for API calls in milliseconds (matches COMMAND_TIMEOUT_MS) */
const API_TIMEOUT_MS = 10000;

/** Timeout for terminal kill operations in milliseconds */
const TERMINAL_KILL_TIMEOUT_MS = 5000;

/**
 * Factory functions for reconstructing VS Code objects from JSON wrappers.
 * Maps $vscode type markers to actual VS Code constructors.
 */
const vscodeFactories: VscodeFactories = {
  Uri: (value: string) => vscode.Uri.parse(value),
  Position: (line: number, character: number) => new vscode.Position(line, character),
  Range: (start: unknown, end: unknown) =>
    new vscode.Range(start as vscode.Position, end as vscode.Position),
  Selection: (anchor: unknown, active: unknown) =>
    new vscode.Selection(anchor as vscode.Position, active as vscode.Position),
  Location: (uri: unknown, range: unknown) =>
    new vscode.Location(uri as vscode.Uri, range as vscode.Range),
};

// ============================================================================
// Development Mode State Variables
// ============================================================================

let isDevelopment = false;
let debugOutputChannel: vscode.OutputChannel | null = null;
let currentWorkspacePath = "";
let currentPluginPort: number | null = null;
let extensionContext: vscode.ExtensionContext | null = null;

// ============================================================================
// Agent Terminal Management
// ============================================================================

/** Singleton terminal for agent CLI */
let agentTerminal: vscode.Terminal | null = null;

/** Disposable for terminal close listener */
let terminalCloseListener: vscode.Disposable | null = null;

/**
 * Open agent terminal in the editor area.
 * Creates a new terminal if none exists, otherwise focuses the existing one.
 *
 * @param agentType - The type of agent ("opencode" or "claude")
 * @param env - Environment variables to set for the terminal
 */
function openAgentTerminal(agentType: AgentType, env: Record<string, string>): void {
  // If terminal exists and not disposed, just focus it
  if (agentTerminal) {
    agentTerminal.show();
    return;
  }

  const terminalName = agentType === "claude" ? "Claude" : "OpenCode";
  const command = agentType === "claude" ? "ch-claude" : "ch-opencode";

  // Create terminal in editor area using viewColumn
  agentTerminal = vscode.window.createTerminal({
    name: terminalName,
    location: { viewColumn: vscode.ViewColumn.Active },
    env: env,
  });

  agentTerminal.show();
  agentTerminal.sendText(command);

  codehydraApi.log.debug("Agent terminal opened", { agentType, command });
}

/**
 * Set up terminal close listener to reset the singleton reference.
 */
function setupTerminalCloseListener(): void {
  if (terminalCloseListener) {
    return;
  }

  terminalCloseListener = vscode.window.onDidCloseTerminal((terminal) => {
    if (terminal === agentTerminal) {
      agentTerminal = null;
      codehydraApi.log.debug("Agent terminal closed");
    }
  });
}

// ============================================================================
// API Utilities
// ============================================================================

/**
 * Emit an API call with timeout handling.
 */
function emitApiCall<T>(event: string, request?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!socket) {
      reject(new Error("Not connected to CodeHydra"));
      return;
    }

    const timeout = setTimeout(() => {
      codehydraApi.log.warn("API call timeout", { event });
      reject(new Error(`API call timed out: ${event}`));
    }, API_TIMEOUT_MS);

    const handleResult = (result: PluginResult<T>): void => {
      clearTimeout(timeout);
      if (result.success) {
        resolve(result.data);
      } else {
        reject(new Error(result.error));
      }
    };

    // Emit with or without request based on event type
    // Socket.IO's TypedSocket requires exact event name literals for type inference.
    // This generic wrapper uses a dynamic event string, which TypeScript cannot verify
    // against the ClientToServerEvents interface at compile time.
    if (request !== undefined) {
      // @ts-expect-error Dynamic event name - TypedSocket strict typing cannot accommodate dynamic event names
      socket.emit(event, request, handleResult);
    } else {
      // @ts-expect-error Dynamic event name - TypedSocket strict typing cannot accommodate dynamic event names
      socket.emit(event, handleResult);
    }
  });
}

// ============================================================================
// CodeHydra API
// ============================================================================

/**
 * CodeHydra API for VS Code extensions.
 * Provides access to workspace status and metadata.
 */
const codehydraApi = {
  /**
   * Wait for the extension to be connected to CodeHydra.
   * Resolves immediately if already connected.
   */
  whenReady(): Promise<void> {
    if (isConnected && socket?.connected) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      pendingReady.push({ resolve, reject });
    });
  },

  /**
   * Log API namespace.
   * Provides structured logging to CodeHydra's logging system.
   * Methods are fire-and-forget and gracefully handle disconnected state.
   */
  log: {
    silly(message: string, context?: LogContext): void {
      if (!socket?.connected) return;
      socket.emit("api:log", { level: "silly", message, context });
    },

    debug(message: string, context?: LogContext): void {
      if (!socket?.connected) return;
      socket.emit("api:log", { level: "debug", message, context });
    },

    info(message: string, context?: LogContext): void {
      if (!socket?.connected) return;
      socket.emit("api:log", { level: "info", message, context });
    },

    warn(message: string, context?: LogContext): void {
      if (!socket?.connected) return;
      socket.emit("api:log", { level: "warn", message, context });
    },

    error(message: string, context?: LogContext): void {
      if (!socket?.connected) return;
      socket.emit("api:log", { level: "error", message, context });
    },
  },

  /**
   * Workspace API namespace.
   * All methods require the connection to be established (use whenReady() first).
   */
  workspace: {
    getStatus() {
      return emitApiCall("api:workspace:getStatus");
    },

    getAgentSession() {
      return emitApiCall<AgentSession | null>("api:workspace:getAgentSession");
    },

    restartAgentServer() {
      return emitApiCall<number>("api:workspace:restartAgentServer");
    },

    getMetadata() {
      return emitApiCall<Record<string, string>>("api:workspace:getMetadata");
    },

    setMetadata(key: string, value: string | null) {
      return emitApiCall<void>("api:workspace:setMetadata", { key, value });
    },

    executeCommand(command: string, args?: readonly unknown[]) {
      // Client-side validation
      if (typeof command !== "string" || command.trim().length === 0) {
        return Promise.reject(new Error("Command must be a non-empty string"));
      }
      if (args !== undefined && !Array.isArray(args)) {
        return Promise.reject(new Error("Args must be an array"));
      }
      return emitApiCall<unknown>("api:workspace:executeCommand", { command, args });
    },

    create(
      name: string,
      base: string,
      options?: { initialPrompt?: InitialPrompt; keepInBackground?: boolean }
    ) {
      // Client-side validation
      if (typeof name !== "string" || name.trim().length === 0) {
        return Promise.reject(new Error("Name must be a non-empty string"));
      }
      if (typeof base !== "string" || base.trim().length === 0) {
        return Promise.reject(new Error("Base must be a non-empty string"));
      }
      // Validate initialPrompt if provided
      if (options?.initialPrompt !== undefined) {
        const prompt = options.initialPrompt;
        if (typeof prompt === "string") {
          if (prompt.length === 0) {
            return Promise.reject(new Error("Initial prompt cannot be empty"));
          }
        } else if (typeof prompt === "object" && prompt !== null) {
          if (typeof prompt.prompt !== "string" || prompt.prompt.length === 0) {
            return Promise.reject(new Error("Initial prompt.prompt must be a non-empty string"));
          }
          if (prompt.agent !== undefined && typeof prompt.agent !== "string") {
            return Promise.reject(new Error("Initial prompt.agent must be a string"));
          }
        } else {
          return Promise.reject(new Error("Initial prompt must be a string or object"));
        }
      }
      // Build request
      const request: WorkspaceCreateRequest = {
        name,
        base,
        initialPrompt: options?.initialPrompt,
        keepInBackground: options?.keepInBackground,
      };
      return emitApiCall("api:workspace:create", request);
    },
  },
  // `satisfies` ensures the implementation matches the public CodehydraApi contract
  // while preserving the literal types for internal use (better inference than `as`)
} satisfies CodehydraApi;

// ============================================================================
// Debug Commands (Development Only)
// ============================================================================

function getDebugOutputChannel(): vscode.OutputChannel {
  if (!debugOutputChannel) {
    debugOutputChannel = vscode.window.createOutputChannel("CodeHydra Debug");
  }
  return debugOutputChannel;
}

function formatResult(result: unknown): string {
  try {
    return JSON.stringify(result, null, 2);
  } catch (e) {
    return `[Serialization error: ${e instanceof Error ? e.message : String(e)}]`;
  }
}

function logDebugResult(name: string, data: unknown): void {
  const channel = getDebugOutputChannel();
  const timestamp = new Date().toISOString();
  channel.appendLine(`=== ${name} [${timestamp}] ===`);
  channel.appendLine(formatResult(data));
  channel.appendLine("");
  channel.show(true); // Show but don't steal focus
}

function logDebugError(name: string, err: Error): void {
  const channel = getDebugOutputChannel();
  const timestamp = new Date().toISOString();
  channel.appendLine(`=== ${name} [${timestamp}] ERROR ===`);
  channel.appendLine(err.message);
  channel.appendLine("");
  channel.show(true);
}

async function runDebugCommand(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    const result = await fn();
    logDebugResult(name, result);
  } catch (err) {
    logDebugError(name, err instanceof Error ? err : new Error(String(err)));
  }
}

function registerDebugCommands(context: vscode.ExtensionContext): void {
  // Debug: Get Workspace Status
  context.subscriptions.push(
    vscode.commands.registerCommand("codehydra.debug.getStatus", async () => {
      await runDebugCommand("getStatus", () => codehydraApi.workspace.getStatus());
    })
  );

  // Debug: Get Workspace Metadata
  context.subscriptions.push(
    vscode.commands.registerCommand("codehydra.debug.getMetadata", async () => {
      await runDebugCommand("getMetadata", () => codehydraApi.workspace.getMetadata());
    })
  );

  // Debug: Get Agent Session
  context.subscriptions.push(
    vscode.commands.registerCommand("codehydra.debug.getAgentSession", async () => {
      await runDebugCommand("getAgentSession", () => codehydraApi.workspace.getAgentSession());
    })
  );

  // Debug: Show Connection Info
  context.subscriptions.push(
    vscode.commands.registerCommand("codehydra.debug.connectionInfo", async () => {
      const info = {
        connected: isConnected,
        workspacePath: currentWorkspacePath,
        pluginPort: currentPluginPort,
        socketId: socket?.id ?? null,
        isDevelopment: isDevelopment,
      };
      logDebugResult("connectionInfo", info);
    })
  );

  codehydraApi.log.debug("Debug commands registered");
}

// ============================================================================
// Terminal Cleanup
// ============================================================================

async function killAllTerminalsAndWait(): Promise<void> {
  const terminals = [...vscode.window.terminals];

  if (terminals.length === 0) {
    codehydraApi.log.debug("No terminals to kill");
    return;
  }

  codehydraApi.log.debug("Killing terminals", { count: terminals.length });
  const pendingTerminals = new Set(terminals);

  await new Promise<void>((resolve) => {
    let resolved = false;

    const done = (): void => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      disposable.dispose();
      resolve();
    };

    const timeout = setTimeout(() => {
      codehydraApi.log.warn("Terminal kill timeout", { remaining: pendingTerminals.size });
      done();
    }, TERMINAL_KILL_TIMEOUT_MS);

    const disposable = vscode.window.onDidCloseTerminal((closedTerminal) => {
      pendingTerminals.delete(closedTerminal);
      codehydraApi.log.debug("Terminal closed", { remaining: pendingTerminals.size });
      if (pendingTerminals.size === 0) {
        codehydraApi.log.debug("All terminals closed");
        done();
      }
    });

    for (const terminal of terminals) {
      terminal.dispose();
    }

    if (pendingTerminals.size === 0) {
      codehydraApi.log.debug("All terminals closed (sync)");
      done();
    }
  });
}

// ============================================================================
// PluginServer Connection
// ============================================================================

function connectToPluginServer(port: number, workspacePath: string): void {
  currentWorkspacePath = workspacePath;
  currentPluginPort = port;

  const url = `http://127.0.0.1:${port}`;
  socket = io(url, {
    transports: ["websocket"],
    auth: {
      workspacePath: workspacePath,
    },
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
    reconnectionAttempts: Infinity,
    autoConnect: false,
  }) as TypedSocket;

  socket.on("config", async (config: PluginConfig) => {
    if (typeof config !== "object" || config === null) {
      return;
    }
    if (typeof config.isDevelopment !== "boolean") {
      return;
    }

    // Mark as connected and resolve pending ready promises
    isConnected = true;
    const pending = pendingReady;
    pendingReady = [];
    for (const { resolve } of pending) {
      resolve();
    }

    isDevelopment = config.isDevelopment;
    codehydraApi.log.debug("Config received", {
      isDevelopment,
      hasEnv: config.env !== null,
      agentType: config.agentType,
    });

    await vscode.commands.executeCommand("setContext", "codehydra.isDevelopment", isDevelopment);

    // Execute pre-terminal layout commands
    const preLayoutCommands = [
      "workbench.action.closeSidebar",
      "workbench.action.closeAuxiliaryBar",
      "workbench.action.editorLayoutSingle",
      "workbench.action.closeAllEditors",
    ];
    for (const command of preLayoutCommands) {
      try {
        await vscode.commands.executeCommand(command);
      } catch (err: unknown) {
        const error = err instanceof Error ? err.message : String(err);
        codehydraApi.log.warn("Layout command failed", { command, error });
      }
    }

    // Open agent terminal if env vars and agent type are available
    if (config.env !== null && config.agentType !== null) {
      openAgentTerminal(config.agentType, config.env);
    }

    // Execute post-terminal layout commands
    const postLayoutCommands = [
      "codehydra.dictation.openPanel", // Open dictation tab in background (no-op if no API key)
    ];
    for (const command of postLayoutCommands) {
      try {
        await vscode.commands.executeCommand(command);
      } catch (err: unknown) {
        const error = err instanceof Error ? err.message : String(err);
        codehydraApi.log.warn("Layout command failed", { command, error });
      }
    }

    // Register debug commands in development mode
    if (isDevelopment && extensionContext) {
      registerDebugCommands(extensionContext);
    }
  });

  socket.on("connect", () => {
    codehydraApi.log.info("Connected to PluginServer");
  });

  socket.on("disconnect", (reason) => {
    codehydraApi.log.info("Disconnected from PluginServer", { reason });
    isConnected = false;
  });

  socket.on("connect_error", (err) => {
    codehydraApi.log.error("Connection error", { error: err.message });
  });

  socket.on("command", async (request: CommandRequest, ack) => {
    codehydraApi.log.debug("Command received", { command: request.command });

    try {
      // Reconstruct VS Code objects from $vscode wrappers
      const rawArgs = request.args ?? [];
      const args = reconstructVscodeObjects(rawArgs, vscodeFactories) as unknown[];
      const result = await vscode.commands.executeCommand(request.command, ...args);
      codehydraApi.log.debug("Command executed", { command: request.command });
      ack({ success: true, data: result });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      codehydraApi.log.error("Command failed", { command: request.command, error: errorMessage });
      ack({ success: false, error: errorMessage });
    }
  });

  socket.on("shutdown", async (ack) => {
    codehydraApi.log.info("Shutdown received");

    await killAllTerminalsAndWait();

    try {
      const folders = vscode.workspace.workspaceFolders;
      if (folders && folders.length > 0) {
        vscode.workspace.updateWorkspaceFolders(0, folders.length);
        codehydraApi.log.debug("Removed workspace folders", { count: folders.length });
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      codehydraApi.log.error("Graceful shutdown failed", { error });
    }

    ack({ success: true, data: undefined });

    codehydraApi.log.info("Exiting extension host");
    setImmediate(() => process.exit(0));
  });

  socket.connect();
}

// ============================================================================
// Extension Lifecycle
// ============================================================================

export function activate(context: vscode.ExtensionContext): { codehydra: typeof codehydraApi } {
  extensionContext = context;

  // Set up terminal close listener for singleton management
  setupTerminalCloseListener();

  context.subscriptions.push(
    vscode.commands.registerCommand("codehydra.restartAgentServer", async () => {
      try {
        const port = await codehydraApi.workspace.restartAgentServer();
        await vscode.window.showInformationMessage(`Agent server restarted on port ${port}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await vscode.window.showErrorMessage(`Failed to restart agent server: ${message}`);
      }
    })
  );

  const pluginPortStr = process.env.CODEHYDRA_PLUGIN_PORT;
  if (!pluginPortStr) {
    return { codehydra: codehydraApi };
  }

  const pluginPort = parseInt(pluginPortStr, 10);
  if (isNaN(pluginPort) || pluginPort <= 0 || pluginPort > 65535) {
    return { codehydra: codehydraApi };
  }

  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    // No folder loaded - reload the window to retry
    // This handles a race condition where VS Code sometimes fails to open
    // the folder from a .code-workspace file
    void vscode.commands.executeCommand("workbench.action.reloadWindow");
    return { codehydra: codehydraApi };
  }

  // Handle noUncheckedIndexedAccess
  const firstFolder = workspaceFolders[0];
  if (!firstFolder) {
    return { codehydra: codehydraApi };
  }
  const workspacePath = path.normalize(firstFolder.uri.fsPath);

  connectToPluginServer(pluginPort, workspacePath);

  return { codehydra: codehydraApi };
}

export function deactivate(): void {
  if (socket) {
    codehydraApi.log.info("Deactivating");
    socket.disconnect();
    socket = null;
  }
  isConnected = false;

  // Clean up terminal close listener
  if (terminalCloseListener) {
    terminalCloseListener.dispose();
    terminalCloseListener = null;
  }

  // Reset terminal reference (don't dispose - let VS Code handle it)
  agentTerminal = null;

  if (debugOutputChannel) {
    debugOutputChannel.dispose();
    debugOutputChannel = null;
  }

  void vscode.commands.executeCommand("setContext", "codehydra.isDevelopment", false);

  extensionContext = null;
  isDevelopment = false;
  currentWorkspacePath = "";
  currentPluginPort = null;

  const pending = pendingReady;
  pendingReady = [];
  for (const { reject } of pending) {
    reject(new Error("Extension deactivating"));
  }
}
