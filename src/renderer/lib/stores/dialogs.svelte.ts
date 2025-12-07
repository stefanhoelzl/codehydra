/**
 * Dialog state store using Svelte 5 runes.
 * Manages the state of dialogs (create workspace, remove workspace).
 */

// ============ Types ============

export type DialogState =
  | { type: "closed" }
  | { type: "create"; projectPath: string }
  | { type: "remove"; workspacePath: string };

// ============ State ============

let _dialogState = $state<DialogState>({ type: "closed" });
let _triggerElementId = $state<string | null>(null);

// ============ Getters ============

export const dialogState = {
  get value() {
    return _dialogState;
  },
};

export const triggerElementId = {
  get value() {
    return _triggerElementId;
  },
};

// ============ Actions ============

/**
 * Open the create workspace dialog.
 * @param projectPath - Path of the project to create workspace in
 * @param triggerId - ID of the element that triggered the dialog (for focus return)
 */
export function openCreateDialog(projectPath: string, triggerId: string | null): void {
  _dialogState = { type: "create", projectPath };
  _triggerElementId = triggerId;
}

/**
 * Open the remove workspace dialog.
 * @param workspacePath - Path of the workspace to remove
 * @param triggerId - ID of the element that triggered the dialog (for focus return)
 */
export function openRemoveDialog(workspacePath: string, triggerId: string | null): void {
  _dialogState = { type: "remove", workspacePath };
  _triggerElementId = triggerId;
}

/**
 * Close the current dialog.
 */
export function closeDialog(): void {
  _dialogState = { type: "closed" };
  _triggerElementId = null;
}

/**
 * Get the trigger element by ID for focus return.
 * @returns The element or null if not found
 */
export function getTriggerElement(): HTMLElement | null {
  if (!_triggerElementId) return null;
  return document.getElementById(_triggerElementId);
}

/**
 * Reset store to initial state. Used for testing.
 */
export function reset(): void {
  _dialogState = { type: "closed" };
  _triggerElementId = null;
}
