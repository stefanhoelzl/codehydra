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
 * Options for workspace creation: what `ch ws create` takes besides the name.
 *
 * Which further options a project takes depends on its type, and they go here
 * by name too — a git project's `base` (the branch to start from; omitted: the
 * project's default branch) and `tracking` (a remote branch to check out). An
 * option the project's type does not declare fails the call.
 */
export interface WorkspaceCreateOptions {
  /** Project to create it in: a name, ref, path or git URL. Omitted: the caller's own. */
  readonly project?: string | undefined;
  /** Initial prompt, sent once the workspace is ready. */
  readonly prompt?: string | undefined;
  /** Agent backend to launch: "claude" or "opencode". */
  readonly agent?: string | undefined;
  /** Model for the initial prompt: "provider/model" (claude also takes a bare id). */
  readonly model?: string | undefined;
  /** Claude permission mode to start in, e.g. "plan". Needs agent "claude". */
  readonly permissionMode?: string | undefined;
  /** Named agent (persona) to launch. Needs an agent backend. */
  readonly agentName?: string | undefined;
  /** Switch to the new workspace. Default: false */
  readonly stealFocus?: boolean | undefined;
  /** The project type's create options, by name (git: `base`, `tracking`). */
  readonly [option: string]: string | boolean | undefined;
}

/**
 * Workspace information returned from creation.
 */
export interface Workspace {
  /** The workspace's identity (`ch::<machine>::<project>::<name>`), as `ch --workspace` takes it */
  readonly ref: string;
  /** Identifier of the project this workspace belongs to */
  readonly projectId: string;
  /** Workspace name: its branch when it was created, kept when the branch changes */
  readonly name: string;
  /** Display text from the project's type (git: the checked-out branch); absent when none, e.g. a detached HEAD */
  readonly subtitle?: string;
  /** Icon before the subtitle (git: "branch") */
  readonly subtitleIcon?: "branch" | "cloud" | "info";
  /** The project type's own data about the workspace, passed as-is (git: `{ branch?, base? }`) */
  readonly details?: Readonly<Record<string, unknown>>;
  /**
   * Workspace metadata, stored in the worktree's git directory.
   * For a git workspace, a `base` key holds the base branch it was created from, when recorded.
   */
  readonly metadata: Readonly<Record<string, string>>;
  /** Absolute path to the workspace directory */
  readonly path: string;
  /** code-server URL for embedding this workspace; absent while the workspace is hibernated */
  readonly url?: string;
}

/**
 * Agent session information.
 */
export interface AgentSession {
  /** Port number the agent server is running on */
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
  /** Number of commits on this workspace's branch not merged into its base branch */
  readonly unmergedCommits: number;
  /** Status of AI agents in this workspace */
  readonly agent: AgentStatus;
}

/**
 * A tag attached to a workspace.
 *
 * `name` is the identity. The rest is presentation: `label` is displayed in place
 * of the name (any UTF-8, typically an emoji), `color` turns the bare label into a
 * pill, and `description` is the sidebar hover text.
 */
export interface WorkspaceTag {
  readonly name: string;
  readonly color?: string;
  readonly label?: string;
  readonly description?: string;
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
  getStatus(options?: { refresh?: boolean }): Promise<WorkspaceStatus>;

  /**
   * Get the agent session info for this workspace.
   * Returns the session info if the agent server is running, or null if not running.
   *
   * @returns Session info (port and sessionId) or null if server not running
   * @throws Error if not connected or request fails
   *
   * @example
   * ```typescript
   * const session = await api.workspace.getAgentSession();
   * if (session !== null) {
   *   console.log(`Agent server running on port ${session.port}`);
   *   console.log(`Primary session: ${session.sessionId}`);
   * }
   * ```
   */
  getAgentSession(): Promise<AgentSession | null>;

  /**
   * Restart the agent server for this workspace, preserving the same port.
   * Useful for reloading configuration changes without affecting other workspaces.
   *
   * @returns Port number of the restarted server
   * @throws Error if not connected, server not running, or restart fails
   *
   * @example
   * ```typescript
   * try {
   *   const port = await api.workspace.restartAgentServer();
   *   console.log(`Agent server restarted on port ${port}`);
   * } catch (error) {
   *   console.error('Failed to restart server:', error);
   * }
   * ```
   */
  restartAgentServer(): Promise<number>;

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
   * Get all tags for this workspace.
   * Tags are extracted from metadata entries with the "tags." prefix.
   *
   * @returns Array of workspace tags
   * @throws Error if not connected or request fails
   *
   * @example
   * ```typescript
   * const tags = await api.workspace.getTags();
   * for (const tag of tags) {
   *   console.log(`Tag: ${tag.name}`, tag.color ?? 'no color');
   * }
   * ```
   */
  getTags(): Promise<readonly WorkspaceTag[]>;

  /**
   * Set or update a tag on this workspace.
   * Tags are stored as metadata entries with the "tags." prefix.
   *
   * Replaces the tag entirely: an option you omit is cleared, so re-pass the ones
   * you want to keep. Without a color the tag renders as bare text rather than a
   * pill; `label` is shown in place of the name, and `description` is its tooltip.
   *
   * @param name - Tag name (letters, digits, hyphens, dots)
   * @param options - Optional tag presentation (color, label, description)
   * @throws Error if not connected or request fails
   *
   * @example
   * ```typescript
   * // Tag with color
   * await api.workspace.setTag('bugfix', { color: '#ff0000' });
   *
   * // Emoji tag, explained on hover
   * await api.workspace.setTag('review', {
   *   label: '🔍',
   *   description: 'waiting on review',
   * });
   *
   * // Tag without color
   * await api.workspace.setTag('wip');
   * ```
   */
  setTag(
    name: string,
    options?: { color?: string; label?: string; description?: string }
  ): Promise<void>;

  /**
   * Delete a tag from this workspace.
   *
   * @param name - Tag name to delete
   * @throws Error if not connected or request fails
   *
   * @example
   * ```typescript
   * await api.workspace.deleteTag('wip');
   * ```
   */
  deleteTag(name: string): Promise<void>;

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
   * Create a new workspace, in the same project as the current workspace
   * unless `options.project` names another. Takes what `ch ws create` takes.
   *
   * @param name - Name for the new workspace
   * @param options - Creation options, the project type's included (git: `base`, `tracking`)
   * @returns The created workspace information
   * @throws Error if not connected, the name is invalid, an option is not the
   *   project type's, or creation fails
   *
   * @example
   * ```typescript
   * // From the project's default branch
   * const ws = await api.workspace.create('feature-login');
   *
   * // From a given base branch, with an initial prompt
   * const ws = await api.workspace.create('feature-auth', {
   *   base: 'main',
   *   prompt: 'Implement OAuth2 authentication',
   * });
   *
   * // With a specific agent, switching to it
   * const ws = await api.workspace.create('fix-bug-123', {
   *   agent: 'claude',
   *   permissionMode: 'plan',
   *   prompt: 'Fix the login bug',
   *   stealFocus: true,
   * });
   * ```
   */
  create(name: string, options?: WorkspaceCreateOptions): Promise<Workspace>;
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
