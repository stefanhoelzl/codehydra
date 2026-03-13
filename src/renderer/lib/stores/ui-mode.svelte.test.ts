/**
 * Tests for the ui-mode store.
 * Central store that manages UI mode state and syncs with main process.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { flushSync } from "svelte";

// Create mock API with vi.hoisted for proper hoisting
const mockApi = vi.hoisted(() => ({
  ui: {
    setMode: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock the API module before any imports use it
vi.mock("$lib/api", () => mockApi);

// Import after mock setup
import {
  uiMode,
  desiredMode,
  shortcutModeActive,
  setModeFromMain,
  setDialogOpen,
  setSidebarExpanded,
  computeDesiredMode,
  syncMode,
  reset,
} from "./ui-mode.svelte";

describe("ui-mode store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reset();
  });

  afterEach(() => {
    reset();
  });

  describe("initial state", () => {
    it("initial state is workspace mode", () => {
      expect(uiMode.value).toBe("workspace");
      expect(desiredMode.value).toBe("workspace");
      expect(shortcutModeActive.value).toBe(false);
    });
  });

  describe("computeDesiredMode pure function", () => {
    // Parameterized tests for all mode priority combinations
    describe("mode priority: shortcut > dialog > hover > workspace", () => {
      it.each([
        // Base cases
        ["shortcut", false, false, "shortcut"],
        ["workspace", true, false, "dialog"],
        ["workspace", false, true, "hover"],
        ["workspace", false, false, "workspace"],
        // Priority: shortcut > all
        ["shortcut", true, true, "shortcut"],
        ["shortcut", true, false, "shortcut"],
        ["shortcut", false, true, "shortcut"],
        // Priority: dialog > hover
        ["workspace", true, true, "dialog"],
        // modeFromMain non-shortcut values don't affect result (only shortcut takes priority)
        ["dialog", false, false, "workspace"],
        ["hover", false, false, "workspace"],
        ["dialog", true, false, "dialog"],
        ["hover", false, true, "hover"],
      ] as const)(
        "computeDesiredMode(%s, %s, %s) returns %s",
        (modeFromMain, dialogOpen, sidebarExpanded, expected) => {
          expect(computeDesiredMode(modeFromMain, dialogOpen, sidebarExpanded)).toBe(expected);
        }
      );
    });

    // Named individual tests for clarity
    it("returns 'shortcut' when modeFromMain is shortcut", () => {
      expect(computeDesiredMode("shortcut", false, false)).toBe("shortcut");
    });

    it("returns 'dialog' when dialogOpen is true", () => {
      expect(computeDesiredMode("workspace", true, false)).toBe("dialog");
    });

    it("returns 'hover' when sidebarExpanded is true and dialogOpen is false", () => {
      expect(computeDesiredMode("workspace", false, true)).toBe("hover");
    });

    it("returns 'workspace' when all flags are false", () => {
      expect(computeDesiredMode("workspace", false, false)).toBe("workspace");
    });

    it("returns 'dialog' when both dialogOpen AND sidebarExpanded are true (priority test)", () => {
      expect(computeDesiredMode("workspace", true, true)).toBe("dialog");
    });

    it("returns 'shortcut' when shortcut AND dialog AND hover flags all true (priority test)", () => {
      expect(computeDesiredMode("shortcut", true, true)).toBe("shortcut");
    });
  });

  describe("derived state from setters", () => {
    it("setModeFromMain updates uiMode and shortcutModeActive", () => {
      setModeFromMain("shortcut");
      flushSync();

      expect(uiMode.value).toBe("shortcut");
      expect(shortcutModeActive.value).toBe(true);
    });

    it("setDialogOpen(true) changes desiredMode to 'dialog'", () => {
      setDialogOpen(true);
      flushSync();

      expect(desiredMode.value).toBe("dialog");
    });

    it("setSidebarExpanded(true) changes desiredMode to 'hover'", () => {
      setSidebarExpanded(true);
      flushSync();

      expect(desiredMode.value).toBe("hover");
    });

    it("modeFromMain transition from shortcut to workspace respects dialogOpen", () => {
      // Start in shortcut mode with dialog open
      setModeFromMain("shortcut");
      setDialogOpen(true);
      flushSync();

      // desiredMode is shortcut (shortcut takes priority)
      expect(desiredMode.value).toBe("shortcut");

      // Transition to workspace from main
      setModeFromMain("workspace");
      flushSync();

      // desiredMode should be dialog since dialogOpen is still true
      expect(desiredMode.value).toBe("dialog");
    });
  });

  describe("syncMode IPC calls", () => {
    it("syncMode calls api.ui.setMode when desiredMode changes", () => {
      // Initial sync with workspace
      syncMode();
      expect(mockApi.ui.setMode).toHaveBeenCalledWith("workspace");
      mockApi.ui.setMode.mockClear();

      // Change to dialog
      setDialogOpen(true);
      flushSync();
      syncMode();

      expect(mockApi.ui.setMode).toHaveBeenCalledWith("dialog");
    });

    it("syncMode does NOT call api.ui.setMode when desiredMode stays same", () => {
      // Set sidebarExpanded - desiredMode is "hover"
      setSidebarExpanded(true);
      flushSync();
      syncMode();

      expect(mockApi.ui.setMode).toHaveBeenCalledWith("hover");
      mockApi.ui.setMode.mockClear();

      // Calling syncMode again without change - desiredMode still "hover"
      syncMode();

      // Should NOT have called setMode again (deduplication)
      expect(mockApi.ui.setMode).not.toHaveBeenCalled();
    });

    it("syncMode transitions from hover to dialog when dialog opens", () => {
      // Set sidebarExpanded - desiredMode is "hover"
      setSidebarExpanded(true);
      flushSync();
      syncMode();

      expect(mockApi.ui.setMode).toHaveBeenCalledWith("hover");
      mockApi.ui.setMode.mockClear();

      // Open dialog while sidebar is expanded - desiredMode becomes "dialog" (dialog > hover)
      setDialogOpen(true);
      flushSync();
      syncMode();

      expect(mockApi.ui.setMode).toHaveBeenCalledWith("dialog");
    });

    it("syncMode passes correct mode value to api.ui.setMode", () => {
      // Initial workspace
      syncMode();
      expect(mockApi.ui.setMode).toHaveBeenCalledWith("workspace");
      mockApi.ui.setMode.mockClear();

      // Test workspace -> dialog
      setDialogOpen(true);
      flushSync();
      syncMode();
      expect(mockApi.ui.setMode).toHaveBeenCalledWith("dialog");
      mockApi.ui.setMode.mockClear();

      // Test dialog -> workspace
      setDialogOpen(false);
      flushSync();
      syncMode();
      expect(mockApi.ui.setMode).toHaveBeenCalledWith("workspace");
    });
  });

  describe("setModeFromMain echo prevention", () => {
    it("setModeFromMain prevents syncMode from echoing same mode back", () => {
      // Initial sync
      syncMode();
      mockApi.ui.setMode.mockClear();

      // Main tells us mode is "shortcut"
      setModeFromMain("shortcut");
      flushSync();

      // syncMode should NOT echo "shortcut" back — main already knows
      syncMode();
      expect(mockApi.ui.setMode).not.toHaveBeenCalled();
    });

    it("after setModeFromMain, syncMode still sends when desiredMode differs", () => {
      // Initial sync
      syncMode();
      mockApi.ui.setMode.mockClear();

      // Main tells us mode is "workspace", but sidebar is expanded so desired is "hover"
      setSidebarExpanded(true);
      setModeFromMain("workspace");
      flushSync();

      syncMode();
      expect(mockApi.ui.setMode).toHaveBeenCalledWith("hover");
    });
  });

  describe("reset function", () => {
    it("reset() restores initial state", () => {
      // Change state
      setModeFromMain("shortcut");
      setDialogOpen(true);
      setSidebarExpanded(true);
      flushSync();

      // Verify changed
      expect(uiMode.value).toBe("shortcut");

      // Reset
      reset();
      flushSync();

      // Verify restored to initial
      expect(uiMode.value).toBe("workspace");
      expect(desiredMode.value).toBe("workspace");
      expect(shortcutModeActive.value).toBe(false);
    });
  });
});
