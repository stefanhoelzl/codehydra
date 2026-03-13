/**
 * Central UI Mode Store
 *
 * This store is the ONLY place that calls api.ui.setMode().
 * No component should ever call this API directly - they should only update store inputs.
 *
 * Inputs (from different sources):
 * - modeFromMain: UIMode (from IPC events, via shortcuts store handleModeChange)
 * - dialogOpen: boolean (from dialog state in MainView)
 * - sidebarExpanded: boolean (from hover state in Sidebar)
 *
 * Output:
 * - desiredMode: derived from inputs, synced to main process via syncMode()
 *
 * Usage:
 * - Components update inputs via setModeFromMain(), setDialogOpen(), setSidebarExpanded()
 * - App.svelte calls syncMode() in an $effect to sync with main process
 *
 * Priority: shortcut > dialog > hover > workspace
 */

import * as api from "$lib/api";
import type { UIMode } from "@shared/ipc";

// ============ State (inputs from different sources) ============

let _modeFromMain = $state<UIMode>("workspace");
let _dialogOpen = $state(false);
let _sidebarExpanded = $state(false);

// Track last emitted mode to prevent duplicate IPC calls
let _lastEmittedMode: UIMode | null = null;

// ============ Pure function for mode derivation (testable) ============

/**
 * Compute desired UI mode from inputs.
 * Priority: shortcut > dialog > hover > workspace
 *
 * - "shortcut": Shortcut mode active (from main process)
 * - "dialog": Modal dialog open (blocks Alt+X)
 * - "hover": Sidebar expanded on hover (allows Alt+X)
 * - "workspace": Normal editing mode
 */
export function computeDesiredMode(
  modeFromMain: UIMode,
  dialogOpen: boolean,
  sidebarExpanded: boolean
): UIMode {
  if (modeFromMain === "shortcut") return "shortcut";
  if (dialogOpen) return "dialog";
  if (sidebarExpanded) return "hover";
  return "workspace";
}

// ============ Derived State ============

const _desiredMode = $derived(computeDesiredMode(_modeFromMain, _dialogOpen, _sidebarExpanded));

// ============ Getters (follow store pattern) ============

/**
 * Current UI mode from main process.
 * - "workspace": Normal mode, workspace view has focus
 * - "shortcut": Shortcut mode active, UI on top
 * - "dialog": Dialog open, UI on top
 */
export const uiMode = {
  get value(): UIMode {
    return _modeFromMain;
  },
};

/**
 * Desired mode computed from all inputs.
 * This is what gets synced to the main process.
 */
export const desiredMode = {
  get value(): UIMode {
    return _desiredMode;
  },
};

/**
 * Whether shortcut mode is active. Derived from modeFromMain.
 */
export const shortcutModeActive = {
  get value(): boolean {
    return _modeFromMain === "shortcut";
  },
};

// ============ Setters ============

/**
 * Called when main process sends ui:mode-changed event.
 * This is the only way modeFromMain should be updated.
 */
export function setModeFromMain(mode: UIMode): void {
  _modeFromMain = mode;
  _lastEmittedMode = mode; // Prevent echoing back what main just told us
}

/**
 * Called by MainView when dialog state changes.
 */
export function setDialogOpen(open: boolean): void {
  _dialogOpen = open;
}

/**
 * Called by Sidebar when hover state changes.
 */
export function setSidebarExpanded(expanded: boolean): void {
  _sidebarExpanded = expanded;
}

// ============ Sync function for IPC ============

/**
 * Sync the desired mode with the main process.
 * Uses deduplication to prevent redundant IPC calls.
 *
 * This is the ONLY function that calls api.ui.setMode().
 *
 * ## Architecture Decision: External Sync vs Module-Level $effect
 *
 * This function is exported and called from MainView's `$effect` rather than using
 * a module-level `$effect` directly in this store. This is intentional:
 *
 * 1. **Lifecycle Management**: Svelte 5 module-level `$effect` blocks have different
 *    lifecycle semantics than component-level effects. Module-level effects run when
 *    the module is first imported and persist for the application lifetime, but they
 *    don't have component-level cleanup guarantees.
 *
 * 2. **Reactivity Tracking**: By calling `syncMode()` from within MainView's `$effect`,
 *    we ensure the reactivity tracking happens in a proper component context. This
 *    guarantees the effect runs with correct Svelte runtime context.
 *
 * 3. **Testing**: Having sync as an explicit function call makes it easier to test
 *    the mode derivation logic separately from the IPC side effects.
 *
 * 4. **Cleanup**: Component-level effects are automatically cleaned up when the
 *    component unmounts, which aligns with application shutdown semantics.
 */
export function syncMode(): void {
  const desired = _desiredMode;
  if (desired !== _lastEmittedMode) {
    _lastEmittedMode = desired;
    void api.ui.setMode(desired);
  }
}

// ============ Testing ============

/**
 * Reset store to initial state. Used for testing.
 */
export function reset(): void {
  _modeFromMain = "workspace";
  _dialogOpen = false;
  _sidebarExpanded = false;
  _lastEmittedMode = null;
}
