/**
 * Unified agent provider interface for the generic module factory.
 *
 * Each agent implementation (Claude, OpenCode) provides one of these.
 * The generic module factory delegates all agent-specific behavior to this interface,
 * keeping the module itself a thin adapter between the intent system and the provider.
 */

import type { AgentType, AgentLifecycleEvent } from "../../shared/plugin-protocol";
import type { AggregatedAgentStatus, WorkspacePath } from "../../shared/ipc";
import type { AgentSessionInfo, McpConfig, StopServerResult, RestartServerResult } from "./types";
import type { BinaryType } from "../../utils/binary-resolution/types";
import type { NormalizedInitialPrompt } from "../../shared/api/types";
import type { DownloadProgressCallback } from "../../utils/binary-download";

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
 * Launch options the agent contributes to the creation form (e.g. Claude
 * permission modes). Empty arrays mean "nothing to offer beyond the default".
 */
export interface AgentLaunchOptions {
  readonly permissionModes: readonly string[];
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

  /**
   * Apply an agent terminal lifecycle transition (reported by the sidekick).
   * - "open": agent terminal created → WrapperStart (Claude) / markActive (OpenCode).
   * - "close": agent terminal closed → WrapperEnd (Claude) / TUI detach (OpenCode).
   *
   * Replaces the wrapper-synthesized WrapperStart/WrapperEnd POSTs. Idempotent and
   * a no-op for unknown/untracked workspaces.
   */
  applyTerminalLifecycle(workspacePath: string, event: AgentLifecycleEvent): void;

  // --- Query ---

  /**
   * Launch options this agent offers the creation form (e.g. Claude permission
   * modes). Optional — agents without dynamic options omit it.
   */
  getLaunchOptions?(): Promise<AgentLaunchOptions>;

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
