/**
 * Preload script for the UI layer.
 * Exposes type-safe IPC API via contextBridge.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { IpcChannels } from "../shared/ipc";
import type {
  ProjectOpenedEvent,
  ProjectClosedEvent,
  WorkspaceCreatedEvent,
  WorkspaceRemovedEvent,
  WorkspaceSwitchedEvent,
  AgentStatusChangedEvent,
  AggregatedAgentStatus,
} from "../shared/ipc";

/**
 * Function to unsubscribe from an event.
 */
type Unsubscribe = () => void;

/**
 * Creates a type-safe event subscription function.
 */
function createEventSubscription<T>(channel: string) {
  return (callback: (event: T) => void): Unsubscribe => {
    const handler = (_event: IpcRendererEvent, data: T) => callback(data);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  };
}

// Expose the API to the renderer process
contextBridge.exposeInMainWorld("api", {
  // ============ Commands ============

  /**
   * Open a folder picker dialog to select a project directory.
   * @returns The selected path, or null if cancelled
   */
  selectFolder: (): Promise<string | null> => ipcRenderer.invoke(IpcChannels.PROJECT_SELECT_FOLDER),

  /**
   * Open a project from the given path.
   * @param path - Absolute path to the git repository
   */
  openProject: (path: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.PROJECT_OPEN, { path }),

  /**
   * Close an open project.
   * @param path - Absolute path to the project
   */
  closeProject: (path: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.PROJECT_CLOSE, { path }),

  /**
   * List all open projects.
   * @returns Array of open projects
   */
  listProjects: () => ipcRenderer.invoke(IpcChannels.PROJECT_LIST),

  /**
   * Create a new workspace (git worktree) in a project.
   * @param projectPath - Path to the project
   * @param name - Name for the new workspace
   * @param baseBranch - Branch to base the workspace on
   */
  createWorkspace: (projectPath: string, name: string, baseBranch: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.WORKSPACE_CREATE, { projectPath, name, baseBranch }),

  /**
   * Remove a workspace from a project.
   * @param workspacePath - Path to the workspace
   * @param deleteBranch - Whether to also delete the associated branch
   */
  removeWorkspace: (workspacePath: string, deleteBranch: boolean): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.WORKSPACE_REMOVE, { workspacePath, deleteBranch }),

  /**
   * Switch to a different workspace.
   * @param workspacePath - Path to the workspace to switch to
   * @param focusWorkspace - Whether to focus the workspace view (default: true)
   */
  switchWorkspace: (workspacePath: string, focusWorkspace?: boolean): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.WORKSPACE_SWITCH, { workspacePath, focusWorkspace }),

  /**
   * List available branches for workspace creation.
   * @param projectPath - Path to the project
   * @returns Array of branch information
   */
  listBases: (projectPath: string) =>
    ipcRenderer.invoke(IpcChannels.WORKSPACE_LIST_BASES, { projectPath }),

  /**
   * Update available branches by fetching from remotes.
   * @param projectPath - Path to the project
   */
  updateBases: (projectPath: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.WORKSPACE_UPDATE_BASES, { projectPath }),

  /**
   * Check if a workspace has uncommitted changes.
   * @param workspacePath - Path to the workspace
   * @returns True if the workspace has uncommitted changes
   */
  isWorkspaceDirty: (workspacePath: string): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.WORKSPACE_IS_DIRTY, { workspacePath }),

  /**
   * Set dialog mode (z-order swapping).
   * @param isOpen - True to move UI layer to top (dialog mode), false for normal mode
   */
  setDialogMode: (isOpen: boolean): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.UI_SET_DIALOG_MODE, { isOpen }),

  /**
   * Focus the active workspace view.
   * Used to return focus to VS Code after shortcut mode ends.
   */
  focusActiveWorkspace: (): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.UI_FOCUS_ACTIVE_WORKSPACE),

  // ============ Event Subscriptions ============

  onProjectOpened: createEventSubscription<ProjectOpenedEvent>(IpcChannels.PROJECT_OPENED),
  onProjectClosed: createEventSubscription<ProjectClosedEvent>(IpcChannels.PROJECT_CLOSED),
  onWorkspaceCreated: createEventSubscription<WorkspaceCreatedEvent>(IpcChannels.WORKSPACE_CREATED),
  onWorkspaceRemoved: createEventSubscription<WorkspaceRemovedEvent>(IpcChannels.WORKSPACE_REMOVED),
  onWorkspaceSwitched: createEventSubscription<WorkspaceSwitchedEvent>(
    IpcChannels.WORKSPACE_SWITCHED
  ),

  // Shortcut events
  onShortcutEnable: createEventSubscription<void>(IpcChannels.SHORTCUT_ENABLE),
  onShortcutDisable: createEventSubscription<void>(IpcChannels.SHORTCUT_DISABLE),

  // ============ Agent Status Commands ============

  /**
   * Get the agent status for a specific workspace.
   * @param workspacePath - Path to the workspace
   * @returns Aggregated agent status for the workspace
   */
  getAgentStatus: (workspacePath: string): Promise<AggregatedAgentStatus> =>
    ipcRenderer.invoke(IpcChannels.AGENT_GET_STATUS, { workspacePath }),

  /**
   * Get all workspace agent statuses.
   * @returns Record of workspace paths to their statuses
   */
  getAllAgentStatuses: (): Promise<Record<string, AggregatedAgentStatus>> =>
    ipcRenderer.invoke(IpcChannels.AGENT_GET_ALL_STATUSES),

  /**
   * Trigger a manual refresh of agent status discovery.
   */
  refreshAgentStatus: (): Promise<void> => ipcRenderer.invoke(IpcChannels.AGENT_REFRESH),

  // ============ Agent Status Events ============

  /**
   * Subscribe to agent status change events.
   * @param callback - Called when an agent status changes
   * @returns Unsubscribe function to remove the listener
   */
  onAgentStatusChanged: createEventSubscription<AgentStatusChangedEvent>(
    IpcChannels.AGENT_STATUS_CHANGED
  ),
});
