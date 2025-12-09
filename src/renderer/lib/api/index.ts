/**
 * Renderer API layer.
 * Re-exports window.api for mockability in tests.
 */

// Check that window.api is available
if (typeof window === "undefined" || !window.api) {
  throw new Error("window.api is not available. Ensure the preload script is loaded correctly.");
}

// Re-export window.api functions for mockability
export const {
  selectFolder,
  openProject,
  closeProject,
  listProjects,
  createWorkspace,
  removeWorkspace,
  switchWorkspace,
  listBases,
  updateBases,
  isWorkspaceDirty,
  setDialogMode,
  focusActiveWorkspace,
  getAgentStatus,
  getAllAgentStatuses,
  refreshAgentStatus,
  onProjectOpened,
  onProjectClosed,
  onWorkspaceCreated,
  onWorkspaceRemoved,
  onWorkspaceSwitched,
  onShortcutEnable,
  onShortcutDisable,
  onAgentStatusChanged,
  // Setup API methods
  setupReady,
  setupRetry,
  setupQuit,
  onSetupProgress,
  onSetupComplete,
  onSetupError,
} = window.api;

// Re-export types for convenience
export type {
  Project,
  Workspace,
  BaseInfo,
  ProjectPath,
  WorkspacePath,
  ProjectOpenedEvent,
  ProjectClosedEvent,
  WorkspaceCreatedEvent,
  WorkspaceRemovedEvent,
  WorkspaceSwitchedEvent,
} from "@shared/ipc";

export type { Unsubscribe } from "@shared/electron-api";
