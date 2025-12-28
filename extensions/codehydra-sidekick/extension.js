const vscode = require("vscode");
const path = require("path");
const { io } = require("socket.io-client");

/**
 * @typedef {Object} CommandRequest
 * @property {string} command - VS Code command identifier
 * @property {unknown[]} [args] - Optional arguments to pass to the command
 */

/**
 * @typedef {Object} PluginResultSuccess
 * @property {true} success
 * @property {unknown} data
 */

/**
 * @typedef {Object} PluginResultError
 * @property {false} success
 * @property {string} error
 */

/**
 * @typedef {PluginResultSuccess | PluginResultError} PluginResult
 */

/**
 * @typedef {Object} WorkspaceStatus
 * @property {boolean} isDirty
 * @property {{ type: 'none' } | { type: 'idle' | 'busy' | 'mixed', counts: { idle: number, busy: number, total: number } }} agent
 */

/**
 * @typedef {Object} SetMetadataRequest
 * @property {string} key
 * @property {string | null} value
 */

/**
 * @typedef {Object} PluginConfig
 * @property {boolean} isDevelopment
 */

/** @type {import('socket.io-client').Socket | null} */
let socket = null;

/** @type {boolean} */
let isConnected = false;

/** @type {Array<{ resolve: () => void, reject: (error: Error) => void }>} */
let pendingReady = [];

/** Timeout for API calls in milliseconds (matches COMMAND_TIMEOUT_MS) */
const API_TIMEOUT_MS = 10000;

/** Timeout for terminal kill operations in milliseconds */
const TERMINAL_KILL_TIMEOUT_MS = 5000;

// ============================================================================
// Development Mode State Variables
// ============================================================================

/** @type {boolean} */
let isDevelopment = false;

/** @type {vscode.OutputChannel | null} */
let debugOutputChannel = null;

/** @type {string} */
let currentWorkspacePath = "";

/** @type {number | null} */
let currentPluginPort = null;

/** @type {vscode.ExtensionContext | null} */
let extensionContext = null;

// ============================================================================
// API Utilities
// ============================================================================

/**
 * Emit an API call with timeout handling.
 * @template T
 * @param {string} event - Event name
 * @param {unknown} [request] - Request payload (optional for parameterless calls)
 * @returns {Promise<T>} Resolves with data on success, rejects with Error on failure
 */
