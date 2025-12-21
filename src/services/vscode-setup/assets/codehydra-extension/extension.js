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

/** @type {import('socket.io-client').Socket | null} */
let socket = null;

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
  });

  socket.on("disconnect", (reason) => {
    log(`Disconnected from PluginServer: ${reason}`);
  });

  socket.on("connect_error", (err) => {
    logError(`Connection error: ${err.message}`);
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
 */
async function activate(_context) {
  // Wait briefly for VS Code UI to stabilize
  setTimeout(async () => {
    try {
      // Hide sidebars to maximize editor space
      await vscode.commands.executeCommand("workbench.action.closeSidebar");
      await vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
      // Open OpenCode terminal automatically for AI workflow
      await vscode.commands.executeCommand("opencode.openTerminal");
      // Unlock the editor group so files open in the same tab group
      await vscode.commands.executeCommand("workbench.action.unlockEditorGroup");
      // Clean up empty editor groups created by terminal opening
      await vscode.commands.executeCommand("workbench.action.closeEditorsInOtherGroups");
    } catch (err) {
      logError("Startup commands error:", err);
    }
  }, 100);

  // Get plugin port from environment
  const pluginPortStr = process.env.CODEHYDRA_PLUGIN_PORT;
  if (!pluginPortStr) {
    log("CODEHYDRA_PLUGIN_PORT not set - plugin communication disabled");
    return;
  }

  const pluginPort = parseInt(pluginPortStr, 10);
  if (isNaN(pluginPort) || pluginPort <= 0 || pluginPort > 65535) {
    logError(`Invalid CODEHYDRA_PLUGIN_PORT: ${pluginPortStr}`);
    return;
  }

  // Get workspace path
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    logError("No workspace folder open - cannot connect to PluginServer");
    return;
  }

  const workspacePath = path.normalize(workspaceFolders[0].uri.fsPath);
  log(`Workspace path: ${workspacePath}`);

  // Connect to PluginServer
  connectToPluginServer(pluginPort, workspacePath);
}

function deactivate() {
  if (socket) {
    log("Disconnecting from PluginServer");
    socket.disconnect();
    socket = null;
  }
}

module.exports = { activate, deactivate };
