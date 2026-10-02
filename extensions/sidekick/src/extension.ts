/**
 * CodeHydra Sidekick: the extension running in every workspace's editor.
 *
 * Connects to CodeHydra's API server (connection.ts), opens and stops the
 * agent terminal (agent-terminal.ts), serves the server's `ui:*` requests
 * (ui-handlers.ts) and its command/shutdown requests (here), contributes the
 * workspace commands (workspace-commands.ts), and exports the CodeHydra API
 * to other extensions (codehydra-api.ts).
 */
import * as vscode from "vscode";
import * as path from "path";
import {
  reconstructVscodeObjects,
  type VscodeFactories,
} from "../../../src/shared/vscode-serialization";
import { getErrorMessage, toError } from "../../../src/shared/error-utils";
import {
  closeAgentTerminal,
  configureAgent,
  initAgentTerminal,
  killAllTerminalsAndWait,
  openConfiguredAgent,
  resetAgentTerminal,
} from "./agent-terminal";
import { codehydraApi } from "./codehydra-api";
import { connectToApiServer, connectionInfo, disconnectFromApiServer } from "./connection";
import { disposeUiHandlers, registerUiHandlers } from "./ui-handlers";
import { registerWorkspaceCommands } from "./workspace-commands";
import type { ApiConfig, CommandRequest, TypedSocket } from "./types";

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

interface ExtensionState {
  context: vscode.ExtensionContext | null;
  /** From the server's config: whether CodeHydra runs in development mode. */
  isDevelopment: boolean;
  /** Development-only output for the debug commands. */
  debugOutputChannel: vscode.OutputChannel | null;
}

const state: ExtensionState = {
  context: null,
  isDevelopment: false,
  debugOutputChannel: null,
};

/**
 * Give every terminal opened in this workspace the workspace environment.
 *
 * Through the extension's environment variable collection, which VS Code applies
 * to each new terminal. Not persistent: the values stay in memory, and the next
 * open delivers them afresh — they must not end up in the editor's storage.
 * Replaced wholesale, so a key the hook stopped returning does not linger.
 */
function applyWorkspaceEnv(workspaceEnv: Record<string, string> | null | undefined): void {
  const collection = state.context?.environmentVariableCollection;
  if (!collection) return;
  collection.persistent = false;
  collection.clear();
  for (const [name, value] of Object.entries(workspaceEnv ?? {})) {
    collection.replace(name, value);
  }
}

// ============================================================================
// Debug Commands (Development Only)
// ============================================================================

function getDebugOutputChannel(): vscode.OutputChannel {
  if (!state.debugOutputChannel) {
    state.debugOutputChannel = vscode.window.createOutputChannel("CodeHydra Debug");
  }
  return state.debugOutputChannel;
}

function formatResult(result: unknown): string {
  try {
    return JSON.stringify(result, null, 2);
  } catch (e) {
    return `[Serialization error: ${getErrorMessage(e)}]`;
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
    logDebugError(name, toError(err));
  }
}

function registerDebugCommands(context: vscode.ExtensionContext): void {
  // Debug: Get Workspace Status
  context.subscriptions.push(
    vscode.commands.registerCommand("codehydra.debug.getStatus", async () => {
      await runDebugCommand("getStatus", () => codehydraApi.workspace.getStatus());
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
      logDebugResult("connectionInfo", {
        ...connectionInfo(),
        isDevelopment: state.isDevelopment,
      });
    })
  );

  codehydraApi.log.debug("Debug commands registered");
}

// ============================================================================
// ApiServer requests
// ============================================================================

/**
 * The server's config: on the first one, lay out a new workspace, apply the
 * workspace env, open the agent terminal and (in development) register the
 * debug commands. A reconnect only refreshes the development flag.
 */
