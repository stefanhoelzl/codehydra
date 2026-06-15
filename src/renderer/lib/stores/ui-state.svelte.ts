/**
 * UI state holder: the latest UiState snapshot pushed by the main process on
 * api:ui:state. The renderer is a render function over this value — it never
 * mutates it, and replaces it wholesale on every push ($state.raw: snapshots
 * are immutable, so no deep reactivity is needed).
 *
 * Module-level (not component state) so the shortcuts store can read it from
 * plain functions — transitional until shortcut handling moves to main.
 * Null until the genesis push arrives (subscription is wired in
 * initializeApp, before the `ui-connected` event is emitted).
 */

import type { UiState } from "@shared/ui-state";

let _ui = $state.raw<UiState | null>(null);

export const uiState = {
  get value(): UiState | null {
    return _ui;
  },
};

export function setUiState(next: UiState): void {
  _ui = next;
}

/** Reset to pre-genesis state. Used for testing. */
export function resetUiState(): void {
  _ui = null;
}
