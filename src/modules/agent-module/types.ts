/**
 * Shared types and interfaces for the Agent Abstraction Layer.
 * These interfaces enable pluggable agent implementations (OpenCode, Claude, etc.)
 */

import type { PromptModel } from "../../shared/api/types";

/**
 * Resolved per-workspace agent launch config handed to a provider once the
 * backend is known. Mirrors the typed AgentSpec arms minus the `type`
 * discriminant; every field is optional (prompt-less opens are valid).
 */
export interface AgentPromptConfig {
  readonly prompt?: string;
  readonly model?: PromptModel;
  /** Claude permission mode (e.g. "plan"). Claude-only. */
  readonly permissionMode?: string;
  /** Named agent/persona (Claude --agent, or OpenCode's agent). */
  readonly agentName?: string;
}

/**
 * MCP server configuration shared by both agent server managers.
 */
export interface McpConfig {
  /** MCP server port */
  readonly port: number;
}

// Re-export AggregatedAgentStatus from shared/ipc (single source of truth)
export type { AggregatedAgentStatus, InternalAgentCounts } from "../../shared/ipc";

/** Agent types supported by CodeHydra */
export type AgentType = "opencode" | "claude";

/** Agent status for a single workspace */
export type AgentStatus = "none" | "idle" | "busy";

import type { SupportedPlatform, SupportedArch } from "../../boundaries/platform/platform-info";
// Re-export platform types from canonical location
export type { SupportedPlatform, SupportedArch };

/**
 * Result of stopping an agent server.
 */
export interface StopServerResult {
  readonly success: boolean;
  readonly error?: string;
}

/**
 * Result of restarting an agent server.
 */
export type RestartServerResult =
  | { readonly success: true; readonly port: number }
  | { readonly success: false; readonly error: string };

/**
 * Server lifecycle manager for an agent (one server per workspace).
 *
 * Note: Uses string paths for API compatibility with existing code.
 * Implementations should use Path internally and convert at boundaries.
 */
export interface AgentServerManager {
  /** Start server for a workspace, returns allocated port */
  startServer(workspacePath: string): Promise<number>;

  /** Stop server for a workspace */
  stopServer(workspacePath: string): Promise<StopServerResult>;

  /** Restart server for a workspace, preserving the same port */
  restartServer(workspacePath: string): Promise<RestartServerResult>;

  /** Callback when server starts successfully */
  onServerStarted(
    callback: (workspacePath: string, port: number, ...args: unknown[]) => void
  ): () => void;

  /** Callback when server stops */
  onServerStopped(callback: (workspacePath: string, ...args: unknown[]) => void): () => void;

  /** Set handler called when workspace becomes active (WrapperStart / first idle) */
  setMarkActiveHandler(handler: (workspacePath: string) => void): void;

  /**
   * Set the initial prompt for a workspace.
   * Optional - only Claude Code implements this method.
   * Should be called after startServer() but before the workspace view is created.
   *
   * @param workspacePath - Absolute path to the workspace
   * @param config - Resolved agent launch configuration
   */
  setInitialPrompt?(workspacePath: string, config: AgentPromptConfig): Promise<void>;

  /**
   * Create a no-session marker for a new workspace.
   * Optional - only Claude Code implements this method.
   * The marker signals the wrapper to skip --continue on first launch.
   *
   * @param workspacePath - Absolute path to the workspace
   */
  setNoSessionMarker?(workspacePath: string): Promise<void>;

  /** Configure MCP server connection for agent integration */
  setMcpConfig(config: McpConfig): void;

  /** Dispose the manager, stopping all servers */
  dispose(): Promise<void>;
}

/**
 * Session info returned by getSession().
 */
export interface AgentSessionInfo {
  readonly port: number;
  readonly sessionId: string;
}

/**
 * Per-workspace agent connection and status tracking.
 *
 * Each workspace has one provider instance that manages the connection
 * to the agent server and tracks status.
 */
export interface AgentProvider {
  /** Connect to agent server at given port */
  connect(port: number): Promise<void>;

  /** Disconnect from agent server (for restart, preserves session info) */
  disconnect(): void;

  /** Reconnect to agent server after restart */
  reconnect(): Promise<void>;

  /** Subscribe to status changes - callback receives computed status */
  onStatusChange(callback: (status: AgentStatus) => void): () => void;

  /** Get session info for TUI attachment */
  getSession(): AgentSessionInfo | null;

  /** Get environment variables needed for terminal integration */
  getEnvironmentVariables(): Record<string, string>;

  /** Mark agent as active (first MCP request received) */
  markActive(): void;

  /**
   * Detach the TUI without stopping the server (agent terminal closed).
   * Optional — only providers with a TUI-attached status gate implement it
   * (e.g. OpenCode). Claude drives terminal-close via its server-manager hook.
   */
  detachTui?(): void;

  /** Dispose the provider completely */
  dispose(): void;
}
