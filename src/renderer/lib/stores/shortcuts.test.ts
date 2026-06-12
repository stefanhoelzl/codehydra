/**
 * Tests for the shortcuts store.
 * Tests shortcut mode state and handlers.
 *
 * Since the read cutover the handlers read the UiState snapshot holder
 * (workspace rows in display order, agent status and lifecycle inline), so
 * the tests populate the holder with row fixtures instead of mocking stores.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Create mock API functions with vi.hoisted for proper hoisting
const mockApi = vi.hoisted(() => ({
  emitEvent: vi.fn(),
  ui: {
    switchWorkspace: vi.fn().mockResolvedValue(undefined),
    setMode: vi.fn().mockResolvedValue(undefined),
  },
  projects: {
    open: vi.fn().mockResolvedValue(undefined),
  },
  workspaces: {
    hibernate: vi.fn().mockResolvedValue(undefined),
    wake: vi.fn().mockResolvedValue(undefined),
  },
}));

// Create mock dialog state with vi.hoisted
const mockDialogState = vi.hoisted(() => ({
  dialogState: {
    value: { type: "closed" } as Record<string, unknown>,
  },
  openRemoveDialog: vi.fn(),
}));

// Mock the API module before any imports use it
vi.mock("$lib/api", () => mockApi);

// Mock the dialogs store
vi.mock("./dialogs.svelte", () => mockDialogState);

// Import after mock setup
import {
  handleModeChange,
  handleKeyDown,
  handleWindowBlur,
  handleShortcutKey,
  reset,
} from "./shortcuts.svelte";
import { shortcutModeActive, uiMode } from "./ui-mode.svelte";
import { setUiState, resetUiState } from "./ui-state.svelte";
import { makeUiState, makeUiProjectRow, makeUiWorkspaceRow } from "$lib/test-utils";
import type { UiWorkspaceRow } from "@shared/ui-state";

// Helper to enable shortcut mode via ui:mode-changed event
function enableShortcutMode(): void {
  handleModeChange({ mode: "shortcut", previousMode: "workspace" });
}

// Helper to disable shortcut mode via ui:mode-changed event
function disableShortcutMode(): void {
  handleModeChange({ mode: "workspace", previousMode: "shortcut" });
}

/** Row fixture with stable /wsN paths matching the original test data. */
function ws(name: string, overrides?: Partial<UiWorkspaceRow>): UiWorkspaceRow {
  return makeUiWorkspaceRow(name, {
    path: `/${name}`,
    key: `test-project-12345678/${name}`,
    ...overrides,
  });
}

/**
 * Populate the snapshot holder. The active row (if any) drives `main`
 * (workspace view); with no active row the creation panel is the main view
 * (ground state) — exactly what the presenter would produce.
 */
function setRows(rows: UiWorkspaceRow[], options?: { activePath?: string | null }): void {
  const activePath = options?.activePath ?? null;
  const marked = rows.map((row) => ({ ...row, active: row.path === activePath }));
  const activeRow = marked.find((row) => row.active);
  setUiState(
    makeUiState([makeUiProjectRow(marked)], {
      main: activeRow ? { kind: "workspace", frameKey: activeRow.key } : { kind: "creation" },
    })
  );
}

