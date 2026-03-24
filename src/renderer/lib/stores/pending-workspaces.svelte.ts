/**
 * Pending workspaces store using Svelte 5 runes.
 * Tracks placeholder workspaces that are being created but haven't received
 * their workspace:created event yet. Used for optimistic sidebar rendering.
 * This is a pure state container.
 */

import { SvelteMap } from "svelte/reactivity";

// ============ Types ============

interface PendingEntry {
  readonly projectPath: string;
  readonly name: string;
}

// ============ State ============

const _pending = new SvelteMap<string, PendingEntry>();

// ============ Helpers ============

/**
 * Generate a synthetic path for a pending workspace.
 * This path is used as a temporary identifier until the real path is known.
 */
export function createPendingPath(projectPath: string, name: string): string {
  return `__pending__/${projectPath}/${name}`;
}

// ============ Actions ============

/**
 * Register a workspace as pending.
 * @param path - Synthetic pending path (from createPendingPath)
 * @param projectPath - Project path
 * @param name - Workspace name
 */
export function addPending(path: string, projectPath: string, name: string): void {
  _pending.set(path, { projectPath, name });
}

/**
 * Remove a pending workspace.
 * @param path - Synthetic pending path
 */
export function removePending(path: string): void {
  _pending.delete(path);
}

/**
 * Check if a workspace path is a pending placeholder.
 */
export function isPending(path: string): boolean {
  return _pending.has(path);
}

/**
 * Find the pending path for a workspace by project path and name.
 * Used to locate the placeholder when the real workspace:created event arrives.
 * @returns The synthetic pending path, or null if not found.
 */
export function findPendingByName(projectPath: string, name: string): string | null {
  for (const [path, entry] of _pending) {
    if (entry.projectPath === projectPath && entry.name === name) {
      return path;
    }
  }
  return null;
}

/**
 * Reset store to initial state. Used for testing.
 */
export function reset(): void {
  _pending.clear();
}
