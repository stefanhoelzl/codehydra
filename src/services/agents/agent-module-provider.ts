/**
 * Unified agent provider interface for the generic module factory.
 *
 * Each agent implementation (Claude, OpenCode) provides one of these.
 * The generic module factory delegates all agent-specific behavior to this interface,
 * keeping the module itself a thin adapter between the intent system and the provider.
 */

import type { AgentType } from "../../shared/plugin-protocol";
import type { AggregatedAgentStatus, WorkspacePath } from "../../shared/ipc";
import type { AgentSessionInfo, McpConfig, StopServerResult, RestartServerResult } from "./types";
import type { BinaryType } from "../vscode-setup/types";
import type { ConfigKeyDefinition } from "../config/config-definition";
import type { NormalizedInitialPrompt } from "../../shared/api/types";
import type { DownloadProgressCallback } from "../binary-download";

/**
 * Options for starting a workspace.
 */
export interface WorkspaceStartOptions {
  readonly initialPrompt?: NormalizedInitialPrompt;
  readonly isNewWorkspace?: boolean;
}

/**
 * Result of starting a workspace.
 */
export interface WorkspaceStartResult {
  readonly envVars: Record<string, string>;
}

/**
 * Unified agent provider interface for the generic module factory.
 *
 * Each agent implementation (Claude, OpenCode) provides one of these.
 * The generic module factory delegates all agent-specific behavior to this interface,
 * keeping the module itself a thin adapter between the intent system and the provider.
 */
export interface AgentModuleProvider {
  // --- Identity ---

  /** Agent type identifier (e.g., "claude", "opencode") */
  readonly type: AgentType;

  /** Config key used for version overrides (e.g., "version.claude") */
  readonly configKey: string;

  /** Human-readable display name (e.g., "Claude Code") */
  readonly displayName: string;

  /** Icon name for UI display */
  readonly icon: string;

  /** MCP server name registered by this agent */
  readonly serverName: string;

  /** Script filenames to copy into workspaces */
  readonly scripts: readonly string[];

  // --- Binary ---

  /** Binary type for download management */
  readonly binaryType: BinaryType;

  /** Check if binary is available, returns whether download is needed */
  preflight(): Promise<{ success: boolean; needsDownload: boolean }>;

  /** Download the agent binary */
  downloadBinary(onProgress?: DownloadProgressCallback): Promise<void>;

  // --- Config ---

  /** Get the config key definition for version override */
  getConfigDefinition(): ConfigKeyDefinition<string | null>;

  // --- Lifecycle ---

  /** Initialize the agent with optional MCP configuration */
  initialize(mcpConfig: McpConfig | null): void;

  /** Dispose the agent, releasing all resources */
  dispose(): Promise<void>;

  // --- Per-workspace ---

  /** Start agent for a workspace, returns environment variables for the view */
  startWorkspace(
    workspacePath: string,
    options?: WorkspaceStartOptions
  ): Promise<WorkspaceStartResult>;

  /** Stop agent for a workspace */
  stopWorkspace(workspacePath: string): Promise<StopServerResult>;

  /** Restart agent for a workspace */
  restartWorkspace(workspacePath: string): Promise<RestartServerResult>;

  // --- Query ---

  /** Get aggregated status for a workspace */
  getStatus(workspacePath: WorkspacePath): AggregatedAgentStatus;

  /** Get session info for TUI attachment */
  getSession(workspacePath: WorkspacePath): AgentSessionInfo | null;

  // --- Events ---

  /** Subscribe to status changes across all workspaces */
  onStatusChange(
    callback: (workspacePath: WorkspacePath, status: AggregatedAgentStatus) => void
  ): () => void;

  // --- Cleanup ---

  /** Remove all tracking state for a workspace */
  clearWorkspaceTracking(workspacePath: WorkspacePath): void;
}
