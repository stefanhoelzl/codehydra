/**
 * Shortcut key type guards and helpers.
 * Shared between main and renderer processes.
 */

// ============ Key Constants ============

/** Navigation keys for workspace traversal. */
const NAVIGATION_KEYS = ["ArrowUp", "ArrowDown"] as const;

/** Jump keys for direct workspace access (1-9, 0 for 10th). */
const JUMP_KEYS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

/** Dialog keys for opening create/remove dialogs. */
const DIALOG_KEYS = ["Enter", "Delete", "Backspace"] as const;

/** Project keys for opening folder picker. */
const PROJECT_KEYS = ["o", "O"] as const;

// ============ Types ============

export type NavigationKey = (typeof NAVIGATION_KEYS)[number];
export type JumpKey = (typeof JUMP_KEYS)[number];
export type DialogKey = (typeof DIALOG_KEYS)[number];
export type ProjectKey = (typeof PROJECT_KEYS)[number];
export type ActionKey = NavigationKey | JumpKey | DialogKey | ProjectKey;

// ============ Type Guards ============

/**
 * Type guard for navigation keys (ArrowUp, ArrowDown).
 */
export function isNavigationKey(key: string): key is NavigationKey {
  return (NAVIGATION_KEYS as readonly string[]).includes(key);
}

/**
 * Type guard for jump keys (0-9).
 */
export function isJumpKey(key: string): key is JumpKey {
  return (JUMP_KEYS as readonly string[]).includes(key);
}

/**
 * Type guard for dialog keys (Enter, Delete, Backspace).
 */
export function isDialogKey(key: string): key is DialogKey {
  return (DIALOG_KEYS as readonly string[]).includes(key);
}

/**
 * Type guard for project keys (o, O).
 */
export function isProjectKey(key: string): key is ProjectKey {
  return (PROJECT_KEYS as readonly string[]).includes(key);
}

/**
 * Type guard for any action key.
 */
export function isActionKey(key: string): key is ActionKey {
  return isNavigationKey(key) || isJumpKey(key) || isDialogKey(key) || isProjectKey(key);
}

// ============ Helpers ============

/**
 * Convert jump key to 0-based workspace index.
 * Keys 1-9 map to indices 0-8, key 0 maps to index 9.
 */
export function jumpKeyToIndex(key: JumpKey): number {
  return key === "0" ? 9 : parseInt(key, 10) - 1;
}