async function handleConfig(config: ApiConfig, isReconnect: boolean): Promise<void> {
  state.isDevelopment = config.isDevelopment;
  codehydraApi.log.debug("Config received", {
    isDevelopment: state.isDevelopment,
    hasEnv: config.env !== null,
    agentType: config.agentType,
    isReconnect,
  });

  await vscode.commands.executeCommand(
    "setContext",
    "codehydra.isDevelopment",
    state.isDevelopment
  );

  // Skip setup on reconnect — the sidekick is already configured
  if (isReconnect) {
    return;
  }

  // Execute pre-terminal layout commands (only for new workspaces)
  if (config.resetWorkspace) {
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
        codehydraApi.log.warn("Layout command failed", { command, error: getErrorMessage(err) });
      }
    }
  }

  applyWorkspaceEnv(config.workspaceEnv);

  // Open agent terminal if env vars and agent type are available
  if (config.env !== null && config.agentType !== null) {
    configureAgent(config.agentType, config.env, config.resetWorkspace);

    // Focus the terminal only for new workspaces
    if (config.resetWorkspace) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await vscode.commands.executeCommand("workbench.action.terminal.focus");
    }
  }

  // Register debug commands in development mode
  if (state.isDevelopment && state.context) {
    registerDebugCommands(state.context);
  }
}

/** The server's `command` (run a VS Code command) and `shutdown` requests. */
function registerWorkspaceHandlers(socket: TypedSocket): void {
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
      const errorMessage = getErrorMessage(err);
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
      codehydraApi.log.error("Graceful shutdown failed", { error: getErrorMessage(err) });
    }

    ack({ success: true, data: undefined });

    codehydraApi.log.info("Exiting extension host");
    setImmediate(() => process.exit(0));
  });
}

// ============================================================================
// Extension Lifecycle
// ============================================================================

function registerAgentCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("codehydra.restartAgentServer", async () => {
      try {
        const port = await codehydraApi.workspace.restartAgentServer();
        await vscode.window.showInformationMessage(`Agent server restarted on port ${port}`);
      } catch (err) {
        await vscode.window.showErrorMessage(
          `Failed to restart agent server: ${getErrorMessage(err)}`
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codehydra.openAgent", () => {
      if (!openConfiguredAgent()) {
        void vscode.window.showWarningMessage("Agent not yet configured");
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codehydra.closeAgent", () => {
      // Reports whether there was a terminal at all — not whether it has closed.
      // Closing is asynchronous and is reported separately via the "close" agent
      // lifecycle event; `closed: false` lets a caller waiting for that event
      // skip the wait instead of burning its whole timeout on a workspace that
      // never had a terminal open.
      return { closed: closeAgentTerminal() };
    })
  );
}

/**
 * Where to reach the API server: its port (`_CH_API_PORT`) and this
 * workspace's path, or null when this editor is not a CodeHydra workspace.
 */
function resolveApiServer(): { port: number; workspacePath: string } | null {
  const apiPortStr = process.env._CH_API_PORT;
  if (!apiPortStr) {
    return null;
  }

  const port = parseInt(apiPortStr, 10);
  if (isNaN(port) || port <= 0 || port > 65535) {
    return null;
  }

  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    // No folder loaded - reload the window to retry
    // This handles a race condition where VS Code sometimes fails to open
    // the folder from a .code-workspace file
    void vscode.commands.executeCommand("workbench.action.reloadWindow");
    return null;
  }

  // Handle noUncheckedIndexedAccess
  const firstFolder = workspaceFolders[0];
  if (!firstFolder) {
    return null;
  }
  return { port, workspacePath: path.normalize(firstFolder.uri.fsPath) };
}

export function activate(context: vscode.ExtensionContext): { codehydra: typeof codehydraApi } {
  state.context = context;

  // Set up terminal close listener for singleton management
  initAgentTerminal(context.workspaceState);

  registerAgentCommands(context);
  registerWorkspaceCommands(context);

  const server = resolveApiServer();
  if (server) {
    connectToApiServer(server.port, server.workspacePath, {
      onConfig: handleConfig,
      register: (socket) => {
        registerWorkspaceHandlers(socket);
        registerUiHandlers(socket);
      },
    });
  }

  return { codehydra: codehydraApi };
}

export function deactivate(): void {
  disposeUiHandlers();
  disconnectFromApiServer();

  // Reset terminal tracking (don't dispose the terminal - let VS Code handle it)
  resetAgentTerminal();

  if (state.debugOutputChannel) {
    state.debugOutputChannel.dispose();
    state.debugOutputChannel = null;
  }

  void vscode.commands.executeCommand("setContext", "codehydra.isDevelopment", false);

  state.context = null;
  state.isDevelopment = false;
}
