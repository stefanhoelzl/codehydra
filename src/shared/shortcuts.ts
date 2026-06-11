/**
 * Shortcut key type guards and helpers.
 * Shared between main and renderer processes.
 */

// ============ Types ============

/** Jump keys for direct workspace access (1-9, 0 for 10th). */
export type JumpKey = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";

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
  "h",
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
