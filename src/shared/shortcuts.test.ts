/**
 * Tests for the shortcuts type guards and helpers.
 */

import { describe, it, expect } from "vitest";
import {
  jumpKeyToIndex,
  isShortcutKey,
  SHORTCUT_KEYS,
  type JumpKey,
  type ShortcutKey,
} from "./shortcuts";

describe("shortcuts type guards", () => {
  describe("jumpKeyToIndex", () => {
    it("should convert keys 1-9 to indices 0-8", () => {
      expect(jumpKeyToIndex("1" as JumpKey)).toBe(0);
      expect(jumpKeyToIndex("2" as JumpKey)).toBe(1);
      expect(jumpKeyToIndex("3" as JumpKey)).toBe(2);
      expect(jumpKeyToIndex("4" as JumpKey)).toBe(3);
      expect(jumpKeyToIndex("5" as JumpKey)).toBe(4);
      expect(jumpKeyToIndex("6" as JumpKey)).toBe(5);
      expect(jumpKeyToIndex("7" as JumpKey)).toBe(6);
      expect(jumpKeyToIndex("8" as JumpKey)).toBe(7);
      expect(jumpKeyToIndex("9" as JumpKey)).toBe(8);
    });

    it("should convert key 0 to index 9 (10th workspace)", () => {
      expect(jumpKeyToIndex("0" as JumpKey)).toBe(9);
    });
  });

  // ============ Stage 2: ShortcutKey type for main→renderer events ============

  describe("SHORTCUT_KEYS", () => {
    it("contains all normalized shortcut keys", () => {
      // All valid shortcut keys as normalized values
      const expectedKeys = [
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
      ];
      expect(SHORTCUT_KEYS).toEqual(expectedKeys);
    });
  });

  describe("isShortcutKey", () => {
    it.each([
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
    ])('returns true for valid shortcut key "%s"', (key) => {
      expect(isShortcutKey(key)).toBe(true);
    });

    it.each([
      "invalid",
      "ArrowUp", // raw Electron key, not normalized
      "ArrowDown",
      "Enter", // raw Electron key
      "Delete",
      "Backspace",
      "o", // "o" key removed
      "O", // uppercase
      "U", // not a shortcut key
      "escape", // Escape is handled by renderer, not main process
      "",
    ])('returns false for invalid shortcut key "%s"', (key) => {
      expect(isShortcutKey(key)).toBe(false);
    });

    it("narrows type correctly", () => {
      const key = "up";
      if (isShortcutKey(key)) {
        // TypeScript should infer key as ShortcutKey here
        const shortcutKey: ShortcutKey = key;
        expect(shortcutKey).toBe("up");
      }
    });
  });
});
