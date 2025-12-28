/**
 * Type definitions for the MCP Server.
 */

import type { ProjectId, WorkspaceName } from "../../shared/api/types";
import type { IDisposable } from "../types";

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

/**
 * Result type for MCP tool operations.
 * @internal Used by test utilities only
 */
export type McpToolResult<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly error: McpError };

// =============================================================================
// MCP Server Types
// =============================================================================

// Re-export IDisposable from shared types for backward compatibility
export type { IDisposable } from "../types";

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

/**
 * MCP context for tool handlers.
 * Contains workspace information from the X-Workspace-Path header.
 * @internal Used by test utilities only
 */
export interface McpContext {
  readonly workspacePath: string;
  readonly resolved: McpResolvedWorkspace | null;
}
