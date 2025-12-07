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

/**
 * Branded type for project paths (git repository root directories).
 */
export type ProjectPath = string & { readonly [ProjectPathBrand]: true };

/**
 * Branded type for workspace paths (git worktree directories).
 */
export type WorkspacePath = string & { readonly [WorkspacePathBrand]: true };

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
}

// ============ Payload Types ============

export interface ProjectOpenPayload {
  readonly path: string;
}

export interface ProjectClosePayload {
  readonly path: string;
}

export interface WorkspaceCreatePayload {
  readonly projectPath: string;
  readonly name: string;
  readonly baseBranch: string;
}

export interface WorkspaceRemovePayload {
  readonly workspacePath: string;
  readonly deleteBranch: boolean;
}

export interface WorkspaceSwitchPayload {
  readonly workspacePath: string;
  /** Whether to focus the workspace view after switching (default: true) */
  readonly focusWorkspace?: boolean;
}

export interface WorkspaceListBasesPayload {
  readonly projectPath: string;
}

export interface WorkspaceUpdateBasesPayload {
  readonly projectPath: string;
}

export interface WorkspaceIsDirtyPayload {
  readonly workspacePath: string;
}

export interface UISetDialogModePayload {
  readonly isOpen: boolean;
}

// No payload needed for focus-active-workspace

// ============ Event Payload Types ============

export interface ProjectOpenedEvent {
  readonly project: Project;
}

export interface ProjectClosedEvent {
  readonly path: ProjectPath;
}

export interface WorkspaceCreatedEvent {
  readonly projectPath: ProjectPath;
  readonly workspace: Workspace;
}

export interface WorkspaceRemovedEvent {
  readonly projectPath: ProjectPath;
  readonly workspacePath: WorkspacePath;
}

export interface WorkspaceSwitchedEvent {
  readonly workspacePath: WorkspacePath;
}

// ============ Type-Safe IPC Contract ============

export interface IpcCommands {
  "project:open": { payload: ProjectOpenPayload; response: Project };
  "project:close": { payload: ProjectClosePayload; response: void };
  "project:list": { payload: void; response: Project[] };
  "project:select-folder": { payload: void; response: string | null };
  "workspace:create": { payload: WorkspaceCreatePayload; response: Workspace };
  "workspace:remove": { payload: WorkspaceRemovePayload; response: RemovalResult };
  "workspace:switch": { payload: WorkspaceSwitchPayload; response: void };
  "workspace:list-bases": { payload: WorkspaceListBasesPayload; response: BaseInfo[] };
  "workspace:update-bases": {
    payload: WorkspaceUpdateBasesPayload;
    response: UpdateBasesResult;
  };
  "workspace:is-dirty": { payload: WorkspaceIsDirtyPayload; response: boolean };
  "ui:set-dialog-mode": { payload: UISetDialogModePayload; response: void };
  "ui:focus-active-workspace": { payload: void; response: void };
}

export interface IpcEvents {
  "project:opened": ProjectOpenedEvent;
  "project:closed": ProjectClosedEvent;
  "workspace:created": WorkspaceCreatedEvent;
  "workspace:removed": WorkspaceRemovedEvent;
  "workspace:switched": WorkspaceSwitchedEvent;
}

// ============ IPC Channel Names ============

export const IpcChannels = {
  // Commands
  PROJECT_OPEN: "project:open",
  PROJECT_CLOSE: "project:close",
  PROJECT_LIST: "project:list",
  PROJECT_SELECT_FOLDER: "project:select-folder",
  WORKSPACE_CREATE: "workspace:create",
  WORKSPACE_REMOVE: "workspace:remove",
  WORKSPACE_SWITCH: "workspace:switch",
  WORKSPACE_LIST_BASES: "workspace:list-bases",
  WORKSPACE_UPDATE_BASES: "workspace:update-bases",
  WORKSPACE_IS_DIRTY: "workspace:is-dirty",
  UI_SET_DIALOG_MODE: "ui:set-dialog-mode",
  UI_FOCUS_ACTIVE_WORKSPACE: "ui:focus-active-workspace",
  // Events
  PROJECT_OPENED: "project:opened",
  PROJECT_CLOSED: "project:closed",
  WORKSPACE_CREATED: "workspace:created",
  WORKSPACE_REMOVED: "workspace:removed",
  WORKSPACE_SWITCHED: "workspace:switched",
  // Shortcut events (main → renderer)
  SHORTCUT_ENABLE: "shortcut:enable",
  SHORTCUT_DISABLE: "shortcut:disable",
} as const satisfies Record<string, string>;
