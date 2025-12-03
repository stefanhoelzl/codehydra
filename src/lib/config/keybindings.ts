/**
 * Central configuration for all codehydra keyboard shortcuts.
 *
 * Activation: Alt+X - captured via Tauri global shortcut
 * Actions: Alt+{ActionKey} - captured via Tauri global shortcuts, only handled when active
 *
 * All shortcuts are registered at the OS level via Tauri. The frontend listens
 * for Tauri events and handles them based on the current shortcut mode state.
 */

// Activation shortcut display
export const CHIME_ACTIVATION = {
  display: 'Alt+X', // Display format for UI
} as const;

// Shortcut labels for the overlay (shown while in shortcut mode)
// Note: Actual key handling is done via Tauri events, not frontend key matching
export const CHIME_SHORTCUTS = {
  // Navigation
  navigateUp: {
    label: '\u2191\u2193',
    description: 'Navigate',
  },
  navigateDown: {
    label: '\u2191\u2193',
    description: 'Navigate',
  },

  // Workspace actions
  createWorkspace: {
    label: '\u23CE',
    description: 'New',
  },
  removeWorkspace: {
    label: '\u232B',
    description: 'Del',
  },

  // Quick jump (1-9, 0 for 10th)
  jumpToWorkspace: {
    label: '1-0',
    description: 'Jump',
  },
} as const;

// Dialog shortcuts (no modifier needed, handled in frontend)
export const DIALOG_SHORTCUTS = {
  confirm: {
    key: 'Enter',
    label: '\u23CE',
    description: 'OK',
  },
  cancel: {
    key: 'Escape',
    label: 'Esc',
    description: 'Cancel',
  },
} as const;

// Helper: Get display key for workspace index (1-9, 10 -> 0)
export function getDisplayKeyForIndex(index: number): string | null {
  if (index >= 1 && index <= 9) return String(index);
  if (index === 10) return '0';
  return null;
}
