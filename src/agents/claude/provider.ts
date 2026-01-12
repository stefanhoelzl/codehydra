/**
 * Claude Code Provider - manages status tracking for a single workspace.
 *
 * Unlike OpenCodeProvider which creates its own SDK client, ClaudeCodeProvider:
 * - Subscribes to ServerManager for status changes
 * - Simpler because user interacts with Claude directly (not through us)
 * - Returns environment variables for sidekick to set in terminal
 *
 * The provider bridges between:
 * - ServerManager (receives hook notifications, tracks status)
 * - AgentStatusManager (aggregates status across workspaces)
 */

import type { AgentProvider, AgentSessionInfo, AgentStatus } from "../types";
import type { ClaudeCodeServerManager } from "./server-manager";
import type { Logger } from "../../services/logging";

/**
 * Dependencies for ClaudeCodeProvider.
 */
export interface ClaudeCodeProviderDeps {
  readonly serverManager: ClaudeCodeServerManager;
  readonly workspacePath: string;
  readonly logger: Logger;
}

/**
 * Claude Code Provider implementation.
 *
 * Key differences from OpenCodeProvider:
 * - No SDK client (user runs Claude CLI directly)
 * - Subscribes to ServerManager for status updates
 * - Environment variables tell sidekick how to configure Claude CLI
 */
export class ClaudeCodeProvider implements AgentProvider {
  /**
   * VS Code commands to execute on workspace activation.
   * Uses the Claude Code VS Code extension's terminal.open command to open the terminal.
   */
  readonly startupCommands: readonly string[] = ["claude-vscode.terminal.open"] as const;

  private readonly serverManager: ClaudeCodeServerManager;
  private readonly workspacePath: string;
  private readonly logger: Logger;

  /** Port of the bridge server (set during connect) */
  private port: number | null = null;

  /** Status change callbacks */
  private readonly statusCallbacks = new Set<(status: AgentStatus) => void>();

  /** Unsubscribe function for ServerManager status changes */
  private unsubscribe: (() => void) | null = null;

  /** Whether agent has been marked active (first activity detected) */
  private active = false;

  constructor(deps: ClaudeCodeProviderDeps) {
    this.serverManager = deps.serverManager;
    this.workspacePath = deps.workspacePath;
    this.logger = deps.logger;
  }

  /**
   * Connect to the bridge server at the given port.
   * Subscribes to ServerManager status changes for this workspace.
   */
  async connect(port: number): Promise<void> {
    if (this.unsubscribe) {
      // Already connected
      return;
    }

    this.port = port;

    // Subscribe to status changes from ServerManager
    this.unsubscribe = this.serverManager.onStatusChange(this.workspacePath, (status) => {
      this.notifyStatusChange(status);
    });

    this.logger.info("Provider connected", {
      workspacePath: this.workspacePath,
      port: this.port,
    });
  }

  /**
   * Disconnect from status updates.
   * Preserves port for reconnection.
   */
  disconnect(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    // Keep port for reconnect
    // Keep active state for reconnect

    this.logger.info("Provider disconnected", {
      workspacePath: this.workspacePath,
    });
  }

  /**
   * Reconnect after server restart.
   * Re-subscribes to ServerManager status changes.
   */
  async reconnect(): Promise<void> {
    if (this.port === null) {
      this.logger.warn("Cannot reconnect: no port stored", {
        workspacePath: this.workspacePath,
      });
      return;
    }

    // Re-subscribe to status changes
    this.unsubscribe = this.serverManager.onStatusChange(this.workspacePath, (status) => {
      this.notifyStatusChange(status);
    });

    this.logger.info("Provider reconnected", {
      workspacePath: this.workspacePath,
      port: this.port,
    });
  }

  /**
   * Subscribe to status changes.
   * Returns an unsubscribe function.
   */
  onStatusChange(callback: (status: AgentStatus) => void): () => void {
    this.statusCallbacks.add(callback);
    return () => this.statusCallbacks.delete(callback);
  }

  /**
   * Get session info for this workspace.
   * Returns port and sessionId (from ServerManager).
   */
  getSession(): AgentSessionInfo | null {
    if (this.port === null) {
      return null;
    }

    const sessionId = this.serverManager.getSessionId(this.workspacePath);
    if (!sessionId) {
      // Session not started yet
      return null;
    }

    return {
      port: this.port,
      sessionId,
    };
  }

  /**
   * Get environment variables needed for terminal integration.
   * These are set by the sidekick extension for all new terminals.
   */
  getEnvironmentVariables(): Record<string, string> {
    if (this.port === null) {
      return {};
    }

    const mcpConfig = this.serverManager.getMcpConfig();
    const hooksConfigPath = this.serverManager.getHooksConfigPath(this.workspacePath);
    const mcpConfigPath = this.serverManager.getMcpConfigPath(this.workspacePath);

    return {
      CODEHYDRA_CLAUDE_SETTINGS: hooksConfigPath.toNative(),
      CODEHYDRA_CLAUDE_MCP_CONFIG: mcpConfigPath.toNative(),
      CODEHYDRA_BRIDGE_PORT: String(this.port),
      CODEHYDRA_MCP_PORT: mcpConfig ? String(mcpConfig.port) : "",
      CODEHYDRA_WORKSPACE_PATH: this.workspacePath,
    };
  }

  /**
   * Mark agent as active.
   * For Claude Code, this is called when the first MCP request is received.
   */
  markActive(): void {
    if (!this.active) {
      this.active = true;
      this.logger.debug("Agent marked active", {
        workspacePath: this.workspacePath,
      });
    }
  }

  /**
   * Dispose the provider completely.
   * Clears all state.
   */
  dispose(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }

    this.port = null;
    this.active = false;
    this.statusCallbacks.clear();

    this.logger.info("Provider disposed", {
      workspacePath: this.workspacePath,
    });
  }

  /**
   * Notify all status change callbacks.
   */
  private notifyStatusChange(status: AgentStatus): void {
    for (const callback of this.statusCallbacks) {
      callback(status);
    }
  }
}
