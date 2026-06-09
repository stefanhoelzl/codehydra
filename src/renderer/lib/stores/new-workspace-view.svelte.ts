/**
 * New Workspace view store using Svelte 5 runes.
 *
 * The "New workspace" view is a full-content-area panel (not a modal) that
 * replaces the old create-workspace dialog. It is opened from the global
 * sidebar entry, via Alt+X+Enter, or shown automatically as the empty state
 * when no workspaces exist.
 *
 * Only the open flag and the selected project live here. The selected project
 * is stored so it survives across opens and so external flows (git clone,
 * folder open) can populate it. The remaining form fields (name, branch,
 * prompt, agent) are component-local to NewWorkspaceView so the in-progress
 * draft is preserved while the panel stays mounted.
 */

import type { ProjectId } from "@shared/api/types";
import { projects, setActiveWorkspace } from "./projects.svelte.js";

// ============ State ============

let _isOpen = $state(false);
let _selectedProjectId = $state<ProjectId | null>(null);

// Submit handler registered by the mounted NewWorkspaceView, so keyboard
// shortcuts (Alt+X+Enter) can trigger Create without owning the form state.
let _submitHandler: (() => void) | null = null;

// ============ Getters ============

export const newWorkspaceView = {
  get isOpen(): boolean {
    return _isOpen;
  },
  /**
   * Effective selected project: explicit selection, falling back to the first
   * available project. There is intentionally no pre-fill from the active
   * workspace's project.
   */
  get selectedProjectId(): ProjectId | undefined {
    return _selectedProjectId ?? projects.value[0]?.id;
  },
};

// ============ Actions ============

/**
 * Open the New workspace view.
 * @param projectId - Optional project to select (used by git clone / folder open
 *   and the project:opened hook). When omitted, the current selection is kept.
 */
export function openNewWorkspaceView(projectId?: ProjectId): void {
  if (projectId !== undefined) {
    _selectedProjectId = projectId;
  }
  _isOpen = true;
  // The New workspace view IS the current tab: no workspace is selected while
  // it's open. This keeps H/Del naturally inert (they target the active
  // workspace) and lets the sidebar de-highlight the previous workspace.
  setActiveWorkspace(null);
}

/**
 * Close the New workspace view (e.g. when navigating to a workspace).
 */
export function closeNewWorkspaceView(): void {
  _isOpen = false;
}

/**
 * Set the selected project (project dropdown selection, clone/folder-open result).
 */
export function setNewWorkspaceProject(projectId: ProjectId): void {
  _selectedProjectId = projectId;
}

/**
 * Reset the project selection back to the default (first available project).
 * Used when the form is reset after a successful create or cleared via Escape.
 */
export function resetNewWorkspaceProject(): void {
  _selectedProjectId = null;
}

/**
 * Register (or clear with null) the submit handler from the mounted view.
 */
export function registerSubmitHandler(handler: (() => void) | null): void {
  _submitHandler = handler;
}

/**
 * Trigger the view's Create action (used by Alt+X+Enter while the view is open).
 * No-op if the view isn't mounted/registered or the form is invalid.
 */
export function requestSubmit(): void {
  _submitHandler?.();
}

/**
 * Reset store to initial state. Used for testing.
 */
export function reset(): void {
  _isOpen = false;
  _selectedProjectId = null;
  _submitHandler = null;
}
