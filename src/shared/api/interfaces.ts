/**
 * API interface definitions for CodeHydra.
 * Stub file - implementation coming in Step 1.4.
 */

import type {
  ProjectId,
  WorkspaceName,
  Project,
  Workspace,
  WorkspaceRef,
  WorkspaceStatus,
  BaseInfo,
  InitialPrompt,
  AgentSession,
  SetupScreenProgress,
} from "./types";
import type { UIMode, UIModeChangedEvent } from "../ipc";
import type { IDisposable, Unsubscribe } from "../types";

// Re-export for consumers that import from this module
export type { IDisposable, Unsubscribe } from "../types";

// =============================================================================
// Domain API Interfaces - Stubs
// =============================================================================

/**
 * Options for closing a project.
 */
export interface ProjectCloseOptions {
  /** If true and project has remoteUrl, delete the entire project directory including cloned repo */
  readonly removeLocalRepo?: boolean;
}

export interface IProjectApi {
  open(path: string): Promise<Project>;
  close(projectId: ProjectId, options?: ProjectCloseOptions): Promise<void>;
  /**
   * Clone a git repository and create a new project.
   * If the URL has already been cloned, returns the existing project.
   *
   * @param url Git remote URL (HTTPS or SSH format)
   * @returns The created or existing project
   * @throws Error if clone fails (network, auth, invalid URL)
   */
  clone(url: string): Promise<Project>;
  fetchBases(projectId: ProjectId): Promise<{ readonly bases: readonly BaseInfo[] }>;
}

/**
 * Options for workspace creation.
 */
export interface WorkspaceCreateOptions {
  /** Optional initial prompt to send after workspace is created */
  readonly initialPrompt?: InitialPrompt;
  /** If true, don't switch to the new workspace (default: false = switch to it) */
  readonly keepInBackground?: boolean;
}

export interface IWorkspaceApi {
  /**
   * Create a new workspace.
   *
   * @param projectId Project to create the workspace in
   * @param name Name of the new workspace
   * @param base Base branch to create the workspace from
   * @param options Optional creation options (initialPrompt, keepInBackground)
   */
  create(
    projectId: ProjectId,
    name: string,
    base: string,
    options?: WorkspaceCreateOptions
  ): Promise<Workspace>;
  /**
   * Start workspace removal (fire-and-forget).
   * Progress is emitted via workspace:deletion-progress events.
   * Returns { started: true } on success, { started: false } if blocked by idempotency.
   *
   * @param projectId Project containing the workspace
   * @param workspaceName Name of the workspace to remove
   * @param options Optional removal options (keepBranch, skipSwitch, force, unblock, isRetry)
   */
  remove(
    projectId: ProjectId,
    workspaceName: WorkspaceName,
    options?: {
      keepBranch?: boolean;
      skipSwitch?: boolean;
      force?: boolean;
      unblock?: "kill" | "close" | "ignore";
      isRetry?: boolean;
    }
  ): Promise<{ started: boolean }>;
  getStatus(projectId: ProjectId, workspaceName: WorkspaceName): Promise<WorkspaceStatus>;
  /**
   * Get the agent session info for a workspace.
   * @param projectId Project containing the workspace
   * @param workspaceName Name of the workspace
   * @returns Session info (port and sessionId) if available, null if not running or not initialized
   * @throws Error if project or workspace not found
   */
  getAgentSession(projectId: ProjectId, workspaceName: WorkspaceName): Promise<AgentSession | null>;
  /**
   * Set a metadata value for a workspace.
   * @param projectId Project containing the workspace
   * @param workspaceName Name of the workspace
   * @param key Metadata key (must match /^[A-Za-z][A-Za-z0-9-]*$/)
   * @param value Value to set, or null to delete the key
   * @throws Error if project or workspace not found, or key format invalid
   */
  setMetadata(
    projectId: ProjectId,
    workspaceName: WorkspaceName,
    key: string,
    value: string | null
  ): Promise<void>;
  /**
   * Get all metadata for a workspace.
   * Always includes `base` key (with fallback if not in config).
   * @param projectId Project containing the workspace
   * @param workspaceName Name of the workspace
   * @returns Metadata record with at least `base` key
   * @throws Error if project or workspace not found
   */
  getMetadata(
    projectId: ProjectId,
    workspaceName: WorkspaceName
  ): Promise<Readonly<Record<string, string>>>;
  /**
   * Execute a VS Code command in a workspace.
   *
   * Note: Most VS Code commands return `undefined`. The return type is `unknown`
   * because command return types are not statically typed.
   *
   * @param projectId Project containing the workspace
   * @param workspaceName Name of the workspace
   * @param command VS Code command identifier (e.g., "workbench.action.files.save")
   * @param args Optional arguments to pass to the command
   * @returns The command's return value, or undefined if command returns nothing
   * @throws Error if workspace not found, workspace not connected, command not found, or execution fails
   * @throws Error if command times out (10-second limit)
   */
  executeCommand(
    projectId: ProjectId,
    workspaceName: WorkspaceName,
    command: string,
    args?: readonly unknown[]
  ): Promise<unknown>;
  /**
   * Restart the agent server for a workspace, preserving the same port.
   * Useful for reloading configuration changes without affecting other workspaces.
   *
   * @param projectId Project containing the workspace
   * @param workspaceName Name of the workspace
   * @returns The port number of the restarted server
   * @throws Error if project or workspace not found, or server not running
   */
  restartAgentServer(projectId: ProjectId, workspaceName: WorkspaceName): Promise<number>;
}

