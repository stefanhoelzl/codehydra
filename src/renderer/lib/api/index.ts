/**
 * Renderer API layer.
 * Re-exports window.api for mockability in tests.
 *
 * Setup is driven by the main process (app:setup intent).
 * The renderer signals readiness by emitting the `ui-connected` ui:event
 * (see initialize-app); the renderer requests quit via the `setup-quit`
 * ui:event.
 *
 * All renderer→main gestures are fire-and-forget ui:events (emitEvent) —
 * switch-workspace / wake-workspace / remove-workspace / close-project carry
 * the opaque snapshot identity and main owns resolution + dispatch. There are
 * no renderer→main command invokes left.
 */

import type { UiEvent } from "@shared/ui-event";
import type { DialogUserEvent } from "@shared/dialog-types";
import type { NotificationUserEvent } from "@shared/notification-types";

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

/**
 * Forward a dialog user interaction to the main process as a ui:event. The
 * presenter routes it to the owning dialog session by `dialogId`. Kept as a
 * thin translator so Form/MainView can keep building DialogUserEvents.
 */
export function sendDialogEvent(event: DialogUserEvent): void {
  if (event.kind === "change") {
    emitEvent({
      kind: "dialog-change",
      dialogId: event.dialogId,
      fieldId: event.fieldId,
      data: event.data,
    });
  } else if (event.kind === "dismiss") {
    emitEvent({ kind: "dialog-dismiss", dialogId: event.dialogId });
  } else {
    // Action (kind "action" or absent).
    emitEvent({
      kind: "dialog-action",
      dialogId: event.dialogId,
      actionId: event.actionId,
      ...(event.data !== undefined && { data: event.data }),
    });
  }
}

/**
 * Forward a notification user interaction to the main process as a ui:event.
 */
export function sendNotificationEvent(event: NotificationUserEvent): void {
  emitEvent({
    kind: "notification-event",
    notificationId: event.notificationId,
    actionId: event.actionId,
  });
}

// Re-export window.api functions for mockability
export const {
  // Event subscriptions
  on,
  // UI state snapshots (main process → renderer)
  onState,
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
