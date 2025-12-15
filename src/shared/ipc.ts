/**
 * IPC channel names and payload types.
 * Shared between main, preload, and renderer processes.
 *
 * NOTE: This file must be browser-compatible (no Node.js imports).
 * Validation schemas are in src/main/ipc/validation.ts.
 */

// ============ Branded Path Types ============

declare const ProjectPathBrand: unique symbol;
declare const WorkspacePathBrand: unique symbol;
declare const PortBrand: unique symbol;

/**
 * Branded type for project paths (git repository root directories).
 */
export type ProjectPath = string & { readonly [ProjectPathBrand]: true };

/**
 * Branded type for workspace paths (git worktree directories).
 */
export type WorkspacePath = string & { readonly [WorkspacePathBrand]: true };

/**
 * Branded type for network port numbers.
 */
export type Port = number & { readonly [PortBrand]: true };

// ============ Domain Types ============

/**
 * NOTE: Domain types are intentionally redefined here instead of re-exported from services/.
 *
 * Reason: Browser compatibility. The shared/ directory is used by the renderer process,
 * which runs in a browser context and cannot import from services/ (Node.js code).
 * These types mirror the corresponding interfaces in services/git/types.ts.
 *
 * When updating these types, ensure the services/ types are updated as well.
 */

/**
 * Workspace representation for the application.
 * Mirrors services/git/types.ts Workspace interface.
 */
export interface Workspace {
  /** Workspace name */
  readonly name: string;
  /** Absolute path to the workspace directory */
  readonly path: string;
  /** Branch checked out in workspace, null if detached HEAD */
  readonly branch: string | null;
}

/**
 * Base (branch) information for workspace creation.
 * Mirrors services/git/types.ts BaseInfo interface.
 */
export interface BaseInfo {
  /** Branch name */
  readonly name: string;
  /** Whether this is a remote branch */
  readonly isRemote: boolean;
}

/**
 * Result of workspace removal operation.
 * Mirrors services/git/types.ts RemovalResult interface.
 */
export interface RemovalResult {
  /** Whether the workspace was successfully removed */
  readonly workspaceRemoved: boolean;
  /** Whether the base branch was deleted (if requested) */
  readonly baseDeleted: boolean;
}

/**
 * Result of updating bases (fetching from remotes).
 * Mirrors services/git/types.ts UpdateBasesResult interface.
 */
export interface UpdateBasesResult {
  /** Remotes that were successfully fetched */
  readonly fetchedRemotes: readonly string[];
  /** Remotes that failed to fetch with error messages */
  readonly failedRemotes: readonly { remote: string; error: string }[];
}

/**
 * Project representation containing workspaces.
 */
export interface Project {
  readonly path: ProjectPath;
  readonly name: string; // folder name
  readonly workspaces: readonly Workspace[];
  /** Default base branch for creating workspaces (last used or "main"/"master" fallback) */
  readonly defaultBaseBranch?: string;
}

// ============ Agent Status Types ============

/**
 * Counts of agents in each status for a workspace.
 */
export interface AgentStatusCounts {
  readonly idle: number;
  readonly busy: number;
}

/**
 * Aggregated agent status for a workspace (discriminated union).
 */
export type AggregatedAgentStatus =
  | { readonly status: "none"; readonly counts: AgentStatusCounts }
  | { readonly status: "idle"; readonly counts: AgentStatusCounts }
  | { readonly status: "busy"; readonly counts: AgentStatusCounts }
  | { readonly status: "mixed"; readonly counts: AgentStatusCounts };

/**
 * Event payload for agent status changes.
 */
export interface AgentStatusChangedEvent {
  readonly workspacePath: WorkspacePath;
  readonly status: AggregatedAgentStatus;
}

// ============ UI Mode Types ============

/**
 * UI mode for the application.
 * - "workspace": Normal mode, workspace view has focus, UI behind workspace
 * - "shortcut": Shortcut mode active, UI on top, shows keyboard hints
 * - "dialog": Dialog open, UI on top, dialog has focus
 */
export type UIMode = "workspace" | "dialog" | "shortcut";

/**
 * Event payload for UI mode changes.
 */
export interface UIModeChangedEvent {
  readonly mode: UIMode;
  readonly previousMode: UIMode;
}

// ============ Setup Types ============

/**
 * Setup steps for progress tracking.
 * NOTE: Mirrors services/vscode-setup/types.ts SetupStep.
 */
export type SetupStep = "extensions" | "config" | "finalize";

/**
 * Progress information for setup UI updates.
 * NOTE: Mirrors services/vscode-setup/types.ts SetupProgress.
 */
export interface SetupProgress {
  readonly step: SetupStep;
  readonly message: string;
}

/**
 * Error information for setup failures.
 */
export interface SetupErrorPayload {
  readonly message: string;
  readonly code: string;
}

/**
 * Response from setup:ready command.
 * Check if VS Code setup is complete.
 * Returns ready=true if setup done, ready=false if setup needed.
 */
export interface SetupReadyResponse {
  readonly ready: boolean;
}

// ============ Legacy Event Payload Types ============
// NOTE: These legacy event types are used by v1 domain event handlers (setupDomainEvents).
// They're kept for backward compatibility but new code should use v2 API types from @shared/api/types.

