/**
 * Clone progress state store using Svelte 5 runes.
 * Manages the active background clone state (only one clone at a time).
 * This is a pure state container - IPC subscriptions are handled externally.
 */

// ============ Types ============

export interface CloneState {
  readonly url: string;
  readonly name: string;
  readonly stage: string | null;
  readonly progress: number; // 0-1 float
}

// ============ State ============

let _cloneState = $state<CloneState | null>(null);

// ============ Actions ============

/**
 * Initialize a new clone operation.
 * @param url - The git URL being cloned
 */
export function startClone(url: string): void {
  _cloneState = { url, name: "", stage: null, progress: 0 };
}

/**
 * Update clone progress from an IPC event.
 * @param stage - Git operation stage
 * @param progress - Progress as 0-1 float
 * @param name - Repository name
 */
export function updateCloneProgress(stage: string, progress: number, name: string): void {
  if (!_cloneState) return;
  _cloneState = { ..._cloneState, stage, progress, name };
}

/**
 * Clear the clone state (success or failure).
 */
export function completeClone(): void {
  _cloneState = null;
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

// ============ Reactive Getter ============

/**
 * Reactive getter for clone state.
 */
export const cloneState = {
  get value(): CloneState | null {
    return _cloneState;
  },
};

/**
 * Reset store to initial state. Used for testing.
 */
export function reset(): void {
  _cloneState = null;
}
