/**
 * Renderer API layer.
 * Re-exports window.api for mockability in tests.
 *
 * Setup is driven by the main process (app:setup intent).
 * Renderer subscribes to lifecycle events and responds to agent selection.
 * lifecycle.quit() is the only method the renderer can call.
 */

// Check that window.api is available
if (typeof window === "undefined" || !window.api) {
  throw new Error("window.api is not available. Ensure the preload script is loaded correctly.");
}

// Re-export window.api functions for mockability
export const {
  // Domain APIs
  projects,
  workspaces,
  ui,
  lifecycle,
  // Event subscriptions
  on,
  // UI mode change event
  onModeChange,
  // Shortcut key event (main process → renderer)
  onShortcut,
  // Agent selection event (renderer → main process)
  sendAgentSelected,
  // Retry event (renderer → main process)
  sendRetry,
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
