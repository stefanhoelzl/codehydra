/**
 * Dialog state store using Svelte 5 runes.
 * Manages the state of dialogs (create workspace, remove workspace).
 */

import type { ProjectId, WorkspaceRef } from "@shared/api/types";
import { activeWorkspace, projects } from "./projects.svelte.js";

// ============ Types ============

export type DialogState =
  | { type: "closed" }
  | { type: "create"; projectId?: ProjectId }
  | { type: "remove"; workspaceRef: WorkspaceRef }
  | { type: "close-project"; projectId: ProjectId }
  | { type: "git-clone" };

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
 * Open the create workspace dialog.
 * @param defaultProjectId - Optional ID of the project to create workspace in.
 *   Falls back to activeWorkspace's project, then first project.
 *   If no projects exist, opens dialog without a selected project.
 */
export function openCreateDialog(defaultProjectId?: ProjectId): void {
  const projectId = defaultProjectId ?? activeWorkspace.value?.projectId ?? projects.value[0]?.id;
  if (projectId !== undefined) {
    _dialogState = { type: "create", projectId };
  } else {
    _dialogState = { type: "create" };
  }
}

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
 * Open the git clone dialog.
 */
export function openGitCloneDialog(): void {
  _dialogState = { type: "git-clone" };
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
