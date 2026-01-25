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

// ============ Types ============

export type NavigationKey = (typeof NAVIGATION_KEYS)[number];
export type JumpKey = (typeof JUMP_KEYS)[number];
export type DialogKey = (typeof DIALOG_KEYS)[number];

// Internal types (not exported - only used by type guards)
type ActionKey = NavigationKey | JumpKey | DialogKey;

// ============ Type Guards (internal, exported for testing only) ============

/**
 * Type guard for navigation keys (ArrowUp, ArrowDown).
 * @internal Exported for testing only
 */
export function isNavigationKey(key: string): key is NavigationKey {
  return (NAVIGATION_KEYS as readonly string[]).includes(key);
}

/**
 * Type guard for jump keys (0-9).
 * @internal Exported for testing only
 */
export function isJumpKey(key: string): key is JumpKey {
  return (JUMP_KEYS as readonly string[]).includes(key);
}

/**
 * Type guard for dialog keys (Enter, Delete, Backspace).
 * @internal Exported for testing only
 */
export function isDialogKey(key: string): key is DialogKey {
  return (DIALOG_KEYS as readonly string[]).includes(key);
}

/**
 * Type guard for any action key.
 * @internal Exported for testing only
 */
export function isActionKey(key: string): key is ActionKey {
  return isNavigationKey(key) || isJumpKey(key) || isDialogKey(key);
}

// ============ Helpers ============

/**
 * Convert jump key to 0-based workspace index.
 * Keys 1-9 map to indices 0-8, key 0 maps to index 9.
 */
export function jumpKeyToIndex(key: JumpKey): number {
  return key === "0" ? 9 : parseInt(key, 10) - 1;
}

// ============ ShortcutKey (Normalized keys for main→renderer events) ============

/**
 * Normalized shortcut keys for main→renderer event communication.
 * These are the values emitted by main process after normalizing Electron key events.
 * NOTE: Escape is NOT included - it's handled by renderer directly (see Design Decisions).
 */
export const SHORTCUT_KEYS = [
  "up",
  "down",
  "left",
  "right",
  "enter",
  "delete",
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
] as const;

/** Normalized shortcut key type for main→renderer events. */
export type ShortcutKey = (typeof SHORTCUT_KEYS)[number];

/**
 * Type guard for normalized shortcut keys.
 * Used to validate keys received from main process events.
 */
export function isShortcutKey(key: string): key is ShortcutKey {
  return (SHORTCUT_KEYS as readonly string[]).includes(key);
}
