/**
 * Renderer API layer.
 * Re-exports window.api for mockability in tests.
 *
 * Setup is driven by the main process (app:setup intent).
 * The renderer signals readiness by emitting the `ui-connected` ui:event
 * (see initialize-app); lifecycle.quit() exits the app.
 *
 * All renderer→main gestures are fire-and-forget ui:events (emitEvent) —
 * switch-workspace / wake-workspace / remove-workspace / close-project carry
 * the opaque snapshot identity and main owns resolution + dispatch. There are
 * no renderer→main command invokes left (only lifecycle.quit remains).
 */

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

// Re-export window.api functions for mockability
export const {
  lifecycle,
  // Event subscriptions
  on,
  // UI state snapshots (main process → renderer)
  onState,
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
