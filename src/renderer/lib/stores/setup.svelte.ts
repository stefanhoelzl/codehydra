/**
 * Setup state management store using Svelte 5 runes.
 * Manages the VS Code first-run setup flow state.
 */

// ============ Types ============

/** Discriminated union for setup state */
export type SetupStateValue =
  | { type: "loading" }
  | { type: "progress"; message: string }
  | { type: "complete" }
  | { type: "error"; errorMessage: string };

// ============ State ============

let _setupState = $state<SetupStateValue>({ type: "loading" });

// ============ Getters ============

export const setupState = {
  get value(): SetupStateValue {
    return _setupState;
  },
};

// ============ Actions ============

/**
 * Update progress with a new message.
 * Transitions from loading or error to progress state.
 * @param message - The progress message to display
 */
export function updateProgress(message: string): void {
  _setupState = { type: "progress", message };
}

/**
 * Mark setup as complete.
 * Transitions to complete state.
 */
export function completeSetup(): void {
  _setupState = { type: "complete" };
}

/**
 * Mark setup as failed with an error message.
 * Transitions to error state.
 * @param errorMessage - The error message to display
 */
export function errorSetup(errorMessage: string): void {
  _setupState = { type: "error", errorMessage };
}

/**
 * Reset setup state to initial loading state.
 * Used for testing and retry scenarios.
 */
export function resetSetup(): void {
  _setupState = { type: "loading" };
}
