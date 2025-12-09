/**
 * Type definitions for the Electron API exposed via contextBridge.
 * This file is in shared/ so both main/preload and renderer can access the types.
 */

import type {
  Project,
  BaseInfo,
  ProjectOpenedEvent,
  ProjectClosedEvent,
  WorkspaceCreatedEvent,
  WorkspaceRemovedEvent,
  WorkspaceSwitchedEvent,
  AgentStatusChangedEvent,
  AggregatedAgentStatus,
  SetupProgress,
  SetupErrorPayload,
  SetupReadyResponse,
} from "./ipc";

/**
 * Function to unsubscribe from an event.
 */
export type Unsubscribe = () => void;

/**
 * Type-safe Electron API exposed to the renderer via contextBridge.
 * Individual typed functions for better discoverability and cleaner call sites.
 */
export interface Api {
  // ============ Commands ============

  /**
   * Open a folder picker dialog to select a project directory.
   * @returns The selected path, or null if cancelled
   */
  selectFolder(): Promise<string | null>;

  /**
   * Open a project from the given path.
   * @param path - Absolute path to the git repository
   */
  openProject(path: string): Promise<void>;

  /**
   * Close an open project.
   * @param path - Absolute path to the project
   */
  closeProject(path: string): Promise<void>;

  /**
   * List all open projects.
   * @returns Array of open projects
   */
  listProjects(): Promise<Project[]>;

  /**
   * Create a new workspace (git worktree) in a project.
   * @param projectPath - Path to the project
   * @param name - Name for the new workspace
   * @param baseBranch - Branch to base the workspace on
   */
  createWorkspace(projectPath: string, name: string, baseBranch: string): Promise<void>;

  /**
   * Remove a workspace from a project.
   * @param workspacePath - Path to the workspace
   * @param deleteBranch - Whether to also delete the associated branch
   */
  removeWorkspace(workspacePath: string, deleteBranch: boolean): Promise<void>;

  /**
   * Switch to a different workspace.
   * @param workspacePath - Path to the workspace to switch to
   * @param focusWorkspace - Whether to focus the workspace view (default: true)
   */
  switchWorkspace(workspacePath: string, focusWorkspace?: boolean): Promise<void>;

  /**
   * List available branches for workspace creation.
   * @param projectPath - Path to the project
   * @returns Array of branch information
   */
  listBases(projectPath: string): Promise<BaseInfo[]>;

  /**
   * Update available branches by fetching from remotes.
   * @param projectPath - Path to the project
   */
  updateBases(projectPath: string): Promise<void>;

  /**
   * Check if a workspace has uncommitted changes.
   * @param workspacePath - Path to the workspace
   * @returns True if the workspace has uncommitted changes
   */
  isWorkspaceDirty(workspacePath: string): Promise<boolean>;

  /**
   * Set dialog mode (z-order swapping).
   * @param isOpen - True to move UI layer to top (dialog mode), false for normal mode
   */
  setDialogMode(isOpen: boolean): Promise<void>;

  /**
   * Focus the active workspace view.
   * Used to return focus to VS Code after shortcut mode ends.
   */
  focusActiveWorkspace(): Promise<void>;

  // ============ Event Subscriptions ============

  /**
   * Subscribe to project opened events.
   * @param callback - Called when a project is opened
   * @returns Unsubscribe function to remove the listener
   */
  onProjectOpened(callback: (event: ProjectOpenedEvent) => void): Unsubscribe;

  /**
   * Subscribe to project closed events.
   * @param callback - Called when a project is closed
   * @returns Unsubscribe function to remove the listener
   */
  onProjectClosed(callback: (event: ProjectClosedEvent) => void): Unsubscribe;

  /**
   * Subscribe to workspace created events.
   * @param callback - Called when a workspace is created
   * @returns Unsubscribe function to remove the listener
   */
  onWorkspaceCreated(callback: (event: WorkspaceCreatedEvent) => void): Unsubscribe;

  /**
   * Subscribe to workspace removed events.
   * @param callback - Called when a workspace is removed
   * @returns Unsubscribe function to remove the listener
   */
  onWorkspaceRemoved(callback: (event: WorkspaceRemovedEvent) => void): Unsubscribe;

  /**
   * Subscribe to workspace switched events.
   * @param callback - Called when the active workspace changes
   * @returns Unsubscribe function to remove the listener
   */
  onWorkspaceSwitched(callback: (event: WorkspaceSwitchedEvent) => void): Unsubscribe;

  // ============ Shortcut Events ============

  /**
   * Subscribe to shortcut enable events.
   * Fired when Alt+X is pressed in a workspace view to activate shortcut mode.
   * @param callback - Called when shortcut mode should be enabled
   * @returns Unsubscribe function to remove the listener
   */
  onShortcutEnable(callback: () => void): Unsubscribe;

  /**
   * Subscribe to shortcut disable events.
   * Fired when Alt is released while shortcut mode is active.
   * Handles race condition where Alt keyup is caught by workspace view before focus switches.
   * @param callback - Called when shortcut mode should be disabled
   * @returns Unsubscribe function to remove the listener
   */
  onShortcutDisable(callback: () => void): Unsubscribe;

  // ============ Agent Status Commands ============

  /**
   * Get the agent status for a specific workspace.
   * @param workspacePath - Path to the workspace
   * @returns Aggregated agent status for the workspace
   */
  getAgentStatus(workspacePath: string): Promise<AggregatedAgentStatus>;

  /**
   * Get all workspace agent statuses.
   * @returns Record of workspace paths to their statuses
   */
  getAllAgentStatuses(): Promise<Record<string, AggregatedAgentStatus>>;

  /**
   * Trigger a manual refresh of agent status discovery.
   */
  refreshAgentStatus(): Promise<void>;

  // ============ Agent Status Events ============

  /**
   * Subscribe to agent status change events.
   * @param callback - Called when an agent status changes
   * @returns Unsubscribe function to remove the listener
   */
  onAgentStatusChanged(callback: (event: AgentStatusChangedEvent) => void): Unsubscribe;

  // ============ Setup Commands ============

  /**
   * Check if VS Code setup is complete.
   * Returns { ready: true } if setup done, { ready: false } if setup needed.
   * If setup is needed, main process will start setup asynchronously.
   */
  setupReady(): Promise<SetupReadyResponse>;

  /**
   * Retry setup after a failure.
   * Cleans vscode directory and re-runs setup.
   */
  setupRetry(): Promise<void>;

  /**
   * Quit the application (from setup error screen).
   */
  setupQuit(): Promise<void>;

  // ============ Setup Events ============

  /**
   * Subscribe to setup progress events.
   * @param callback - Called when setup progress updates
   * @returns Unsubscribe function to remove the listener
   */
  onSetupProgress(callback: (progress: SetupProgress) => void): Unsubscribe;

  /**
   * Subscribe to setup complete event.
   * @param callback - Called when setup completes successfully
   * @returns Unsubscribe function to remove the listener
   */
  onSetupComplete(callback: () => void): Unsubscribe;

  /**
   * Subscribe to setup error events.
   * @param callback - Called when setup fails
   * @returns Unsubscribe function to remove the listener
   */
  onSetupError(callback: (error: SetupErrorPayload) => void): Unsubscribe;
}

declare global {
  interface Window {
    api: Api;
  }
}

export {};
