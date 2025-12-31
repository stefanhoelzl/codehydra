/**
 * API type definitions for CodeHydra.
 * Provides branded types for compile-time safety and runtime type guards for validation.
 */

import type { WorkspacePath } from "../ipc";

// =============================================================================
// Branded Type Symbols
// =============================================================================

declare const ProjectIdBrand: unique symbol;
declare const WorkspaceNameBrand: unique symbol;

// =============================================================================
// Identifier Types (Branded)
// =============================================================================

/**
 * Unique identifier for a project.
 * Format: `<name>-<8-char-hex-hash>`
 * Example: "my-app-12345678"
 */
export type ProjectId = string & { readonly [ProjectIdBrand]: true };

/**
 * Name of a workspace within a project.
 * Typically matches the git branch name.
 */
export type WorkspaceName = string & { readonly [WorkspaceNameBrand]: true };

// =============================================================================
// Type Guards
// =============================================================================

/**
 * Regex for validating ProjectId format.
 * Pattern: alphanumeric name with dashes, followed by dash and 8 hex characters.
 */
const PROJECT_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9-]*-[a-f0-9]{8}$/;

/**
 * Regex for validating WorkspaceName format.
 * Pattern: starts with alphanumeric, followed by alphanumeric, dashes, underscores, dots, or forward slashes.
 */
const WORKSPACE_NAME_REGEX = /^[a-zA-Z0-9][-_./a-zA-Z0-9]*$/;

/**
 * Maximum length for workspace names.
 */
const WORKSPACE_NAME_MAX_LENGTH = 100;

/**
 * Type guard for ProjectId validation.
 * @param value String to validate
 * @returns True if the value matches ProjectId format
 */
export function isProjectId(value: string): value is ProjectId {
  return PROJECT_ID_REGEX.test(value);
}

/**
 * Type guard for WorkspaceName validation.
 * @param value String to validate
 * @returns True if the value matches WorkspaceName format
 */
export function isWorkspaceName(value: string): value is WorkspaceName {
  return (
    value.length > 0 &&
    value.length <= WORKSPACE_NAME_MAX_LENGTH &&
    WORKSPACE_NAME_REGEX.test(value)
  );
}

// =============================================================================
// Metadata Key Validation
// =============================================================================

/**
 * Regex for validating metadata key format.
 * Pattern: starts with letter, followed by letters, digits, or hyphens.
 * No underscores (git config compatibility), no trailing hyphen.
 *
 * Valid: base, note, model-name, AI-model
 * Invalid: _private (leading underscore), my_key (underscore), 123note (leading digit), note- (trailing hyphen)
 */
export const METADATA_KEY_REGEX = /^[A-Za-z][A-Za-z0-9-]*$/;

/**
 * Maximum length for metadata keys.
 */
const METADATA_KEY_MAX_LENGTH = 64;

/**
 * Validates a metadata key for workspace config storage.
 * Keys must:
 * - Start with a letter (a-z, A-Z)
 * - Contain only letters, digits, and hyphens
 * - Not end with a hyphen
 * - Be 1-64 characters long
 *
 * @param key The key to validate
 * @returns True if the key is valid for metadata storage
 */
export function isValidMetadataKey(key: string): boolean {
  return (
    key.length > 0 &&
    key.length <= METADATA_KEY_MAX_LENGTH &&
    METADATA_KEY_REGEX.test(key) &&
    !key.endsWith("-")
  );
}

// =============================================================================
// Domain Types
// =============================================================================

/**
 * A project in CodeHydra (represents a git repository).
 */
export interface Project {
  readonly id: ProjectId;
  readonly name: string;
  readonly path: string;
  readonly workspaces: readonly Workspace[];
  readonly defaultBaseBranch?: string;
}

/**
 * A workspace within a project (represents a git worktree).
 */
