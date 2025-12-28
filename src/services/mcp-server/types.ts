/**
 * Type definitions for the MCP Server.
 */

import type { ProjectId, WorkspaceName } from "../../shared/api/types";
import type { IDisposable } from "../../shared/types";

// =============================================================================
// Resolved Workspace
// =============================================================================

/**
 * A workspace resolved from an MCP workspace path.
 * Contains all identifiers needed to call ICoreApi methods.
 */
export interface McpResolvedWorkspace {
  readonly projectId: ProjectId;
  readonly workspaceName: WorkspaceName;
  readonly workspacePath: string;
}

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
