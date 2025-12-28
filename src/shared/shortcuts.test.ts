/**
 * Tests for the shortcuts type guards and helpers.
 */

import { describe, it, expect } from "vitest";
import {
  isNavigationKey,
  isJumpKey,
  isDialogKey,
  isProjectKey,
  isActionKey,
  jumpKeyToIndex,
  isShortcutKey,
  SHORTCUT_KEYS,
  type NavigationKey,
  type JumpKey,
  type DialogKey,
  type ShortcutKey,
} from "./shortcuts";

describe("shortcuts type guards", () => {
  describe("isNavigationKey", () => {
    it("should-recognize-arrow-up-as-navigation-key", () => {
      expect(isNavigationKey("ArrowUp")).toBe(true);
    });

    it("should-recognize-arrow-down-as-navigation-key", () => {
      expect(isNavigationKey("ArrowDown")).toBe(true);
    });

    it("should reject other arrow keys as navigation keys", () => {
      expect(isNavigationKey("ArrowLeft")).toBe(false);
      expect(isNavigationKey("ArrowRight")).toBe(false);
    });

    it("should reject non-arrow keys", () => {
      expect(isNavigationKey("Up")).toBe(false);
      expect(isNavigationKey("Down")).toBe(false);
      expect(isNavigationKey("w")).toBe(false);
      expect(isNavigationKey("s")).toBe(false);
    });
  });

  describe("isJumpKey", () => {
    it("should-recognize-digits-0-9-as-jump-keys", () => {
      const digits = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
      digits.forEach((digit) => {
        expect(isJumpKey(digit)).toBe(true);
      });
    });

    it("should reject non-digit keys", () => {
      expect(isJumpKey("a")).toBe(false);
      expect(isJumpKey("10")).toBe(false);
      expect(isJumpKey("")).toBe(false);
      expect(isJumpKey("Digit1")).toBe(false);
    });
  });

  describe("isDialogKey", () => {
    it("should-recognize-enter-delete-backspace-as-dialog-keys", () => {
      expect(isDialogKey("Enter")).toBe(true);
      expect(isDialogKey("Delete")).toBe(true);
      expect(isDialogKey("Backspace")).toBe(true);
    });

    it("should reject other keys", () => {
      expect(isDialogKey("Return")).toBe(false);
      expect(isDialogKey("Del")).toBe(false);
      expect(isDialogKey("Escape")).toBe(false);
    });
  });

  describe("isProjectKey", () => {
    it("should-recognize-o-O-as-project-keys", () => {
      expect(isProjectKey("o")).toBe(true);
      expect(isProjectKey("O")).toBe(true);
    });

    it("should reject other keys", () => {
      expect(isProjectKey("p")).toBe(false);
      expect(isProjectKey("Open")).toBe(false);
      expect(isProjectKey("0")).toBe(false);
    });
  });

  describe("isActionKey", () => {
    it("should-recognize-all-action-keys", () => {
      // Navigation keys
      expect(isActionKey("ArrowUp")).toBe(true);
      expect(isActionKey("ArrowDown")).toBe(true);

      // Jump keys
      expect(isActionKey("0")).toBe(true);
      expect(isActionKey("5")).toBe(true);
      expect(isActionKey("9")).toBe(true);

      // Dialog keys
      expect(isActionKey("Enter")).toBe(true);
      expect(isActionKey("Delete")).toBe(true);
      expect(isActionKey("Backspace")).toBe(true);

      // Project keys
      expect(isActionKey("o")).toBe(true);
      expect(isActionKey("O")).toBe(true);
    });

    it("should-reject-non-action-keys", () => {
      expect(isActionKey("a")).toBe(false);
      expect(isActionKey("z")).toBe(false);
      expect(isActionKey("Escape")).toBe(false);
      expect(isActionKey("Alt")).toBe(false);
      expect(isActionKey("Control")).toBe(false);
      expect(isActionKey(" ")).toBe(false);
      expect(isActionKey("Tab")).toBe(false);
    });
  });

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

  describe("type inference", () => {
    it("should narrow types correctly with type guards", () => {
      const key = "ArrowUp";
      if (isNavigationKey(key)) {
        // TypeScript should infer key as NavigationKey here
        const navKey: NavigationKey = key;
        expect(navKey).toBe("ArrowUp");
      }

      const jumpKey = "5";
      if (isJumpKey(jumpKey)) {
        const j: JumpKey = jumpKey;
        expect(j).toBe("5");
      }

      const dialogKey = "Enter";
      if (isDialogKey(dialogKey)) {
        const d: DialogKey = dialogKey;
        expect(d).toBe("Enter");
      }

      const projectKey = "o";
      if (isProjectKey(projectKey)) {
        // Type narrowed to "o" | "O" by the type guard
        expect(projectKey).toBe("o");
      }
    });
  });

  // ============ Stage 2: ShortcutKey type for main→renderer events ============

  describe("SHORTCUT_KEYS", () => {
    it("contains all normalized shortcut keys", () => {
      // All valid shortcut keys as normalized values
      const expectedKeys = [
        "up",
        "down",
        "enter",
        "delete",
        "o",
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
      "enter",
      "delete",
      "o",
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