export interface Workspace {
  readonly projectId: ProjectId;
  readonly name: WorkspaceName;
  /** Current branch name, or null for detached HEAD state */
  readonly branch: string | null;
  /**
   * Metadata for the workspace stored in git config.
   * Always contains `base` key (with fallback to branch ?? name if not explicitly set).
   * Additional keys can be added for custom workspace metadata.
   */
  readonly metadata: Readonly<Record<string, string>>;
  readonly path: string;
}

/**
 * Reference to a workspace (includes path for efficiency).
 * Used in events so consumers don't need to resolve IDs.
 */
export interface WorkspaceRef {
  readonly projectId: ProjectId;
  readonly workspaceName: WorkspaceName;
  readonly path: string;
}

/**
 * Combined status of a workspace.
 */
export interface WorkspaceStatus {
  readonly isDirty: boolean;
  readonly agent: AgentStatus;
}

/**
 * Agent status for a workspace.
 */
export type AgentStatus =
  | { readonly type: "none" }
  | { readonly type: "idle"; readonly counts: AgentStatusCounts }
  | { readonly type: "busy"; readonly counts: AgentStatusCounts }
  | { readonly type: "mixed"; readonly counts: AgentStatusCounts };

/**
 * Agent status counts for a workspace.
 */
export interface AgentStatusCounts {
  readonly idle: number;
  readonly busy: number;
  readonly total: number;
}

/**
 * Information about a base branch.
 */
export interface BaseInfo {
  readonly name: string;
  readonly isRemote: boolean;
}

/**
 * Steps in the VS Code setup process.
 */
export type SetupStep = "binary-download" | "extensions" | "settings";

/**
 * Progress update during setup.
 */
export interface SetupProgress {
  readonly step: SetupStep;
  readonly message: string;
}

/**
 * Result of the setup operation.
 */
export type SetupResult =
  | { readonly success: true }
  | { readonly success: false; readonly message: string; readonly code: string };

/**
 * Application state for lifecycle management.
 */
export type AppState = "setup" | "ready";

// =============================================================================
// Blocking Process Types
// =============================================================================

/**
 * Information about a process blocking workspace deletion.
 * Used on Windows to identify processes holding file handles.
 */
export interface BlockingProcess {
  /** Process ID */
  readonly pid: number;
  /** Process name (e.g., "node.exe", "Code.exe") */
  readonly name: string;
  /** Full command line that started the process */
  readonly commandLine: string;
  /** Files locked by this process, relative to workspace (max 20) */
  readonly files: readonly string[];
  /** Current working directory relative to workspace, or null if CWD is outside workspace */
  readonly cwd: string | null;
}

/**
 * Unblock options for workspace removal.
 */
export const UNBLOCK_OPTIONS = ["kill", "close", false] as const;
export type UnblockOption = (typeof UNBLOCK_OPTIONS)[number];

// =============================================================================
// Deletion Progress Types
// =============================================================================

/**
 * Identifiers for deletion operations.
 */
export type DeletionOperationId =
  | "closing-handles"
  | "killing-blockers"
  | "kill-terminals"
  | "stop-server"
  | "cleanup-vscode"
  | "cleanup-workspace";

/**
 * Status of a deletion operation.
 */
export type DeletionOperationStatus = "pending" | "in-progress" | "done" | "error";

/**
 * A single operation in the deletion process.
 */
export interface DeletionOperation {
  readonly id: DeletionOperationId;
  readonly label: string;
  readonly status: DeletionOperationStatus;
  readonly error?: string;
}

/**
 * Progress state for workspace deletion.
 * Contains the full state of all operations, emitted with each update.
 */
export interface DeletionProgress {
  readonly workspacePath: WorkspacePath;
  readonly workspaceName: WorkspaceName;
  readonly projectId: ProjectId;
  readonly keepBranch: boolean;
  readonly operations: readonly DeletionOperation[];
  readonly completed: boolean;
  readonly hasErrors: boolean;
  /**
   * Processes blocking workspace deletion (Windows only).
   * Present when cleanup-workspace fails with EBUSY/EACCES/EPERM.
   */
  readonly blockingProcesses?: readonly BlockingProcess[];
}
