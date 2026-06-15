/**
 * Renderer API layer.
 * Re-exports window.api for mockability in tests.
 *
 * Setup is driven by the main process (app:setup intent).
 * The renderer signals readiness by emitting the `ui-connected` ui:event
 * (see initialize-app); lifecycle.quit() exits the app.
 *
 * Transitional state of the write path: remove-workspace and close-project
 * are pure ui:events (emitted where the gesture happens; main owns their
 * confirmation dialogs and dispatches). The remaining domain wrappers still
 * dual-fire — an observational UiEvent, then the load-bearing invoke — until
 * the write-path phase flips them too.
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
};

export const workspaces: Api["workspaces"] = {
  hibernate: (workspacePath) => {
    emitEvent({ kind: "hibernate-workspace" });
    return api.workspaces.hibernate(workspacePath);
  },
  wake: (workspacePath) => {
    emitEvent({ kind: "wake-workspace" });
    return api.workspaces.wake(workspacePath);
  },
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
  // UI state snapshots (main process → renderer)
  onState,
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
