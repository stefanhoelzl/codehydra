/**
 * Deletion state store using Svelte 5 runes.
 * Manages deletion progress for workspaces.
 * This is a pure state container - IPC subscriptions are handled externally.
 */

import { SvelteMap } from "svelte/reactivity";
import type { DeletionProgress } from "@shared/api/types";

// ============ State ============

const _deletionStates = new SvelteMap<string, DeletionProgress>();

// ============ Actions ============

/**
 * Set the deletion state for a workspace.
 * @param progress - Full deletion progress state
 */
export function setDeletionState(progress: DeletionProgress): void {
  _deletionStates.set(progress.workspacePath, progress);
}

/**
 * Clear the deletion state for a workspace.
 * @param workspacePath - Path to the workspace
 */
export function clearDeletion(workspacePath: string): void {
  _deletionStates.delete(workspacePath);
}

/**
 * Deletion status type for UI rendering.
 */
export type DeletionStatus = "none" | "in-progress" | "error";

/**
 * Get the deletion status for a workspace.
 * Returns a discriminated status for cleaner UI conditionals.
 *
 * WARNING: Do not use this function inside $derived() expressions.
 * Svelte 5 may not properly track reactivity when reading from a SvelteMap
 * through a function call. Instead, read directly from
 * deletionStates.value.get(path) in $derived().
 *
 * @param workspacePath - Path to the workspace
 * @returns "none" if not deleting, "in-progress" if deletion is ongoing, "error" if deletion failed
 */
export function getDeletionStatus(workspacePath: string): DeletionStatus {
  const state = _deletionStates.get(workspacePath);
  if (!state) {
    return "none";
  }
  if (state.completed && state.hasErrors) {
    return "error";
  }
  // State exists but not completed with errors = in progress
  return "in-progress";
}

/**
 * Get the deletion state for a workspace.
 *
 * WARNING: Do not use this function inside $derived() expressions.
 * Svelte 5 may not properly track reactivity when reading from a SvelteMap
 * through a function call. Instead, read directly from
 * deletionStates.value.get(path) in $derived().
 *
 * @param workspacePath - Path to the workspace
 * @returns Deletion progress or undefined if not deleting
 */
export function getDeletionState(workspacePath: string): DeletionProgress | undefined {
  return _deletionStates.get(workspacePath);
}

/**
 * Reactive getter for all deletion states.
 */
export const deletionStates = {
  get value(): ReadonlyMap<string, DeletionProgress> {
    return _deletionStates;
  },
};

/**
 * Reset store to initial state. Used for testing.
 */
export function reset(): void {
  _deletionStates.clear();
}
