/**
 * New Workspace view store using Svelte 5 runes.
 *
 * The "New workspace" view is a full-content-area panel (not a modal) hosting
 * the backend creation module's always-alive form session (rendered by
 * MainView via PanelView). It is opened from the global sidebar entry, via
 * Alt+X+Enter, or shown automatically as the empty state when no workspaces
 * exist.
 *
 * Only visibility lives here: the renderer owns the isOpen flag and MainView
 * sends a dismiss to the backend on each show transition (fresh-form reset).
 * All form state (project, name, branch, prompt, agent) is owned by the
 * creation module in the main process.
 */

import { setActiveWorkspace } from "./projects.svelte.js";

// ============ State ============

let _isOpen = $state(false);

// Submit handler registered by MainView while the panel is shown, so keyboard
// shortcuts (Alt+X+Enter) can trigger the panel form's primary action.
let _submitHandler: (() => void) | null = null;

// ============ Getters ============

export const newWorkspaceView = {
  get isOpen(): boolean {
    return _isOpen;
  },
};

// ============ Actions ============

/**
 * Open the New workspace view.
 */
export function openNewWorkspaceView(): void {
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
  _submitHandler = null;
}
