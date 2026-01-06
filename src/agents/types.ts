/**
 * Shared types and interfaces for the Agent Abstraction Layer.
 * These interfaces enable pluggable agent implementations (OpenCode, Claude, etc.)
 *
 * Design principles:
 * - Use Path class for path parameters (not strings)
 * - AgentError provides typed error codes for consistent handling
 * - Factory functions enable dependency injection for testability
 */

import type { Path } from "../services/platform/path";
import type { FileSystemLayer } from "../services/platform/filesystem";
import type { ProcessRunner } from "../services/platform/process";
import type { PortManager, HttpClient } from "../services/platform/network";
import type { PathProvider } from "../services/platform/path-provider";
import type { Logger } from "../services/logging";

// Re-export AggregatedAgentStatus from shared/ipc (single source of truth)
export type { AggregatedAgentStatus, InternalAgentCounts } from "../shared/ipc";

/** Agent types supported by CodeHydra */
export type AgentType = "opencode"; // | "claude" in future

/** Agent status for a single workspace */
export type AgentStatus = "none" | "idle" | "busy";

/** Error types that can occur during agent operations */
export interface AgentError {
  readonly code: "CONNECTION_FAILED" | "SERVER_START_FAILED" | "CONFIG_ERROR" | "TIMEOUT";
  readonly message: string;
  readonly cause?: Error;
}

/** Static setup information for an agent type (singleton per agent type) */
export interface AgentSetupInfo {
  /** Version string (e.g., "0.1.0-beta.43") */
  readonly version: string;

  /** Binary filename relative to bin directory (e.g., "opencode" or "opencode.exe") */
  readonly binaryPath: string;

  /** Entry point for wrapper script (e.g., "agents/opencode-wrapper.cjs") */
  readonly wrapperEntryPoint: string;

  /** Get download URL for the binary for current platform */
  getBinaryUrl(): string;

  /**
   * Generate config file with environment variable substitution
   * @param targetPath - Path where config file should be written
   * @param variables - Variables to substitute (e.g., { MCP_PORT: "3000" })
   */
  generateConfigFile(targetPath: Path, variables: Record<string, string>): Promise<void>;
}

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
  | { readonly success: false; readonly error: string; readonly serverStopped: boolean };

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

  /** Check if server is running for workspace */
  isRunning(workspacePath: string): boolean;

  /** Get the port for a running workspace server */
  getPort(workspacePath: string): number | undefined;

  /** Stop all servers for a project */
  stopAllForProject(projectPath: string): Promise<void>;

  /** Callback when server starts successfully */
  onServerStarted(
    callback: (workspacePath: string, port: number, ...args: unknown[]) => void
  ): () => void;

  /** Callback when server stops */
  onServerStopped(callback: (workspacePath: string, ...args: unknown[]) => void): () => void;

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
  /** VS Code commands to execute on workspace activation */
  readonly startupCommands: readonly string[];

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

  /** Dispose the provider completely */
  dispose(): void;
}

/** Dependencies for creating AgentServerManager instances */
export interface ServerManagerDeps {
  readonly processRunner: ProcessRunner;
  readonly portManager: PortManager;
  readonly httpClient: HttpClient;
  readonly pathProvider: PathProvider;
  readonly logger: Logger;
}

/** Dependencies for creating AgentProvider instances */
export interface ProviderDeps {
  readonly httpClient: HttpClient;
  readonly logger: Logger;
}

/** Dependencies for AgentSetupInfo implementations */
export interface SetupInfoDeps {
  readonly fileSystem: FileSystemLayer;
  readonly pathProvider: PathProvider;
}
