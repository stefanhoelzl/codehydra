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
 * Check if a workspace is currently being deleted.
 * @param workspacePath - Path to the workspace
 * @returns True if deletion is in progress for this workspace
 */
export function isDeleting(workspacePath: string): boolean {
  return _deletionStates.has(workspacePath);
}

/**
 * Get the deletion state for a workspace.
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
