/**
 * CodeHydra Extension API Type Declarations
 *
 * This file provides TypeScript type definitions for third-party extensions
 * that want to interact with the CodeHydra extension.
 *
 * Usage:
 * 1. Copy this file into your extension's source directory
 * 2. Import the types in your extension code:
 *
 * @example
 * ```typescript
 * import type { CodehydraApi, WorkspaceStatus, AgentStatus, LogApi } from './api';
 *
 * async function useCodehydraApi() {
 *   const ext = vscode.extensions.getExtension('codehydra.sidekick');
 *   const api: CodehydraApi | undefined = ext?.exports?.codehydra;
 *
 *   if (!api) {
 *     throw new Error('CodeHydra extension not available');
 *   }
 *
 *   await api.whenReady();
 *   const status = await api.workspace.getStatus();
 *   console.log('Workspace dirty:', status.isDirty);
 *   console.log('Agent status:', status.agent.type);
 *
 *   // Log to CodeHydra's centralized logging
 *   api.log.info('My extension started', { version: '1.0.0' });
 * }
 * ```
 */

/**
 * Context data for log entries.
 * Constrained to primitive types for serialization safety.
 * Note: This type is duplicated from src/services/logging/types.ts for extension compatibility.
 */
export type LogContext = Record<string, string | number | boolean | null>;

/**
 * Log API namespace.
 * Provides structured logging to CodeHydra's logging system.
 * All methods are fire-and-forget and gracefully handle disconnected state.
 *
 * Logs appear in CodeHydra's log files with the [extension] scope.
 * The workspace path is automatically appended to the context.
 *
 * @example
 * ```typescript
 * // Simple log
 * api.log.info('Processing started');
 *
 * // Log with context
 * api.log.debug('File saved', { filename: 'test.ts', size: 1024 });
 *
 * // Log warning
 * api.log.warn('Deprecated feature used', { feature: 'oldMethod' });
 * ```
 */
export interface LogApi {
  /**
   * Log a silly message (most verbose).
   * Use for per-iteration details that would overwhelm normal debug output.
   *
   * @param message - Log message
   * @param context - Optional context data (primitives only)
   */
  silly(message: string, context?: LogContext): void;

  /**
   * Log a debug message.
   * Use for detailed tracing information useful during development.
   *
   * @param message - Log message
   * @param context - Optional context data (primitives only)
   */
  debug(message: string, context?: LogContext): void;

  /**
   * Log an info message.
   * Use for significant operations (start/stop, connections, completions).
   *
   * @param message - Log message
   * @param context - Optional context data (primitives only)
   */
  info(message: string, context?: LogContext): void;

  /**
   * Log a warning message.
   * Use for recoverable issues or deprecated behavior.
   *
   * @param message - Log message
   * @param context - Optional context data (primitives only)
   */
  warn(message: string, context?: LogContext): void;

  /**
   * Log an error message.
   * Use for failures that require attention.
   *
   * @param message - Log message
   * @param context - Optional context data (primitives only)
   */
  error(message: string, context?: LogContext): void;
}

/**
 * Initial prompt for workspace creation.
 * Can be a simple string (uses default agent) or an object with agent selection.
 */
export type InitialPrompt = string | { readonly prompt: string; readonly agent?: string };

/**
 * Options for workspace creation.
 */
export interface WorkspaceCreateOptions {
  /** Optional initial prompt to send after workspace is created */
  readonly initialPrompt?: InitialPrompt;
  /** If true, don't switch to the new workspace (default: false = switch to it) */
  readonly keepInBackground?: boolean;
}

/**
 * Workspace information returned from creation.
 */
export interface Workspace {
  /** Workspace name (also the branch name) */
  readonly name: string;
  /** Absolute path to the workspace directory */
  readonly path: string;
  /** Base branch this workspace was created from */
  readonly base: string;
}

/**
 * OpenCode session information.
 */
export interface OpenCodeSession {
  /** Port number the OpenCode server is running on */
  readonly port: number;
  /** Session ID for the primary session */
  readonly sessionId: string;
}

/**
 * Agent status counts for workspaces with active AI agents.
 */
export interface AgentStatusCounts {
  readonly idle: number;
  readonly busy: number;
  readonly total: number;
}

/**
 * Agent status - none if no agents, or aggregated status with counts.
 */
export type AgentStatus =
  | { readonly type: "none" }
  | { readonly type: "idle"; readonly counts: AgentStatusCounts }
  | { readonly type: "busy"; readonly counts: AgentStatusCounts }
  | { readonly type: "mixed"; readonly counts: AgentStatusCounts };

/**
 * Combined status of a workspace.
 */
export interface WorkspaceStatus {
  /** True if the workspace has uncommitted changes */
  readonly isDirty: boolean;
  /** Status of AI agents in this workspace */
  readonly agent: AgentStatus;
}

/**
 * Workspace API namespace.
 */
export interface WorkspaceApi {
  /**
   * Get the current status of this workspace.
   *
   * @returns Workspace status including dirty flag and agent status
   * @throws Error if not connected or request fails
   *
   * @example
   * ```typescript
   * const status = await api.workspace.getStatus();
   * if (status.isDirty) {
   *   console.log('Workspace has uncommitted changes');
   * }
   * if (status.agent.type !== 'none') {
   *   console.log(`${status.agent.counts.total} agent(s) active`);
   * }
   * ```
   */
  getStatus(): Promise<WorkspaceStatus>;