export interface IUiApi {
  selectFolder(): Promise<string | null>;
  getActiveWorkspace(): Promise<WorkspaceRef | null>;
  switchWorkspace(
    projectId: ProjectId,
    workspaceName: WorkspaceName,
    focus?: boolean
  ): Promise<void>;
  /**
   * Sets the UI mode.
   * - "workspace": UI at z-index 0, focus active workspace
   * - "shortcut": UI on top, focus UI layer
   * - "dialog": UI on top, no focus change
   *
   * Mode transitions are idempotent - setting the same mode twice does not emit an event.
   *
   * @param mode - The new UI mode
   */
  setMode(mode: UIMode): Promise<void>;
}

export interface ILifecycleApi {
  /**
   * Signal that the renderer is ready to receive state.
   * The main process emits domain events for all current state
   * (project:opened, workspace:switched) before the promise resolves.
   */
  ready(): Promise<void>;
  /**
   * Quit the application.
   */
  quit(): Promise<void>;
}

// =============================================================================
// Event Types
// =============================================================================

export interface ApiEvents {
  "project:opened": (event: { readonly project: Project }) => void;
  "project:closed": (event: { readonly projectId: ProjectId }) => void;
  "project:bases-updated": (event: {
    readonly projectId: ProjectId;
    readonly bases: readonly BaseInfo[];
  }) => void;
  "workspace:created": (event: {
    readonly projectId: ProjectId;
    readonly workspace: Workspace;
    /** True if an initial prompt was provided for the workspace */
    readonly hasInitialPrompt?: boolean;
    /** True if workspace should stay in background (no auto-switch) */
    readonly keepInBackground?: boolean;
  }) => void;
  "workspace:removed": (event: WorkspaceRef) => void;
  "workspace:switched": (event: WorkspaceRef | null) => void;
  "workspace:status-changed": (event: WorkspaceRef & { readonly status: WorkspaceStatus }) => void;
  "workspace:metadata-changed": (event: {
    readonly projectId: ProjectId;
    readonly workspaceName: WorkspaceName;
    readonly key: string;
    readonly value: string | null; // null means deleted
  }) => void;
  "ui:mode-changed": (event: UIModeChangedEvent) => void;
  "lifecycle:setup-progress": (event: SetupScreenProgress) => void;
}

// =============================================================================
// Main API Interface
// =============================================================================

export interface ICodeHydraApi extends IDisposable {
  readonly projects: IProjectApi;
  readonly workspaces: IWorkspaceApi;
  readonly ui: IUiApi;
  readonly lifecycle: ILifecycleApi;
  on<E extends keyof ApiEvents>(event: E, handler: ApiEvents[E]): Unsubscribe;
}

// =============================================================================
// Core API (subset for MCP/CLI)
// =============================================================================

export type ICoreApi = Pick<ICodeHydraApi, "projects" | "workspaces" | "on" | "dispose">;
