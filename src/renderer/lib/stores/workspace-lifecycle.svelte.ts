/**
 * Workspace lifecycle store using Svelte 5 runes.
 * Tracks transient lifecycle states the backend doesn't model as part of the
 * Workspace object: optimistic "creating" placeholders (synthetic paths until
 * the workspace:created event reconciles them by name) and deletion progress.
 * This is a pure state container - IPC subscriptions are handled externally.
 */

import { SvelteMap } from "svelte/reactivity";
import type { DeletionProgress } from "@shared/api/types";

// ============ Types ============

/**
 * Lifecycle status of a workspace for UI rendering.
 */
export type WorkspaceLifecycle = "none" | "creating" | "deleting" | "delete-failed";

/**
 * Internal lifecycle entry, keyed by workspace path.
 * Creating entries are keyed by their synthetic pending path;
 * deleting entries by the real workspace path (no collision possible).
 */
export type LifecycleEntry =
  | { readonly kind: "creating"; readonly projectPath: string; readonly name: string }
  | { readonly kind: "deleting"; readonly progress: DeletionProgress };

// ============ State ============

const _entries = new SvelteMap<string, LifecycleEntry>();

// ============ Helpers ============

/**
 * Generate a synthetic path for a workspace that is being created.
 * This path is used as a temporary identifier until the real path is known.
 */
export function createPendingPath(projectPath: string, name: string): string {
  return `__pending__/${projectPath}/${name}`;
}

// ============ Actions ============

/**
 * Register a workspace as being created (optimistic placeholder).
 * @param path - Synthetic pending path (from createPendingPath)
 * @param projectPath - Project path
 * @param name - Workspace name
 */
export function setCreating(path: string, projectPath: string, name: string): void {
  _entries.set(path, { kind: "creating", projectPath, name });
}

/**
 * Set the deletion progress for a workspace (keyed by its real path).
 * @param progress - Full deletion progress state
 */
export function setDeletionProgress(progress: DeletionProgress): void {
  _entries.set(progress.workspacePath, { kind: "deleting", progress });
}

/**
 * Clear the lifecycle state for a workspace (creating or deleting).
 * @param path - Workspace path (synthetic pending path or real path)
 */
export function clearLifecycle(path: string): void {
  _entries.delete(path);
}

/**
 * Get the lifecycle status for a workspace.
 * Returns a discriminated status for cleaner UI conditionals.
 *
 * WARNING: Do not use this function inside $derived() expressions.
 * Svelte 5 may not properly track reactivity when reading from a SvelteMap
 * through a function call. Instead, read directly from
 * lifecycleEntries.value.get(path) in $derived().
 *
 * @param path - Workspace path
 */
export function getLifecycle(path: string): WorkspaceLifecycle {
  const entry = _entries.get(path);
  if (!entry) {
    return "none";
  }
  if (entry.kind === "creating") {
    return "creating";
  }
  if (entry.progress.completed && entry.progress.hasErrors) {
    return "delete-failed";
  }
  // Deletion entry exists but not completed with errors = in progress
  return "deleting";
}

/**
 * Find the pending path for a creating workspace by project path and name.
 * Used to locate the placeholder when the real workspace:created event arrives.
 * @returns The synthetic pending path, or null if not found.
 */
export function findCreatingByName(projectPath: string, name: string): string | null {
  for (const [path, entry] of _entries) {
    if (entry.kind === "creating" && entry.projectPath === projectPath && entry.name === name) {
      return path;
    }
  }
  return null;
}

/**
 * Reactive getter for all lifecycle entries.
 */
export const lifecycleEntries = {
  get value(): ReadonlyMap<string, LifecycleEntry> {
    return _entries;
  },
};

/**
 * Reset store to initial state. Used for testing.
 */
export function reset(): void {
  _entries.clear();
}
