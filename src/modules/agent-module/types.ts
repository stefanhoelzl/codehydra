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
/**
 * How an agent launches CodeHydra's MCP server.
 *
 * The server is `ch mcp`, a stdio mode of the CLI, rather than an HTTP endpoint
 * inside the app. Everything it needs is passed explicitly at launch, so the
 * shim reads no state file and needs nothing on PATH — which is what makes it
 * work for OpenCode, whose server is spawned without CodeHydra's bin directory.
 */
export interface McpConfig {
  /** Absolute path to the node interpreter that runs the CLI. */
  readonly nodePath: string;
  /** Absolute path to the CLI bundle (`ch.cjs`). */
  readonly cliPath: string;
  /** Plugin server port the shim connects back on. */
  readonly port: number;
  /** Token the shim presents when connecting. */
  readonly token: string;
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
 * A message for a running agent, delivered into its conversation mid-session.
 *
 * Unlike an initial prompt (read once, at launch), a message reaches an agent
 * that is already running. It is addressed to the agent, never to the user —
 * notifications and the status bar are the user's channels.
 */
export interface AgentMessage {
  /** The message text. */
  readonly text: string;
  /**
   * Who sent it, as the agent should see it (e.g. "CodeHydra · workspace foo").
   * Set by CodeHydra from where the call came from, never by the caller.
   */
  readonly from: string;
}

/**
 * The workspace has no agent that can take a message: none running, its
 * terminal closed, or it did not come up in time. A condition of the target,
 * not a fault — the send-message operation reports it as "not sent" instead of
 * failing, so it never reaches the log as an error.
 */
export class AgentUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentUnreachableError";
  }
}

/**
 * How long {@link AgentProvider.sendMessage} may wait for the agent to become
 * reachable before giving up.
 */
export interface AgentMessageOptions {
  /**
   * 0 = the agent must be reachable now, or the send fails. Anything larger
   * waits up to that many ms for it (used right after waking the workspace or
   * reopening its agent terminal).
   */
  readonly waitMs: number;
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
   * Deliver a message into the running agent's conversation.
   *
   * Resolves once the agent has accepted it for delivery — "sent", not "read":
   * a busy agent reads it at its next opportunity. Rejects with
   * {@link AgentUnreachableError} when no agent is reachable within
   * `options.waitMs` (none running, or its terminal closed), and with any other
   * error when the hand-over itself fails.
   */
  sendMessage(message: AgentMessage, options: AgentMessageOptions): Promise<void>;

  /**
   * Detach the TUI without stopping the server (agent terminal closed).
   * Optional — only providers with a TUI-attached status gate implement it
   * (e.g. OpenCode). Claude drives terminal-close via its server-manager hook.
   */
  detachTui?(): void;

  /** Dispose the provider completely */
  dispose(): void;
}