function emitApiCall(event, request) {
  return new Promise((resolve, reject) => {
    if (!socket) {
      reject(new Error("Not connected to CodeHydra"));
      return;
    }

    const timeout = setTimeout(() => {
      codehydraApi.log.warn("API call timeout", { event });
      reject(new Error(`API call timed out: ${event}`));
    }, API_TIMEOUT_MS);

    /**
     * @param {PluginResult} result
     */
    const handleResult = (result) => {
      clearTimeout(timeout);
      if (result.success) {
        resolve(result.data);
      } else {
        reject(new Error(result.error));
      }
    };

    // Emit with or without request based on event type
    if (request !== undefined) {
      socket.emit(event, request, handleResult);
    } else {
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
 *
 * @example
 * ```javascript
 * const ext = vscode.extensions.getExtension('codehydra.sidekick');
 * const api = ext?.exports?.codehydra;
 * if (!api) throw new Error('codehydra extension not available');
 *
 * await api.whenReady();
 * const status = await api.workspace.getStatus();
 * const metadata = await api.workspace.getMetadata();
 * await api.workspace.setMetadata('note', 'Working on feature X');
 * ```
 */
const codehydraApi = {
  /**
   * Wait for the extension to be connected to CodeHydra.
   * Resolves immediately if already connected.
   * @returns {Promise<void>}
   */
  whenReady() {
    if (isConnected && socket && socket.connected) {
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
    /**
     * Log a silly message (most verbose).
     * @param {string} message - Log message
     * @param {Record<string, string | number | boolean | null>} [context] - Optional context data
     */
    silly(message, context) {
      if (!socket?.connected) return;
      socket.emit("api:log", { level: "silly", message, context });
    },

    /**
     * Log a debug message.
     * @param {string} message - Log message
     * @param {Record<string, string | number | boolean | null>} [context] - Optional context data
     */
    debug(message, context) {
      if (!socket?.connected) return;
      socket.emit("api:log", { level: "debug", message, context });
    },

    /**
     * Log an info message.
     * @param {string} message - Log message
     * @param {Record<string, string | number | boolean | null>} [context] - Optional context data
     */
    info(message, context) {
      if (!socket?.connected) return;
      socket.emit("api:log", { level: "info", message, context });
    },

    /**
     * Log a warning message.
     * @param {string} message - Log message
     * @param {Record<string, string | number | boolean | null>} [context] - Optional context data
     */
    warn(message, context) {
      if (!socket?.connected) return;
      socket.emit("api:log", { level: "warn", message, context });
    },

    /**
     * Log an error message.
     * @param {string} message - Log message
     * @param {Record<string, string | number | boolean | null>} [context] - Optional context data
     */
    error(message, context) {
      if (!socket?.connected) return;
      socket.emit("api:log", { level: "error", message, context });
    },
  },

  /**
   * Workspace API namespace.
   * All methods require the connection to be established (use whenReady() first).
   */
  workspace: {
    /**
     * Get the current status of this workspace.
     * @returns {Promise<WorkspaceStatus>} Workspace status including dirty flag and agent status
     */
    getStatus() {
      return emitApiCall("api:workspace:getStatus");
    },

    /**
     * Get the OpenCode server port for this workspace.
     * Returns the port number if the OpenCode server is running, or null if not running.
     *
     * @returns {Promise<number | null>} Port number or null if server not running
     * @example
     * ```javascript
     * const port = await api.workspace.getOpencodePort();
     * if (port !== null) {
     *   console.log(`OpenCode server running on port ${port}`);
     *   // Connect to OpenCode server at http://localhost:${port}
     * }
     * ```
     */
    getOpencodePort() {
      return emitApiCall("api:workspace:getOpencodePort");
    },

    /**
     * Get all metadata for this workspace.
     * @returns {Promise<Record<string, string>>} Metadata record (always includes 'base' key)
     */
    getMetadata() {
      return emitApiCall("api:workspace:getMetadata");
    },

    /**
     * Set or delete a metadata value for this workspace.
     * @param {string} key - Metadata key (must match /^[A-Za-z][A-Za-z0-9-]*$/)
     * @param {string | null} value - Value to set, or null to delete the key
     * @returns {Promise<void>}
     */
    setMetadata(key, value) {
      return emitApiCall("api:workspace:setMetadata", { key, value });
    },

    /**
     * Execute a VS Code command in this workspace.
     * @param {string} command - VS Code command identifier (e.g., "workbench.action.files.save")
     * @param {unknown[]} [args] - Optional arguments to pass to the command
     * @returns {Promise<unknown>} The command's return value, or undefined if command returns nothing
     */
    executeCommand(command, args) {
      // Client-side validation
      if (typeof command !== "string" || command.trim().length === 0) {
        return Promise.reject(new Error("Command must be a non-empty string"));
      }
      if (args !== undefined && !Array.isArray(args)) {
        return Promise.reject(new Error("Args must be an array"));
      }
      return emitApiCall("api:workspace:executeCommand", { command, args });
    },
  },
};

// ============================================================================
// Debug Commands (Development Only)
// ============================================================================

/**
 * Get or create the debug output channel.
 * @returns {vscode.OutputChannel}
 */
function getDebugOutputChannel() {
  if (!debugOutputChannel) {
    debugOutputChannel = vscode.window.createOutputChannel("CodeHydra Debug");
  }
  return debugOutputChannel;
}

/**
 * Safely format a result for display in output channel.
 * @param {unknown} result
 * @returns {string}
 */
function formatResult(result) {
  try {
    return JSON.stringify(result, null, 2);
  } catch (e) {
    return `[Serialization error: ${e instanceof Error ? e.message : String(e)}]`;
  }
}

/**
 * Log a successful debug command result to the output channel.
 * @param {string} name - Command name
 * @param {unknown} data - Result data
 */
function logDebugResult(name, data) {
  const channel = getDebugOutputChannel();
  const timestamp = new Date().toISOString();
  channel.appendLine(`=== ${name} [${timestamp}] ===`);
  channel.appendLine(formatResult(data));
  channel.appendLine("");
  channel.show(true); // Show but don't steal focus
}

/**
 * Log a debug command error to the output channel.
 * @param {string} name - Command name
 * @param {Error} err - The error
 */
function logDebugError(name, err) {
  const channel = getDebugOutputChannel();
  const timestamp = new Date().toISOString();
  channel.appendLine(`=== ${name} [${timestamp}] ERROR ===`);
  channel.appendLine(err.message);
  channel.appendLine("");
  channel.show(true);
}

/**
 * Run a debug command and handle result/error logging.
 * @param {string} name - Command name for display
 * @param {() => Promise<unknown>} fn - Async function to execute
 */
async function runDebugCommand(name, fn) {
  try {
    const result = await fn();
    logDebugResult(name, result);
  } catch (err) {
    logDebugError(name, err instanceof Error ? err : new Error(String(err)));
  }
}

/**
 * Register debug commands for development mode.
 * @param {vscode.ExtensionContext} context
 */
function registerDebugCommands(context) {
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

  // Debug: Get OpenCode Port
  context.subscriptions.push(
    vscode.commands.registerCommand("codehydra.debug.getOpencodePort", async () => {
      await runDebugCommand("getOpencodePort", () => codehydraApi.workspace.getOpencodePort());
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

/**
 * Kill all terminals and wait for them to close.
 * Returns after all terminals are closed OR after timeout.
 * @returns {Promise<void>}
 */
async function killAllTerminalsAndWait() {
  const terminals = [...vscode.window.terminals];

  if (terminals.length === 0) {
    codehydraApi.log.debug("No terminals to kill");
    return;
  }

  codehydraApi.log.debug("Killing terminals", { count: terminals.length });
  const pendingTerminals = new Set(terminals);

  await new Promise((resolve) => {
    let resolved = false;

    const done = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      disposable.dispose(); // Clean up listener
      resolve();
    };

    // Set up timeout - proceed anyway after 5 seconds
    const timeout = setTimeout(() => {
      codehydraApi.log.warn("Terminal kill timeout", { remaining: pendingTerminals.size });
      done();
    }, TERMINAL_KILL_TIMEOUT_MS);

    // IMPORTANT: Set up listener BEFORE disposing terminals to avoid race condition
    const disposable = vscode.window.onDidCloseTerminal((closedTerminal) => {
      pendingTerminals.delete(closedTerminal);
      codehydraApi.log.debug("Terminal closed", { remaining: pendingTerminals.size });
      if (pendingTerminals.size === 0) {
        codehydraApi.log.debug("All terminals closed");
        done();
      }
    });

    // Dispose all terminals AFTER listener is set up
    for (const terminal of terminals) {
      terminal.dispose();
    }

    // Check in case all terminals closed synchronously (unlikely but safe)
    if (pendingTerminals.size === 0) {
      codehydraApi.log.debug("All terminals closed (sync)");
      done();
    }
  });
}

// ============================================================================
// PluginServer Connection
// ============================================================================

/**
 * Connect to the CodeHydra PluginServer.
 * @param {number} port - Port number to connect to
 * @param {string} workspacePath - Normalized workspace path
 */
function connectToPluginServer(port, workspacePath) {
  // Store for debug commands
  currentWorkspacePath = workspacePath;
  currentPluginPort = port;

  const url = `http://localhost:${port}`;
  socket = io(url, {
    transports: ["websocket"],
    auth: {
      workspacePath: workspacePath,
    },
    // Exponential backoff reconnection
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
    reconnectionAttempts: Infinity,
    // Don't connect until all handlers are registered
    autoConnect: false,
  });

  // Handle config event - must be registered before socket.connect() is called.
  // The server emits "config" immediately after connection validation.
  socket.on("config", (config) => {
    // Runtime validation - silently ignore invalid config
    if (typeof config !== "object" || config === null) {
      return;
    }
    if (typeof config.isDevelopment !== "boolean") {
      return;
    }

    isDevelopment = config.isDevelopment;
    codehydraApi.log.debug("Config received", { isDevelopment });

    // Set context for command enablement (enables commands in Command Palette)
    vscode.commands.executeCommand("setContext", "codehydra.isDevelopment", isDevelopment);

    if (isDevelopment && extensionContext) {
      registerDebugCommands(extensionContext);
    }
  });

  socket.on("connect", () => {
    isConnected = true;
    codehydraApi.log.info("Connected to PluginServer");

    // Resolve all pending whenReady() promises
    const pending = pendingReady;
    pendingReady = [];
    for (const { resolve } of pending) {
      resolve();
    }

    // Set opencode port env var for terminals
    codehydraApi.workspace
      .getOpencodePort()
      .then((port) => {
        if (port !== null && extensionContext) {
          extensionContext.environmentVariableCollection.replace(
            "CODEHYDRA_OPENCODE_PORT",
            String(port)
          );
          codehydraApi.log.debug("Set CODEHYDRA_OPENCODE_PORT", { port });
        }
      })
      .catch((err) => {
        const error = err instanceof Error ? err.message : String(err);
        codehydraApi.log.warn("Failed to get opencode port", { error });
      });
  });

  socket.on("disconnect", (reason) => {
    codehydraApi.log.info("Disconnected from PluginServer", { reason });
    isConnected = false;
  });

  socket.on("connect_error", (err) => {
    codehydraApi.log.error("Connection error", { error: err.message });
    // Note: We don't reject pending promises here because Socket.IO will retry
    // Only if the connection is permanently failed should we reject
  });

  // Handle command requests from CodeHydra
  socket.on("command", async (request, ack) => {
    codehydraApi.log.debug("Command received", { command: request.command });

    try {
      const args = request.args ?? [];
      const result = await vscode.commands.executeCommand(request.command, ...args);
      codehydraApi.log.debug("Command executed", { command: request.command });
      ack({ success: true, data: result });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      codehydraApi.log.error("Command failed", { command: request.command, error: errorMessage });
      ack({ success: false, error: errorMessage });
    }
  });

  // Handle shutdown request for workspace deletion
  // This terminates the extension host to release file handles
  socket.on("shutdown", async (ack) => {
    codehydraApi.log.info("Shutdown received");

    // Step 1: Kill all terminals and wait for them to close
    await killAllTerminalsAndWait();

    // Step 2: Graceful cleanup - remove workspace folders (releases file watchers)
    try {
      const folders = vscode.workspace.workspaceFolders;
      if (folders && folders.length > 0) {
        vscode.workspace.updateWorkspaceFolders(0, folders.length);
        codehydraApi.log.debug("Removed workspace folders", { count: folders.length });
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      codehydraApi.log.error("Graceful shutdown failed", { error });
      // Continue anyway - we're exiting
    }

    // Send ack before exit
    ack({ success: true, data: undefined });

    // Use setImmediate to allow ack to flush before exit
    codehydraApi.log.info("Exiting extension host");
    setImmediate(() => process.exit(0));
  });

  // All handlers registered, now connect
  socket.connect();
}

// ============================================================================
// Extension Lifecycle
// ============================================================================

/**
 * @param {vscode.ExtensionContext} context
 * @returns {{ codehydra: typeof codehydraApi }}
 */
function activate(context) {
  // Store context for debug command registration
  extensionContext = context;

  // NOTE: Startup commands (close sidebars, open terminal, etc.) are now handled
  // by CodeHydra main process via PluginServer.onConnect() callback when this
  // extension connects. See src/main/index.ts startServices() and
  // src/services/plugin-server/startup-commands.ts for implementation.

  // Get plugin port from environment
  const pluginPortStr = process.env.CODEHYDRA_PLUGIN_PORT;
  if (!pluginPortStr) {
    // Plugin communication disabled - return API anyway (methods will reject with "Not connected" error)
    return { codehydra: codehydraApi };
  }

  const pluginPort = parseInt(pluginPortStr, 10);
  if (isNaN(pluginPort) || pluginPort <= 0 || pluginPort > 65535) {
    // Invalid port - return API anyway
    return { codehydra: codehydraApi };
  }

  // Get workspace path
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    // No workspace folder open - return API anyway
    return { codehydra: codehydraApi };
  }

  const workspacePath = path.normalize(workspaceFolders[0].uri.fsPath);

  // Connect to PluginServer
  connectToPluginServer(pluginPort, workspacePath);

  // Return the API for other extensions to use
  return { codehydra: codehydraApi };
}

function deactivate() {
  if (socket) {
    codehydraApi.log.info("Deactivating");
    socket.disconnect();
    socket = null;
  }
  isConnected = false;

  // Clear environment variable collection (removes CODEHYDRA_OPENCODE_PORT from terminals)
  if (extensionContext) {
    extensionContext.environmentVariableCollection.clear();
  }

  // Dispose output channel
  if (debugOutputChannel) {
    debugOutputChannel.dispose();
    debugOutputChannel = null;
  }

  // Note: Debug commands registered via registerDebugCommands() are automatically
  // disposed when the extension deactivates because they were added to context.subscriptions.
  // No explicit cleanup is needed for them.

  // Clear development context
  vscode.commands.executeCommand("setContext", "codehydra.isDevelopment", false);

  // Clear state
  extensionContext = null;
  isDevelopment = false;
  currentWorkspacePath = "";
  currentPluginPort = null;

  // Reject any pending whenReady() promises
  const pending = pendingReady;
  pendingReady = [];
  for (const { reject } of pending) {
    reject(new Error("Extension deactivating"));
  }
}

module.exports = { activate, deactivate };
