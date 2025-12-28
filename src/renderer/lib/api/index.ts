/**
 * Renderer API layer.
 * Re-exports window.api for mockability in tests.
 *
 * Setup operations use lifecycle API:
 * - lifecycle.getState() returns "ready" | "setup"
 * - lifecycle.setup() runs setup and returns success/failure
 * - lifecycle.quit() quits the app
 * - on("setup:progress", handler) receives progress events
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
} = window.api;

// =============================================================================
// Re-export Utility Functions from id-utils
// =============================================================================

export { workspaceRefKey } from "$lib/utils/id-utils";

// Re-export branded path types from IPC (still used for type safety)
export type { ProjectPath, WorkspacePath } from "@shared/ipc";

export type { Unsubscribe } from "@shared/electron-api";

// Re-export v2 API types for convenience
export type {
  Project,
  Workspace,
  WorkspaceRef,
  WorkspaceStatus,
  AgentStatus,
  AgentStatusCounts,
  BaseInfo,
  SetupResult,
  SetupProgress,
  AppState,
  ProjectId,
  WorkspaceName,
} from "@shared/api/types";
