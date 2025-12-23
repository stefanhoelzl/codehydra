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
 * import type { CodehydraApi, WorkspaceStatus, AgentStatus } from './api';
 *
 * async function useCodehydraApi() {
 *   const ext = vscode.extensions.getExtension('codehydra.codehydra');
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
 * }
 * ```
 */

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
   * Get the OpenCode server port for this workspace.
   * Returns the port number if the OpenCode server is running, or null if not running.
   *
   * @returns Port number or null if server not running
   * @throws Error if not connected or request fails
   *
   * @example
   * ```typescript
   * const port = await api.workspace.getOpencodePort();
   * if (port !== null) {
   *   console.log(`OpenCode server running on port ${port}`);
   *   // Connect to OpenCode server at http://localhost:${port}
   * }
   * ```
   */
  getOpencodePort(): Promise<number | null>;

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
}

/**
 * CodeHydra API for VS Code extensions.
 *
 * Access via the codehydra extension's exports:
 * ```typescript
 * const ext = vscode.extensions.getExtension('codehydra.codehydra');
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
   * Workspace API namespace.
   * Contains methods for querying and modifying workspace state.
   */
  readonly workspace: WorkspaceApi;
}
