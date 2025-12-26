/**
 * Type definitions for the MCP Server.
 */

import type { ProjectId, WorkspaceName } from "../../shared/api/types";

// =============================================================================
// Branded Types
// =============================================================================

/**
 * Brand symbol for validated workspace paths.
 */
declare const McpWorkspacePathBrand: unique symbol;

/**
 * Validated workspace path from MCP header.
 * Must be an absolute path that corresponds to a registered workspace.
 */
export type McpWorkspacePath = string & { readonly [McpWorkspacePathBrand]: true };

// =============================================================================
// Resolved Workspace
// =============================================================================

/**
 * A workspace resolved from an MCP workspace path.
 * Contains all identifiers needed to call ICoreApi methods.
 */
export interface ResolvedWorkspace {
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
 */
export type McpToolResult<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly error: McpError };

// =============================================================================
// MCP Server Types
// =============================================================================

/**
 * Disposable interface for cleanup.
 */
export interface IDisposable {
  dispose(): void | Promise<void>;
}

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
 */
export interface McpContext {
  readonly workspacePath: string;
  readonly resolved: ResolvedWorkspace | null;
}

// =============================================================================
// OpenCode Spawn Environment
// =============================================================================

/**
 * Environment variables passed to OpenCode when spawning.
 */
export interface OpenCodeSpawnEnv {
  /** File path to codehydra-mcp.json config file */
  readonly OPENCODE_CONFIG: string;
  /** Absolute workspace path */
  readonly CODEHYDRA_WORKSPACE_PATH: string;
  /** MCP server port as string */
  readonly CODEHYDRA_MCP_PORT: string;
}