describe("shortcuts store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reset(); // Reset store state between tests
    resetUiState();
    // Reset dialog state to closed
    mockDialogState.dialogState.value = { type: "closed" };
  });

  describe("initial state", () => {
    it("should-have-inactive-state-initially: shortcutModeActive.value is false initially", () => {
      expect(shortcutModeActive.value).toBe(false);
    });

    it("should-have-workspace-uiMode-initially: uiMode.value is 'workspace' initially", () => {
      expect(uiMode.value).toBe("workspace");
    });
  });

  describe("uiMode", () => {
    it("uiMode tracks mode from handleModeChange event", () => {
      // Initially workspace
      expect(uiMode.value).toBe("workspace");

      // Change to shortcut
      handleModeChange({ mode: "shortcut", previousMode: "workspace" });
      expect(uiMode.value).toBe("shortcut");

      // Change to dialog
      handleModeChange({ mode: "dialog", previousMode: "shortcut" });
      expect(uiMode.value).toBe("dialog");

      // Change back to workspace
      handleModeChange({ mode: "workspace", previousMode: "dialog" });
      expect(uiMode.value).toBe("workspace");
    });

    it("shortcutModeActive derives correctly from uiMode", () => {
      // workspace mode
      handleModeChange({ mode: "workspace", previousMode: "workspace" });
      expect(shortcutModeActive.value).toBe(false);
      expect(uiMode.value).toBe("workspace");

      // shortcut mode
      handleModeChange({ mode: "shortcut", previousMode: "workspace" });
      expect(shortcutModeActive.value).toBe(true);
      expect(uiMode.value).toBe("shortcut");

      // dialog mode
      handleModeChange({ mode: "dialog", previousMode: "shortcut" });
      expect(shortcutModeActive.value).toBe(false);
      expect(uiMode.value).toBe("dialog");
    });
  });

  describe("handleModeChange", () => {
    it("should-enable-shortcut-mode-on-mode-change: handleModeChange with shortcut mode sets active to true", () => {
      enableShortcutMode();
      expect(shortcutModeActive.value).toBe(true);
    });

    it("should-disable-shortcut-mode-on-workspace-mode: handleModeChange with workspace mode sets active to false", () => {
      // First enable shortcut mode
      enableShortcutMode();
      expect(shortcutModeActive.value).toBe(true);

      disableShortcutMode();

      expect(shortcutModeActive.value).toBe(false);
    });

    it("should-set-inactive-for-dialog-mode: handleModeChange with dialog mode sets active to false", () => {
      // First enable shortcut mode
      enableShortcutMode();
      expect(shortcutModeActive.value).toBe(true);

      // Dialog mode from main process sets active to false
      handleModeChange({ mode: "dialog", previousMode: "shortcut" });

      expect(shortcutModeActive.value).toBe(false);
    });
  });

  describe("handleWindowBlur", () => {
    it("should-exit-shortcut-mode-on-window-blur: handleWindowBlur calls setMode('workspace')", () => {
      // First enable shortcut mode
      enableShortcutMode();
      expect(shortcutModeActive.value).toBe(true);

      handleWindowBlur();

      expect(shortcutModeActive.value).toBe(false);
      expect(mockApi.ui.setMode).toHaveBeenCalledWith("workspace");
    });

    it("handleWindowBlur when inactive is no-op", () => {
      handleWindowBlur();

      expect(shortcutModeActive.value).toBe(false);
      expect(mockApi.ui.setMode).not.toHaveBeenCalled();
    });

    // NOTE: These tests use handleShortcutKey to trigger navigation/jump which sets _switchingWorkspace
    it("should-not-exit-shortcut-mode-on-blur-during-navigation", async () => {
      setRows([ws("ws1"), ws("ws2")], { activePath: "/ws1" });

      // Make switchWorkspace slow so we can test blur during switch
      let resolveSwitch: () => void;
      mockApi.ui.switchWorkspace.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolveSwitch = resolve;
          })
      );

      enableShortcutMode();
      expect(shortcutModeActive.value).toBe(true);

      // Start navigation (this sets _switchingWorkspace = true)
      handleShortcutKey("down");

      // Simulate blur event during workspace switch (Electron triggers this)
      handleWindowBlur();

      // Should NOT exit shortcut mode because we're switching workspaces
      expect(shortcutModeActive.value).toBe(true);
      expect(mockApi.ui.setMode).not.toHaveBeenCalled();

      // Complete the switch
      resolveSwitch!();
      await Promise.resolve();
    });

    it("should-not-exit-shortcut-mode-on-blur-during-jump", async () => {
      setRows([ws("ws1"), ws("ws2")]);

      // Make switchWorkspace slow so we can test blur during switch
      let resolveSwitch: () => void;
      mockApi.ui.switchWorkspace.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolveSwitch = resolve;
          })
      );

      enableShortcutMode();
      expect(shortcutModeActive.value).toBe(true);

      // Start jump (this sets _switchingWorkspace = true)
      handleShortcutKey("2");

      // Simulate blur event during workspace switch (Electron triggers this)
      handleWindowBlur();

      // Should NOT exit shortcut mode because we're switching workspaces
      expect(shortcutModeActive.value).toBe(true);
      expect(mockApi.ui.setMode).not.toHaveBeenCalled();

      // Complete the switch
      resolveSwitch!();
      await Promise.resolve();
    });

    it("should-exit-shortcut-mode-on-blur-when-not-switching", () => {
      enableShortcutMode();
      expect(shortcutModeActive.value).toBe(true);

      // Blur without any navigation/jump in progress
      handleWindowBlur();

      // Should exit shortcut mode normally
      expect(shortcutModeActive.value).toBe(false);
      expect(mockApi.ui.setMode).toHaveBeenCalledWith("workspace");
    });
  });

  describe("exitShortcutMode API calls", () => {
    it("should-call-setMode-workspace-on-exit: exitShortcutMode calls api.ui.setMode('workspace')", () => {
      enableShortcutMode();
      handleWindowBlur(); // Uses exitShortcutMode internally

      expect(mockApi.ui.setMode).toHaveBeenCalledWith("workspace");
    });
  });

  describe("edge cases", () => {
    it("should-handle-rapid-mode-toggle: rapid state changes remain consistent", () => {
      enableShortcutMode();
      expect(shortcutModeActive.value).toBe(true);

      disableShortcutMode();
      expect(shortcutModeActive.value).toBe(false);

      enableShortcutMode();
      expect(shortcutModeActive.value).toBe(true);

      disableShortcutMode();
      expect(shortcutModeActive.value).toBe(false);

      // After all toggles, state should be consistent (mode changes don't call setMode since they're events from main process)
    });

    it("should-reset-state-for-testing: reset() sets state to false", () => {
      enableShortcutMode();
      expect(shortcutModeActive.value).toBe(true);

      reset();
      expect(shortcutModeActive.value).toBe(false);
    });
  });

  describe("handleKeyDown", () => {
    // NOTE: handleKeyDown now ONLY handles Escape key. All other action keys
    // come via handleShortcutKey from main process events (Stage 2).

    it("should-ignore-keydown-when-shortcut-mode-inactive", () => {
      const event = new KeyboardEvent("keydown", { key: "Escape" });
      const preventDefaultSpy = vi.spyOn(event, "preventDefault");

      handleKeyDown(event);

      // Should not do anything when shortcut mode is inactive
      expect(preventDefaultSpy).not.toHaveBeenCalled();
      expect(mockApi.ui.setMode).not.toHaveBeenCalled();
    });

    it("should-only-handle-escape-key", () => {
      enableShortcutMode();
      // Non-Escape keys are ignored by handleKeyDown (they come via handleShortcutKey)
      const event = new KeyboardEvent("keydown", { key: "ArrowDown" });
      const preventDefaultSpy = vi.spyOn(event, "preventDefault");

      handleKeyDown(event);

      expect(preventDefaultSpy).not.toHaveBeenCalled();
    });

    it("should-exit-shortcut-mode-on-escape", () => {
      enableShortcutMode();
      expect(shortcutModeActive.value).toBe(true);

      const event = new KeyboardEvent("keydown", { key: "Escape" });
      handleKeyDown(event);

      expect(shortcutModeActive.value).toBe(false);
      expect(mockApi.ui.setMode).toHaveBeenCalledWith("workspace");
    });

    describe("navigation actions", () => {
      const threeRows = (): UiWorkspaceRow[] => [ws("ws1"), ws("ws2"), ws("ws3")];

      it("should-navigate-from-no-active-workspace-down → first (panel open)", async () => {
        // When the creation panel is the current tab, no row is active.
        setRows(threeRows());

        enableShortcutMode();
        handleShortcutKey("down");

        await vi.waitFor(() => {
          expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith("/ws1", false);
        });
      });

      it("should-navigate-from-no-active-workspace-up → last (panel open)", async () => {
        setRows(threeRows());

        enableShortcutMode();
        handleShortcutKey("up");

        await vi.waitFor(() => {
          expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith("/ws3", false);
        });
      });

      it("should-navigate-to-next-workspace-on-down", async () => {
        setRows(threeRows(), { activePath: "/ws1" });

        enableShortcutMode();
        handleShortcutKey("down");

        // Wait for async action to complete
        await vi.waitFor(() => {
          // Should pass workspacePath and false to keep shortcut mode active
          expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith("/ws2", false);
        });
      });

      // NOTE: Navigation tests use handleShortcutKey with normalized keys ("up", "down")
      // since key normalization happens in main process before event is sent.
      it("should-navigate-to-previous-workspace-on-arrow-up", async () => {
        setRows(threeRows(), { activePath: "/ws2" });

        enableShortcutMode();
        handleShortcutKey("up");

        await vi.waitFor(() => {
          // Should pass workspacePath and false to keep shortcut mode active
          expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith("/ws1", false);
        });
      });

      it("should-wrap-to-last-workspace-when-navigating-up-from-first", async () => {
        setRows(threeRows(), { activePath: "/ws1" });

        enableShortcutMode();
        handleShortcutKey("up");

        await vi.waitFor(() => {
          // Should pass workspacePath and false to keep shortcut mode active
          expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith("/ws3", false);
        });
      });

      it("should-wrap-to-first-workspace-when-navigating-down-from-last", async () => {
        setRows(threeRows(), { activePath: "/ws3" });

        enableShortcutMode();
        handleShortcutKey("down");

        await vi.waitFor(() => {
          // Should pass workspacePath and false to keep shortcut mode active
          expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith("/ws1", false);
        });
      });

      it("should-not-navigate-when-no-workspaces", () => {
        setRows([]);

        enableShortcutMode();
        handleShortcutKey("down");

        expect(mockApi.ui.switchWorkspace).not.toHaveBeenCalled();
      });

      it("should-not-navigate-when-single-workspace", () => {
        setRows([ws("ws1")], { activePath: "/ws1" });

        enableShortcutMode();
        handleShortcutKey("down");

        expect(mockApi.ui.switchWorkspace).not.toHaveBeenCalled();
      });

      it("should-navigate-to-idle-workspace-on-left-arrow", async () => {
        // ws1 is idle, ws2 is current, ws3 is busy
        setRows(
          [
            ws("ws1", { agent: { type: "idle", counts: { idle: 1, busy: 0, total: 1 } } }),
            ws("ws2"),
            ws("ws3", { agent: { type: "busy", counts: { idle: 0, busy: 1, total: 1 } } }),
          ],
          { activePath: "/ws2" }
        );

        enableShortcutMode();
        handleShortcutKey("left");

        await vi.waitFor(() => {
          expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith("/ws1", false);
        });
      });

      it("should-navigate-to-idle-workspace-on-right-arrow", async () => {
        // ws1 is current, ws2 is busy, ws3 is idle
        setRows(
          [
            ws("ws1"),
            ws("ws2", { agent: { type: "busy", counts: { idle: 0, busy: 1, total: 1 } } }),
            ws("ws3", { agent: { type: "idle", counts: { idle: 1, busy: 0, total: 1 } } }),
          ],
          { activePath: "/ws1" }
        );

        enableShortcutMode();
        handleShortcutKey("right");

        await vi.waitFor(() => {
          // Should skip ws2 (busy) and go to ws3 (idle)
          expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith("/ws3", false);
        });
      });

      it("should-navigate-to-busy-workspace-when-no-idle-exist", async () => {
        // All other workspaces are busy - should fall back to busy navigation
        setRows(
          [
            ws("ws1"),
            ws("ws2", { agent: { type: "busy", counts: { idle: 0, busy: 1, total: 1 } } }),
            ws("ws3", { agent: { type: "busy", counts: { idle: 0, busy: 1, total: 1 } } }),
          ],
          { activePath: "/ws1" }
        );

        enableShortcutMode();
        handleShortcutKey("left");

        await vi.waitFor(() => {
          // Left from ws1 wraps to ws3 (busy)
          expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith("/ws3", false);
        });
      });

      it("should-prefer-idle-over-busy-when-both-exist", async () => {
        // ws2 is busy, ws3 is idle - should navigate to idle ws3
        setRows(
          [
            ws("ws1"),
            ws("ws2", { agent: { type: "busy", counts: { idle: 0, busy: 1, total: 1 } } }),
            ws("ws3", { agent: { type: "idle", counts: { idle: 1, busy: 0, total: 1 } } }),
          ],
          { activePath: "/ws1" }
        );

        enableShortcutMode();
        handleShortcutKey("right");

        await vi.waitFor(() => {
          // Should skip ws2 (busy) and go to ws3 (idle)
          expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith("/ws3", false);
        });
      });

      it("should-not-fall-back-to-busy-when-current-workspace-is-idle", () => {
        // ws1 (current) is idle, others are busy - should NOT jump to busy
        setRows(
          [
            ws("ws1", { agent: { type: "idle", counts: { idle: 1, busy: 0, total: 1 } } }),
            ws("ws2", { agent: { type: "busy", counts: { idle: 0, busy: 1, total: 1 } } }),
            ws("ws3", { agent: { type: "busy", counts: { idle: 0, busy: 1, total: 1 } } }),
          ],
          { activePath: "/ws1" }
        );

        enableShortcutMode();
        handleShortcutKey("right");

        expect(mockApi.ui.switchWorkspace).not.toHaveBeenCalled();
      });

      it("should-not-navigate-when-all-workspaces-are-none", () => {
        // All workspaces have no agent status
        setRows([ws("ws1"), ws("ws2"), ws("ws3")], { activePath: "/ws1" });

        enableShortcutMode();
        handleShortcutKey("left");

        expect(mockApi.ui.switchWorkspace).not.toHaveBeenCalled();
      });

      it("should-skip-hibernated-workspaces-in-status-navigation", async () => {
        // ws2 is hibernated and idle — idle nav must skip it and reach ws3.
        setRows(
          [
            ws("ws1"),
            ws("ws2", {
              hibernated: true,
              agent: { type: "idle", counts: { idle: 1, busy: 0, total: 1 } },
            }),
            ws("ws3", { agent: { type: "idle", counts: { idle: 1, busy: 0, total: 1 } } }),
          ],
          { activePath: "/ws1" }
        );

        enableShortcutMode();
        handleShortcutKey("right");

        await vi.waitFor(() => {
          expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith("/ws3", false);
        });
      });

      it("should-find-newly-idle-workspace-after-status-change", async () => {
        // Initially all workspaces have no agents
        setRows([ws("ws1"), ws("ws2"), ws("ws3")], { activePath: "/ws1" });

        enableShortcutMode();
        handleShortcutKey("right");

        // No idle or busy workspaces, so no navigation
        expect(mockApi.ui.switchWorkspace).not.toHaveBeenCalled();

        // Now ws2 becomes idle (a new snapshot push arrives)
        setRows(
          [
            ws("ws1"),
            ws("ws2", { agent: { type: "idle", counts: { idle: 1, busy: 0, total: 1 } } }),
            ws("ws3"),
          ],
          { activePath: "/ws1" }
        );

        // Press right again - should now find ws2
        handleShortcutKey("right");

        await vi.waitFor(() => {
          expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith("/ws2", false);
        });
      });

      it("should-prevent-concurrent-navigation-during-rapid-keypresses", async () => {
        setRows([ws("ws1"), ws("ws2"), ws("ws3")], { activePath: "/ws1" });

        // Make switchWorkspace slow
        let resolveSwitch: () => void;
        mockApi.ui.switchWorkspace.mockImplementation(
          () =>
            new Promise<void>((resolve) => {
              resolveSwitch = resolve;
            })
        );

        enableShortcutMode();

        // Fire rapid keypresses (now via handleShortcutKey)
        handleShortcutKey("down");
        handleShortcutKey("down");
        handleShortcutKey("down");

        // Only first should have been called
        expect(mockApi.ui.switchWorkspace).toHaveBeenCalledTimes(1);

        // Complete the switch
        resolveSwitch!();
        await Promise.resolve();
      });
    });

    describe("jump actions", () => {
      // NOTE: Jump tests use handleShortcutKey with digit keys ("0"-"9")
      // since these come from main process events.
      const manyRows = (count: number): UiWorkspaceRow[] =>
        Array.from({ length: count }, (_, i) => ws(`ws${i + 1}`));

      it("should-jump-to-workspace-1-through-9", async () => {
        setRows(manyRows(9));

        enableShortcutMode();

        // Test key "5" -> index 4 -> workspace 5
        handleShortcutKey("5");

        await vi.waitFor(() => {
          // Should pass workspacePath and false to keep shortcut mode active
          expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith("/ws5", false);
        });
      });

      it("should-jump-to-workspace-10-on-key-0", async () => {
        setRows(manyRows(10));

        enableShortcutMode();
        handleShortcutKey("0");

        await vi.waitFor(() => {
          // Should pass workspacePath and false to keep shortcut mode active
          expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith("/ws10", false);
        });
      });

      it("should-not-jump-when-index-out-of-range", () => {
        setRows(manyRows(3));

        enableShortcutMode();
        // Try to jump to workspace 5 when only 3 exist
        handleShortcutKey("5");

        expect(mockApi.ui.switchWorkspace).not.toHaveBeenCalled();
      });

      it("should-target-awake-list-skipping-hibernated", async () => {
        // ws2 is hibernated: the awake list is [ws1, ws3, ws4], so key "2"
        // (awake index 1) targets ws3.
        setRows([ws("ws1"), ws("ws2", { hibernated: true }), ws("ws3"), ws("ws4")]);

        enableShortcutMode();
        handleShortcutKey("2");

        await vi.waitFor(() => {
          expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith("/ws3", false);
        });
      });
    });

    describe("dialog actions", () => {
      // NOTE: Dialog tests use handleShortcutKey with normalized keys ("enter", "delete")
      // since these come from main process events. Backspace is normalized to "delete" by main process.
      it("should-deselect-on-enter (creation panel becomes the main view)", () => {
        setRows([ws("ws1")], { activePath: "/ws1" });

        enableShortcutMode();
        expect(shortcutModeActive.value).toBe(true);

        handleShortcutKey("enter");

        // Deselect: switch to null makes the creation panel the main view.
        expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith(null);
        expect(shortcutModeActive.value).toBe(false);
      });

      it("should-do-nothing-on-enter-when-panel-already-shown", () => {
        // Already on the creation panel: keyboard submit is Cmd/Ctrl+Enter
        // (owned by the form), not Alt+X+Enter.
        setRows([ws("ws1")]);

        enableShortcutMode();
        handleShortcutKey("enter");

        expect(mockApi.ui.switchWorkspace).not.toHaveBeenCalled();
      });

      it("should-open-remove-dialog-on-delete", () => {
        setRows([ws("feature", { path: "/workspace" })], { activePath: "/workspace" });

        enableShortcutMode();
        expect(shortcutModeActive.value).toBe(true);

        handleShortcutKey("delete");

        // Passes a WorkspaceRef built from the active row
        expect(mockDialogState.openRemoveDialog).toHaveBeenCalledWith({
          projectId: "test-project-12345678",
          workspaceName: "feature",
          path: "/workspace",
        });
        expect(shortcutModeActive.value).toBe(false);
      });

      it("should-not-open-remove-dialog-when-no-active-workspace", () => {
        setRows([ws("ws1")]);

        enableShortcutMode();
        handleShortcutKey("delete");

        expect(mockDialogState.openRemoveDialog).not.toHaveBeenCalled();
      });

      it("should-not-open-remove-dialog-when-deletion-in-progress", () => {
        setRows([ws("feature", { path: "/workspace", status: "deleting" })], {
          activePath: "/workspace",
        });

        enableShortcutMode();
        expect(shortcutModeActive.value).toBe(true);

        handleShortcutKey("delete");

        // Dialog should NOT be opened when deletion is in progress
        expect(mockDialogState.openRemoveDialog).not.toHaveBeenCalled();
        // Shortcut mode should still be active (no action taken)
        expect(shortcutModeActive.value).toBe(true);
      });

      it("should-not-open-remove-dialog-while-workspace-is-creating", () => {
        setRows([ws("feature", { path: "__pending__//project/feature", status: "creating" })], {
          activePath: "__pending__//project/feature",
        });

        enableShortcutMode();
        handleShortcutKey("delete");

        // Dialog should NOT be opened for an optimistic creating placeholder
        expect(mockDialogState.openRemoveDialog).not.toHaveBeenCalled();
        expect(shortcutModeActive.value).toBe(true);
      });

      it("should-open-remove-dialog-when-previous-deletion-failed", () => {
        setRows([ws("feature", { path: "/workspace", status: "delete-failed" })], {
          activePath: "/workspace",
        });

        enableShortcutMode();
        handleShortcutKey("delete");

        // Retry must stay possible after a failed deletion
        expect(mockDialogState.openRemoveDialog).toHaveBeenCalledWith({
          projectId: "test-project-12345678",
          workspaceName: "feature",
          path: "/workspace",
        });
      });

      it("should-deactivate-shortcut-mode-before-opening-dialog", () => {
        setRows([ws("ws1")], { activePath: "/ws1" });

        enableShortcutMode();
        expect(shortcutModeActive.value).toBe(true);

        handleShortcutKey("enter");

        expect(shortcutModeActive.value).toBe(false);
      });
    });

    describe("hibernate toggle", () => {
      it("hibernates the active awake workspace on H", async () => {
        setRows([ws("ws1")], { activePath: "/ws1" });

        enableShortcutMode();
        handleShortcutKey("h");

        await vi.waitFor(() => {
          expect(mockApi.workspaces.hibernate).toHaveBeenCalledWith("/ws1");
        });
      });

      it("wakes the active hibernated workspace on H", async () => {
        setRows([ws("ws1", { hibernated: true })], { activePath: "/ws1" });

        enableShortcutMode();
        handleShortcutKey("h");

        await vi.waitFor(() => {
          expect(mockApi.workspaces.wake).toHaveBeenCalledWith("/ws1");
        });
      });

      it("is inert while the creation panel is showing (nothing active)", () => {
        setRows([ws("ws1")]);

        enableShortcutMode();
        handleShortcutKey("h");

        expect(mockApi.workspaces.hibernate).not.toHaveBeenCalled();
        expect(mockApi.workspaces.wake).not.toHaveBeenCalled();
      });
    });

    describe("error handling", () => {
      // NOTE: Uses handleShortcutKey with normalized key "down" (not "ArrowDown")
      // since key normalization happens in main process before event is sent.
      it("handles workspace switch failure gracefully", async () => {
        setRows([ws("ws1"), ws("ws2")], { activePath: "/ws1" });
        mockApi.ui.switchWorkspace.mockRejectedValue(new Error("Switch failed"));

        enableShortcutMode();
        handleShortcutKey("down");

        // Verify the call was attempted with correct parameters
        await vi.waitFor(() => {
          expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith("/ws2", false);
        });
        // Logging is an implementation detail - we just verify the call was made
        // and no unhandled rejection occurs
      });
    });
  });
});
