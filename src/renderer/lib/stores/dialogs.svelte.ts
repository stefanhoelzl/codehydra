/**
 * Dialog state store using Svelte 5 runes.
 * Manages the state of renderer-side dialogs (remove workspace, close project).
 */

import type { ProjectId, WorkspaceRef } from "@shared/api/types";

// ============ Types ============

export type DialogState =
  | { type: "closed" }
  | { type: "remove"; workspaceRef: WorkspaceRef }
  | { type: "close-project"; projectId: ProjectId };

// ============ State ============

let _dialogState = $state<DialogState>({ type: "closed" });

// ============ Getters ============

export const dialogState = {
  get value() {
    return _dialogState;
  },
};

// ============ Actions ============

/**
 * Open the remove workspace dialog.
 * @param workspaceRef - Reference to the workspace to remove (projectId + workspaceName + path)
 */
export function openRemoveDialog(workspaceRef: WorkspaceRef): void {
  _dialogState = { type: "remove", workspaceRef };
}

/**
 * Open the close project dialog.
 * @param projectId - ID of the project to close
 */
export function openCloseProjectDialog(projectId: ProjectId): void {
  _dialogState = { type: "close-project", projectId };
}

/**
 * Close the current dialog.
 */
export function closeDialog(): void {
  _dialogState = { type: "closed" };
}

/**
 * Reset store to initial state. Used for testing.
 */
export function reset(): void {
  _dialogState = { type: "closed" };
}
