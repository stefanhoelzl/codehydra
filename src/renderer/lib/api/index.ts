/**
 * Renderer API layer.
 * Re-exports window.api for mockability in tests.
 *
 * Setup is driven by the main process (app:setup intent).
 * Renderer subscribes to lifecycle events and responds to agent selection.
 * lifecycle.ready() signals readiness, lifecycle.quit() exits the app.
 *
 * Phase A of the UI-state architecture: the domain API wrappers dual-fire —
 * each emits the matching observational UiEvent, then performs the invoke
 * unchanged. The invokes stay load-bearing; the events are not (yet).
 */

import type { Api } from "@shared/electron-api";
import type { UiEvent } from "@shared/ui-event";

// Check that window.api is available
if (typeof window === "undefined" || !window.api) {
  throw new Error("window.api is not available. Ensure the preload script is loaded correctly.");
}

const api = window.api;

/**
 * Emit a fire-and-forget UI event to the main process.
 * Events are observational; emission must never break the caller.
 */
export function emitEvent(event: UiEvent): void {
  try {
    api.emitEvent(event);
  } catch {
    // Never throw from event emission
  }
}

export const projects: Api["projects"] = {
  open: (path?) => {
    emitEvent({ kind: "open-project" });
    return api.projects.open(path);
  },
  // close-project is emitted by CloseProjectDialog, which knows the
  // backend-minted projectId (this wrapper only receives the path).
  close: (projectPath, options?) => api.projects.close(projectPath, options),
};

export const workspaces: Api["workspaces"] = {
  remove: (workspacePath, options?) => {
    emitEvent({ kind: "remove-workspace" });
    return api.workspaces.remove(workspacePath, options);
  },
  getStatus: (workspacePath, options?) => api.workspaces.getStatus(workspacePath, options),
  hibernate: (workspacePath) => {
    emitEvent({ kind: "hibernate-workspace" });
    return api.workspaces.hibernate(workspacePath);
  },
  wake: (workspacePath) => {
    emitEvent({ kind: "wake-workspace" });
    return api.workspaces.wake(workspacePath);
  },
  getScreenshot: (projectId, workspaceName) =>
    api.workspaces.getScreenshot(projectId, workspaceName),
};

export const ui: Api["ui"] = {
  switchWorkspace: (workspacePath, focus?) => {
    emitEvent({ kind: "switch-workspace" });
    return api.ui.switchWorkspace(workspacePath, focus);
  },
  setMode: (mode) => api.ui.setMode(mode),
};

// Re-export window.api functions for mockability
export const {
  lifecycle,
  // Event subscriptions
  on,
  // UI mode change event
  onModeChange,
  // Shortcut key event (main process → renderer)
  onShortcut,
  // Dialog framework event (renderer → main process)
  sendDialogEvent,
  // Notification framework event (renderer → main process)
  sendNotificationEvent,
} = window.api;

// Re-export branded path types from IPC (still used for type safety)
export type { ProjectPath, WorkspacePath } from "@shared/ipc";

export type { Unsubscribe } from "@shared/electron-api";

// Re-export API types for convenience
export type {
  Project,
  Workspace,
  WorkspaceRef,
  WorkspaceStatus,
  AgentStatus,
  AgentStatusCounts,
  BaseInfo,
  ProjectId,
  WorkspaceName,
} from "@shared/api/types";
