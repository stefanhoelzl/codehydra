/**
 * Type definitions for the MCP Server.
 */

import type { IDisposable } from "../../shared/types";
import type {
  WorkspaceStatus,
  AgentSession,
  Workspace,
  Project,
  InitialPrompt,
} from "../../shared/api/types";

// =============================================================================
// MCP Error Types
// =============================================================================

/**
 * MCP error codes.
 */
export type McpErrorCode =
  | "workspace-not-found"
  | "project-not-found"
  | "invalid-input"
  | "internal-error";

/**
 * MCP error structure.
 */
export interface McpError {
  readonly code: McpErrorCode;
  readonly message: string;
}

// =============================================================================
// MCP API Handlers
// =============================================================================

/**
 * Unified show-message request covering all VS Code UI interactions.
 */
export type ShowMessageType = "info" | "warning" | "error" | "status" | "select";

export interface ShowMessageRequest {
  readonly type: ShowMessageType;
  /** Display text. null = dismiss (only valid for status). */
  readonly message: string | null;
  /** Secondary text: tooltip for status, placeholder for select. */
  readonly hint?: string;
  /** Action buttons (notification) or selection items (select). Omit for free text input. */
  readonly options?: readonly string[];
  /** Timeout in milliseconds for interactive operations. */
  readonly timeoutMs?: number;
}

/**
 * Flat handler interface for MCP server operations.
 * Each method maps to an MCP tool. The MCP server calls these handlers
 * instead of going through the centralized API facade.
 */
export interface McpApiHandlers {
  getStatus(workspacePath: string): Promise<WorkspaceStatus>;
  getMetadata(workspacePath: string): Promise<Readonly<Record<string, string>>>;
  setMetadata(workspacePath: string, key: string, value: string | null): Promise<void>;
  getAgentSession(workspacePath: string): Promise<AgentSession | null>;
  restartAgentServer(workspacePath: string): Promise<number>;
  listProjects(): Promise<readonly Project[]>;
  createWorkspace(options: {
    projectPath: string;
    name: string;
    base: string;
    initialPrompt?: InitialPrompt;
    stealFocus?: boolean;
  }): Promise<Workspace>;
  deleteWorkspace(
    workspacePath: string,
    options: { keepBranch: boolean; ignoreWarnings?: boolean }
  ): Promise<{ started: boolean }>;
  executeCommand(
    workspacePath: string,
    command: string,
    args?: readonly unknown[]
  ): Promise<unknown>;
  showMessage(workspacePath: string, request: ShowMessageRequest): Promise<string | null>;
}

// =============================================================================
// MCP Server Types
// =============================================================================

/**
 * MCP Server interface.
 */
export interface IMcpServer extends IDisposable {
  /**
   * Start the server on a specific port.
   * @param port - Port to listen on
   */
  start(port: number): Promise<void>;

  /**
   * Stop the server.
   */
  stop(): Promise<void>;

  /**
   * Check if the server is running.
   */
  isRunning(): boolean;
}
