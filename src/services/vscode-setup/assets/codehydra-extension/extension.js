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

/** @type {import('socket.io-client').Socket | null} */
let socket = null;

/** @type {boolean} */
let isConnected = false;

/** @type {Array<{ resolve: () => void, reject: (error: Error) => void }>} */
let pendingReady = [];

/** Timeout for API calls in milliseconds (matches COMMAND_TIMEOUT_MS) */
const API_TIMEOUT_MS = 10000;

/**
 * Log messages with prefix for easy identification in console.
 * @param {string} message
 * @param {...unknown} args
 */
function log(message, ...args) {
  console.log(`[codehydra] ${message}`, ...args);
}

/**
 * Log errors with prefix.
 * @param {string} message
 * @param {...unknown} args
 */
function logError(message, ...args) {
  console.error(`[codehydra] ${message}`, ...args);
}

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

/**
 * CodeHydra API for VS Code extensions.
 * Provides access to workspace status and metadata.
 *
 * @example
 * ```javascript
 * const ext = vscode.extensions.getExtension('codehydra.codehydra');
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
  },
};

/**
 * Connect to the CodeHydra PluginServer.
 * @param {number} port - Port number to connect to
 * @param {string} workspacePath - Normalized workspace path
 */
function connectToPluginServer(port, workspacePath) {
  const url = `http://localhost:${port}`;

  log(`Connecting to PluginServer at ${url}`);

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
  });

  socket.on("connect", () => {
    log("Connected to PluginServer");
    isConnected = true;

    // Resolve all pending whenReady() promises
    const pending = pendingReady;
    pendingReady = [];
    for (const { resolve } of pending) {
      resolve();
    }
  });

  socket.on("disconnect", (reason) => {
    log(`Disconnected from PluginServer: ${reason}`);
    isConnected = false;
  });

  socket.on("connect_error", (err) => {
    logError(`Connection error: ${err.message}`);
    // Note: We don't reject pending promises here because Socket.IO will retry
    // Only if the connection is permanently failed should we reject
  });

  // Handle command requests from CodeHydra
  socket.on("command", async (request, ack) => {
    log(`Received command: ${request.command}`);

    try {
      const args = request.args ?? [];
      const result = await vscode.commands.executeCommand(request.command, ...args);
      log(`Command executed: ${request.command}`);
      ack({ success: true, data: result });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logError(`Command failed: ${request.command} - ${errorMessage}`);
      ack({ success: false, error: errorMessage });
    }
  });
}

/**
 * @param {vscode.ExtensionContext} _context
 * @returns {{ codehydra: typeof codehydraApi }}
 */
function activate(_context) {
  // NOTE: Startup commands (close sidebars, open terminal, etc.) are now handled
  // by CodeHydra main process via PluginServer.onConnect() callback when this
  // extension connects. See src/main/index.ts startServices() and
  // src/services/plugin-server/startup-commands.ts for implementation.

  // Get plugin port from environment
  const pluginPortStr = process.env.CODEHYDRA_PLUGIN_PORT;
  if (!pluginPortStr) {
    log("CODEHYDRA_PLUGIN_PORT not set - plugin communication disabled");
    // Return API anyway (methods will reject with "Not connected" error)
    return { codehydra: codehydraApi };
  }

  const pluginPort = parseInt(pluginPortStr, 10);
  if (isNaN(pluginPort) || pluginPort <= 0 || pluginPort > 65535) {
    logError(`Invalid CODEHYDRA_PLUGIN_PORT: ${pluginPortStr}`);
    return { codehydra: codehydraApi };
  }

  // Get workspace path
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    logError("No workspace folder open - cannot connect to PluginServer");
    return { codehydra: codehydraApi };
  }

  const workspacePath = path.normalize(workspaceFolders[0].uri.fsPath);
  log(`Workspace path: ${workspacePath}`);

  // Connect to PluginServer
  connectToPluginServer(pluginPort, workspacePath);

  // Return the API for other extensions to use
  return { codehydra: codehydraApi };
}

function deactivate() {
  if (socket) {
    log("Disconnecting from PluginServer");
    socket.disconnect();
    socket = null;
  }
  isConnected = false;

  // Reject any pending whenReady() promises
  const pending = pendingReady;
  pendingReady = [];
  for (const { reject } of pending) {
    reject(new Error("Extension deactivating"));
  }
}

module.exports = { activate, deactivate };