export interface ProjectOpenedEvent {
  readonly project: Project;
}

export interface ProjectClosedEvent {
  readonly path: ProjectPath;
}

export interface WorkspaceCreatedEvent {
  readonly projectPath: ProjectPath;
  readonly workspace: Workspace;
  /** The base branch used for workspace creation (updates project's defaultBaseBranch) */
  readonly defaultBaseBranch?: string;
}

export interface WorkspaceRemovedEvent {
  readonly projectPath: ProjectPath;
  readonly workspacePath: WorkspacePath;
}

export interface WorkspaceSwitchedEvent {
  readonly workspacePath: WorkspacePath | null;
}

// ============ Legacy IPC Channels ============
//
// NOTE: Most IPC communication now uses the v2 API (ApiIpcChannels below).
// These legacy channels remain for:
// - Setup: Setup handlers are registered during bootstrap BEFORE startServices() runs.
//   The v2 lifecycle handlers are registered in startServices(), so setup must use legacy channels.

export const IpcChannels = {
  // Setup channels (must be registered early, before v2 API handlers)
  SETUP_READY: "setup:ready",
  SETUP_RETRY: "setup:retry",
  SETUP_QUIT: "setup:quit",
  SETUP_PROGRESS: "setup:progress",
  SETUP_COMPLETE: "setup:complete",
  SETUP_ERROR: "setup:error",
} as const satisfies Record<string, string>;

// ============ API Layer IPC Channels (New) ============
// These channels use the api: prefix and work with the new ICodeHydraApi interface.
// During migration, both old and new channels coexist.

/**
 * New API-based IPC channel names.
 * Uses branded types (ProjectId, WorkspaceName) instead of paths.
 */
export const ApiIpcChannels = {
  // Project commands
  PROJECT_OPEN: "api:project:open",
  PROJECT_CLOSE: "api:project:close",
  PROJECT_LIST: "api:project:list",
  PROJECT_GET: "api:project:get",
  PROJECT_FETCH_BASES: "api:project:fetch-bases",
  // Workspace commands
  WORKSPACE_CREATE: "api:workspace:create",
  WORKSPACE_REMOVE: "api:workspace:remove",
  WORKSPACE_GET: "api:workspace:get",
  WORKSPACE_GET_STATUS: "api:workspace:get-status",
  // UI commands
  UI_SELECT_FOLDER: "api:ui:select-folder",
  UI_GET_ACTIVE_WORKSPACE: "api:ui:get-active-workspace",
  UI_SWITCH_WORKSPACE: "api:ui:switch-workspace",
  UI_SET_MODE: "api:ui:set-mode",
  // Lifecycle commands
  LIFECYCLE_GET_STATE: "api:lifecycle:get-state",
  LIFECYCLE_SETUP: "api:lifecycle:setup",
  LIFECYCLE_QUIT: "api:lifecycle:quit",
  // Events (main → renderer)
  PROJECT_OPENED: "api:project:opened",
  PROJECT_CLOSED: "api:project:closed",
  PROJECT_BASES_UPDATED: "api:project:bases-updated",
  WORKSPACE_CREATED: "api:workspace:created",
  WORKSPACE_REMOVED: "api:workspace:removed",
  WORKSPACE_SWITCHED: "api:workspace:switched",
  WORKSPACE_STATUS_CHANGED: "api:workspace:status-changed",
  UI_MODE_CHANGED: "api:ui:mode-changed",
  SHORTCUT_KEY: "api:shortcut:key",
  SETUP_PROGRESS: "api:setup:progress",
} as const satisfies Record<string, string>;

// ============ API Layer Payload Types ============

/**
 * Payload for api:project:open command.
 */
export interface ApiProjectOpenPayload {
  readonly path: string;
}

/**
 * Payload for api:project:close command.
 */
export interface ApiProjectClosePayload {
  readonly projectId: string;
}

/**
 * Payload for api:project:get command.
 */
export interface ApiProjectGetPayload {
  readonly projectId: string;
}

/**
 * Payload for api:project:fetch-bases command.
 */
export interface ApiProjectFetchBasesPayload {
  readonly projectId: string;
}

/**
 * Payload for api:workspace:create command.
 */
export interface ApiWorkspaceCreatePayload {
  readonly projectId: string;
  readonly name: string;
  readonly base: string;
}

/**
 * Payload for api:workspace:remove command.
 */
export interface ApiWorkspaceRemovePayload {
  readonly projectId: string;
  readonly workspaceName: string;
  readonly keepBranch?: boolean;
}

/**
 * Payload for api:workspace:get command.
 */
export interface ApiWorkspaceGetPayload {
  readonly projectId: string;
  readonly workspaceName: string;
}

/**
 * Payload for api:workspace:get-status command.
 */
export interface ApiWorkspaceGetStatusPayload {
  readonly projectId: string;
  readonly workspaceName: string;
}

/**
 * Payload for api:ui:switch-workspace command.
 */
export interface ApiUiSwitchWorkspacePayload {
  readonly projectId: string;
  readonly workspaceName: string;
  readonly focus?: boolean;
}

/**
 * Payload for api:ui:set-mode command.
 */
export interface ApiUiSetModePayload {
  readonly mode: UIMode;
}
