/**
 * API type definitions for CodeHydra.
 * Provides branded types for compile-time safety and runtime type guards for validation.
 */

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
  /** Base branch the workspace was created from (fallback: branch ?? name) */
  readonly baseBranch: string;
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
 * Result of workspace removal operation.
 */
export interface WorkspaceRemovalResult {
  readonly branchDeleted: boolean;
  readonly branchDeleteError?: string;
}

/**
 * Steps in the VS Code setup process.
 */
export type SetupStep = "extensions" | "settings";

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
// Error Types
// =============================================================================

/**
 * Service error type constant for error categorization.
 */
export type ServiceErrorType =
  | "git"
  | "workspace"
  | "code-server"
  | "project-store"
  | "opencode"
  | "vscode-setup"
  | "filesystem";

/**
 * Serialized service error for IPC transport.
 * Compatible with ServiceError.toJSON() output.
 */
export interface SerializedServiceError {
  readonly type: ServiceErrorType;
  readonly message: string;
  readonly code?: string;
  readonly path?: string;
}

/**
 * API error types aligned with ServiceError pattern.
 */
export type ApiError =
  | { readonly type: "not-found"; readonly resource: "project" | "workspace"; readonly id: string }
  | { readonly type: "validation"; readonly message: string; readonly field?: string }
  | { readonly type: "service"; readonly cause: SerializedServiceError };