  /**
   * Get the OpenCode session info for this workspace.
   * Returns the session info if the OpenCode server is running, or null if not running.
   *
   * @returns Session info (port and sessionId) or null if server not running
   * @throws Error if not connected or request fails
   *
   * @example
   * ```typescript
   * const session = await api.workspace.getOpenCodeSession();
   * if (session !== null) {
   *   console.log(`OpenCode server running on port ${session.port}`);
   *   console.log(`Primary session: ${session.sessionId}`);
   * }
   * ```
   */
  getOpenCodeSession(): Promise<OpenCodeSession | null>;

  /**
   * Restart the OpenCode server for this workspace, preserving the same port.
   * Useful for reloading configuration changes without affecting other workspaces.
   *
   * @returns Port number of the restarted server
   * @throws Error if not connected, server not running, or restart fails
   *
   * @example
   * ```typescript
   * try {
   *   const port = await api.workspace.restartOpencodeServer();
   *   console.log(`OpenCode server restarted on port ${port}`);
   * } catch (error) {
   *   console.error('Failed to restart server:', error);
   * }
   * ```
   */
  restartOpencodeServer(): Promise<number>;

  /**
   * Get all metadata for this workspace.
   * Metadata is stored in git config and persists across sessions.
   *
   * @returns Metadata record (always includes 'base' key with the base branch)
   * @throws Error if not connected or request fails
   *
   * @example
   * ```typescript
   * const metadata = await api.workspace.getMetadata();
   * console.log('Base branch:', metadata.base);
   * if (metadata.note) {
   *   console.log('Note:', metadata.note);
   * }
   * ```
   */
  getMetadata(): Promise<Readonly<Record<string, string>>>;

  /**
   * Set or delete a metadata value for this workspace.
   * Metadata is stored in git config and persists across sessions.
   *
   * @param key - Metadata key (must match /^[A-Za-z][A-Za-z0-9-]*$/)
   * @param value - Value to set, or null to delete the key
   * @throws Error if not connected, key format invalid, or request fails
   *
   * @example
   * ```typescript
   * // Set a value
   * await api.workspace.setMetadata('note', 'Working on feature X');
   *
   * // Delete a value
   * await api.workspace.setMetadata('note', null);
   * ```
   */
  setMetadata(key: string, value: string | null): Promise<void>;

  /**
   * Execute a VS Code command in this workspace.
   *
   * Note: Most VS Code commands return `undefined`. The return type is `unknown`
   * because command return types are not statically typed.
   *
   * @param command - VS Code command identifier (e.g., "workbench.action.files.save")
   * @param args - Optional arguments to pass to the command
   * @returns The command's return value, or undefined if command returns nothing
   * @throws Error if workspace disconnected, command not found, or execution fails
   * @throws Error if command times out (10-second limit)
   *
   * @example
   * ```typescript
   * // Save all files (returns undefined)
   * await api.workspace.executeCommand('workbench.action.files.saveAll');
   *
   * // Get selected text (returns string | undefined)
   * const text = await api.workspace.executeCommand('editor.action.getSelectedText');
   * ```
   */
  executeCommand(command: string, args?: readonly unknown[]): Promise<unknown>;

  /**
   * Create a new workspace in the same project as the current workspace.
   *
   * The new workspace is created from the specified base branch. If an initial
   * prompt is provided, it will be sent to the OpenCode agent after the workspace
   * is ready (fire-and-forget).
   *
   * @param name - Name for the new workspace (becomes the branch name)
   * @param base - Base branch to create the workspace from
   * @param options - Optional creation options
   * @returns The created workspace information
   * @throws Error if not connected, name/base invalid, or creation fails
   *
   * @example
   * ```typescript
   * // Create workspace with no initial prompt
   * const ws = await api.workspace.create('feature-login', 'main');
   *
   * // Create workspace with initial prompt (string)
   * const ws = await api.workspace.create('feature-auth', 'main', {
   *   initialPrompt: 'Implement OAuth2 authentication'
   * });
   *
   * // Create workspace with initial prompt and specific agent
   * const ws = await api.workspace.create('fix-bug-123', 'main', {
   *   initialPrompt: { prompt: 'Fix the login bug', agent: 'coder' },
   *   keepInBackground: true  // Don't switch to the new workspace
   * });
   * ```
   */
  create(name: string, base: string, options?: WorkspaceCreateOptions): Promise<Workspace>;
}

/**
 * CodeHydra API for VS Code extensions.
 *
 * Access via the codehydra extension's exports:
 * ```typescript
 * const ext = vscode.extensions.getExtension('codehydra.sidekick');
 * const api: CodehydraApi | undefined = ext?.exports?.codehydra;
 * ```
 */
export interface CodehydraApi {
  /**
   * Wait for the extension to be connected to CodeHydra.
   * Resolves immediately if already connected.
   * Rejects if the extension is deactivated before connecting.
   *
   * Call this before using workspace API methods to ensure connection.
   *
   * @example
   * ```typescript
   * await api.whenReady();
   * // Safe to use workspace API now
   * const status = await api.workspace.getStatus();
   * ```
   */
  whenReady(): Promise<void>;

  /**
   * Log API namespace.
   * Provides structured logging to CodeHydra's centralized logging system.
   * Methods are fire-and-forget and work even before whenReady() resolves.
   */
  readonly log: LogApi;

  /**
   * Workspace API namespace.
   * Contains methods for querying and modifying workspace state.
   */
  readonly workspace: WorkspaceApi;
}
