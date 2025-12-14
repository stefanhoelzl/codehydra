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

// ============ Getters ============

export const dialogState = {
  get value() {
    return _dialogState;
  },
};

// ============ Actions ============

/**
 * Open the create workspace dialog.
 * @param projectPath - Path of the project to create workspace in
 */
export function openCreateDialog(projectPath: string): void {
  _dialogState = { type: "create", projectPath };
}

/**
 * Open the remove workspace dialog.
 * @param workspacePath - Path of the workspace to remove
 */
export function openRemoveDialog(workspacePath: string): void {
  _dialogState = { type: "remove", workspacePath };
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
