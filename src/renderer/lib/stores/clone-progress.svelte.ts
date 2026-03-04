/**
 * Clone progress state store using Svelte 5 runes.
 * Manages multiple concurrent background clone operations keyed by URL.
 * This is a pure state container - IPC subscriptions are handled externally.
 */

import { SvelteMap } from "svelte/reactivity";

// ============ Types ============

export interface CloneState {
  readonly url: string;
  readonly name: string;
  readonly stage: string | null;
  readonly progress: number; // 0-1 float
}

// ============ State ============

const _clones = new SvelteMap<string, CloneState>();

// ============ Actions ============

/**
 * Initialize a new clone operation.
 * @param url - The git URL being cloned
 */
export function startClone(url: string): void {
  _clones.set(url, { url, name: "", stage: null, progress: 0 });
}

/**
 * Update clone progress from an IPC event.
 * No-op if the URL is not tracked.
 * @param url - The git URL being cloned
 * @param stage - Git operation stage
 * @param progress - Progress as 0-1 float
 * @param name - Repository name
 */
export function updateCloneProgress(
  url: string,
  stage: string,
  progress: number,
  name: string
): void {
  if (!_clones.has(url)) return;
  _clones.set(url, { url, stage, progress, name });
}

/**
 * Remove a clone entry (success or failure).
 * @param url - The git URL to remove
 */
export function completeClone(url: string): void {
  _clones.delete(url);
}

/**
 * Format a git stage name for display.
 */
export function stageLabel(stage: string): string {
  switch (stage) {
    case "receiving":
      return "Receiving objects...";
    case "resolving":
      return "Resolving deltas...";
    case "counting":
      return "Counting objects...";
    case "compressing":
      return "Compressing objects...";
    default:
      return stage.charAt(0).toUpperCase() + stage.slice(1) + "...";
  }
}

// ============ Reactive Getters ============

/**
 * Get clone state for a specific URL.
 */
export function getClone(url: string): CloneState | undefined {
  return _clones.get(url);
}

/**
 * Reactive getter for all active clones as an array.
 */
export const activeClones = {
  get value(): readonly CloneState[] {
    return Array.from(_clones.values());
  },
};

/**
 * Reactive getter for whether any clones are active.
 */
export const hasActiveClones = {
  get value(): boolean {
    return _clones.size > 0;
  },
};

/**
 * Reset store to initial state. Used for testing.
 */
export function reset(): void {
  _clones.clear();
}
