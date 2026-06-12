/**
 * Tests for the App component.
 *
 * App owns mode routing (initializing → ready), global shortcut wiring, and
 * ARIA announcements. Workspace/project data arrives as UiState snapshots
 * pushed through the captured onState callback.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/svelte";
import { delay } from "@shared/test-fixtures";
import type { UiState } from "@shared/ui-state";

// API event callbacks - must be hoisted with mockApi so it's available when mock runs
type EventCallback = (...args: unknown[]) => void;
const { mockApi, eventCallbacks, stateCallbacks } = vi.hoisted(() => {
  const callbacks = new Map<string, EventCallback>();
  const stateCallbacks: Array<(state: unknown) => void> = [];
  return {
    eventCallbacks: callbacks,
    stateCallbacks,
    mockApi: {
      emitEvent: vi.fn(),
      workspaces: {
        hibernate: vi.fn().mockResolvedValue({ started: true }),
        wake: vi.fn().mockResolvedValue(null),
      },
      projects: {
        open: vi.fn().mockResolvedValue(undefined),
      },
      ui: {
        switchWorkspace: vi.fn().mockResolvedValue(undefined),
        setMode: vi.fn().mockResolvedValue(undefined),
      },
      lifecycle: {
        ready: vi.fn().mockResolvedValue({ defaultAgent: null, availableAgents: [] }),
        quit: vi.fn().mockResolvedValue(undefined),
      },
      // on() captures callbacks by event name for tests to fire events
      on: vi.fn((event: string, callback: EventCallback) => {
        callbacks.set(event, callback);
        return vi.fn(); // unsubscribe
      }),
      onState: vi.fn((callback: (state: unknown) => void) => {
        stateCallbacks.push(callback);
        return vi.fn();
      }),
      // onModeChange captures callback for ui:mode-changed events
      onModeChange: vi.fn((callback: EventCallback) => {
        callbacks.set("ui:mode-changed", callback);
        return vi.fn(); // unsubscribe
      }),
      // onShortcut captures callback for shortcut:key events
      onShortcut: vi.fn((callback: EventCallback) => {
        callbacks.set("shortcut:key", callback);
        return vi.fn(); // unsubscribe
      }),
      sendDialogEvent: vi.fn(),
      sendNotificationEvent: vi.fn(),
    },
  };
});

// Helper to get an event callback
function getEventCallback(event: string): EventCallback | undefined {
  return eventCallbacks.get(event);
}

// Helper to fire an event
function fireEvent(event: string, payload?: unknown): void {
  const callback = eventCallbacks.get(event);
  if (callback) {
    callback(payload);
  }
}

/** Deliver a snapshot through the captured onState callback (real holder). */
function pushState(state: UiState): void {
  for (const callback of stateCallbacks as Array<(state: UiState) => void>) {
    callback(state);
  }
}

/**
 * Trigger the main view to show.
 * App starts in "initializing" mode and waits for the main process to send
 * "lifecycle:show-main-view" before rendering MainView.
 */
function showMainView(): void {
  fireEvent("lifecycle:show-main-view");
}

// Mock the API module before any imports use it
vi.mock("$lib/api", () => mockApi);

// Import after mock setup
import App from "./App.svelte";
import * as shortcutsStore from "$lib/stores/shortcuts.svelte.js";
import * as dialogFrameworkStore from "$lib/stores/dialog-framework.svelte.js";
import { resetUiState } from "$lib/stores/ui-state.svelte.js";
import { makeUiState, makeUiProjectRow, makeUiWorkspaceRow } from "$lib/test-utils";
import type { UiWorkspaceRow } from "@shared/ui-state";

/** Push a snapshot with the given rows; active row drives main. */
async function pushRows(rows: UiWorkspaceRow[], activePath?: string): Promise<void> {
  await waitFor(() => expect(mockApi.onState).toHaveBeenCalled());
  const marked = rows.map((row) => ({ ...row, active: row.path === activePath }));
  const activeRow = marked.find((row) => row.active);
  pushState(
    makeUiState([makeUiProjectRow(marked)], {
      main: activeRow ? { kind: "workspace", frameKey: activeRow.key } : { kind: "creation" },
    })
  );
}

function ws(name: string): UiWorkspaceRow {
  return makeUiWorkspaceRow(name, {
    path: `/test/.worktrees/${name}`,
    key: `test-project-12345678/${name}`,
  });
}

// Simulate the backend creation module's always-alive panel session.
function openCreationPanelSession(dialogId = "dlg-creation-1"): void {
  dialogFrameworkStore.processCommand({
    action: "open",
    dialogId,
    config: {
      layout: "form",
      sections: [{ type: "text", content: "New workspace", style: "heading" }],
    },
    surface: "panel",
  });
}

describe("App component", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    eventCallbacks.clear();
    stateCallbacks.length = 0;
    resetUiState();
    shortcutsStore.reset();
    dialogFrameworkStore.reset();
    // Restore capture implementations (the unmount test overrides return values)
    mockApi.onModeChange.mockImplementation((callback: EventCallback) => {
      eventCallbacks.set("ui:mode-changed", callback);
      return vi.fn();
    });
    mockApi.onShortcut.mockImplementation((callback: EventCallback) => {
      eventCallbacks.set("shortcut:key", callback);
      return vi.fn();
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  describe("mode routing", () => {
    it("starts in initializing mode (no MainView)", () => {
      const { container } = render(App);

      expect(container.querySelector(".initializing-container")).toBeInTheDocument();
      expect(container.querySelector(".main-view")).not.toBeInTheDocument();
    });

    it("renders MainView after lifecycle:show-main-view", async () => {
      const { container } = render(App);
      showMainView();

      await waitFor(() => {
        expect(container.querySelector(".main-view")).toBeInTheDocument();
      });
      expect(container.querySelector(".initializing-container")).not.toBeInTheDocument();
    });

    it("announces 'Application ready' when the main view becomes visible", async () => {
      render(App);
      showMainView();

      await waitFor(() => {
        const region = document.querySelector('[aria-live="polite"]');
        expect(region).toHaveTextContent("Application ready");
      });
    });
  });

  describe("rendering from snapshots", () => {
    it("renders Sidebar rows from a pushed snapshot", async () => {
      render(App);
      showMainView();
      await pushRows([ws("ws1")]);

      await waitFor(() => {
        expect(screen.getByText("ws1")).toBeInTheDocument();
      });
    });

    it("renders the creation panel when the snapshot says creation and the session exists", async () => {
      render(App);
      showMainView();
      openCreationPanelSession();
      await pushRows([ws("ws1")]); // no active → creation

      await waitFor(() => {
        expect(screen.getByRole("heading", { name: "New workspace" })).toBeInTheDocument();
      });
    });
  });

  describe("shortcut mode handling", () => {
    it("subscribes to onModeChange and onShortcut on mount", async () => {
      render(App);
      showMainView();

      await waitFor(() => {
        expect(mockApi.onModeChange).toHaveBeenCalledWith(expect.any(Function));
        expect(mockApi.onShortcut).toHaveBeenCalledWith(expect.any(Function));
      });
    });

    it("shows the shortcut overlay when mode becomes shortcut and hides it on workspace", async () => {
      const { container } = render(App);
      showMainView();
      await pushRows([ws("ws1")], "/test/.worktrees/ws1");

      await waitFor(() => expect(getEventCallback("ui:mode-changed")).toBeDefined());

      fireEvent("ui:mode-changed", { mode: "shortcut", previousMode: "workspace" });
      await waitFor(() => {
        expect(container.querySelector(".shortcut-overlay.active")).toBeInTheDocument();
      });

      fireEvent("ui:mode-changed", { mode: "workspace", previousMode: "shortcut" });
      await waitFor(() => {
        expect(container.querySelector(".shortcut-overlay.active")).not.toBeInTheDocument();
      });
    });

    it("announces shortcut mode for screen readers", async () => {
      render(App);
      showMainView();
      await waitFor(() => expect(getEventCallback("ui:mode-changed")).toBeDefined());

      fireEvent("ui:mode-changed", { mode: "shortcut", previousMode: "workspace" });

      await waitFor(() => {
        const region = document.querySelector('[aria-live="polite"]');
        expect(region).toHaveTextContent(/shortcut mode active/i);
      });
    });

    it("window blur exits shortcut mode", async () => {
      render(App);
      showMainView();
      await waitFor(() => expect(getEventCallback("ui:mode-changed")).toBeDefined());

      fireEvent("ui:mode-changed", { mode: "shortcut", previousMode: "workspace" });
      window.dispatchEvent(new Event("blur"));

      expect(mockApi.ui.setMode).toHaveBeenCalledWith("workspace");
    });

    it("Escape key in shortcut mode calls api.ui.setMode('workspace')", async () => {
      render(App);
      showMainView();
      await waitFor(() => expect(getEventCallback("ui:mode-changed")).toBeDefined());

      fireEvent("ui:mode-changed", { mode: "shortcut", previousMode: "workspace" });
      mockApi.ui.setMode.mockClear();

      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

      expect(mockApi.ui.setMode).toHaveBeenCalledWith("workspace");
    });

    it("Escape key when not in shortcut mode does not call setMode", async () => {
      render(App);
      showMainView();
      await waitFor(() => expect(getEventCallback("ui:mode-changed")).toBeDefined());

      mockApi.ui.setMode.mockClear();
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

      expect(mockApi.ui.setMode).not.toHaveBeenCalled();
    });

    it("unsubscribes from mode and shortcut events on unmount", async () => {
      const unsubMode = vi.fn();
      const unsubShortcut = vi.fn();
      mockApi.onModeChange.mockImplementation((callback: EventCallback) => {
        eventCallbacks.set("ui:mode-changed", callback);
        return unsubMode;
      });
      mockApi.onShortcut.mockImplementation((callback: EventCallback) => {
        eventCallbacks.set("shortcut:key", callback);
        return unsubShortcut;
      });

      const { unmount } = render(App);
      showMainView();
      await waitFor(() => expect(mockApi.onShortcut).toHaveBeenCalled());

      unmount();

      expect(unsubMode).toHaveBeenCalledTimes(1);
      expect(unsubShortcut).toHaveBeenCalledTimes(1);
    });
  });

  describe("shortcut key flows (snapshot-driven)", () => {
    it('shortcut "up" navigates to previous workspace', async () => {
      render(App);
      showMainView();
      await pushRows([ws("ws1"), ws("ws2")], "/test/.worktrees/ws2");
      await waitFor(() => expect(getEventCallback("shortcut:key")).toBeDefined());

      fireEvent("ui:mode-changed", { mode: "shortcut", previousMode: "workspace" });
      fireEvent("shortcut:key", "up");

      await waitFor(() => {
        expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith("/test/.worktrees/ws1", false);
      });
    });

    it('shortcut "down" navigates to next workspace', async () => {
      render(App);
      showMainView();
      await pushRows([ws("ws1"), ws("ws2")], "/test/.worktrees/ws1");
      await waitFor(() => expect(getEventCallback("shortcut:key")).toBeDefined());

      fireEvent("ui:mode-changed", { mode: "shortcut", previousMode: "workspace" });
      fireEvent("shortcut:key", "down");

      await waitFor(() => {
        expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith("/test/.worktrees/ws2", false);
      });
    });

    it('shortcut "2" jumps to the second workspace', async () => {
      render(App);
      showMainView();
      await pushRows([ws("ws1"), ws("ws2"), ws("ws3")]);
      await waitFor(() => expect(getEventCallback("shortcut:key")).toBeDefined());

      fireEvent("ui:mode-changed", { mode: "shortcut", previousMode: "workspace" });
      fireEvent("shortcut:key", "2");

      await waitFor(() => {
        expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith("/test/.worktrees/ws2", false);
      });
    });

    it("shortcut number beyond workspace count is ignored", async () => {
      render(App);
      showMainView();
      await pushRows([ws("ws1"), ws("ws2")]);
      await waitFor(() => expect(getEventCallback("shortcut:key")).toBeDefined());

      mockApi.ui.switchWorkspace.mockClear();
      fireEvent("ui:mode-changed", { mode: "shortcut", previousMode: "workspace" });
      fireEvent("shortcut:key", "5");

      await delay(50);
      expect(mockApi.ui.switchWorkspace).not.toHaveBeenCalled();
    });

    it('shortcut "enter" deselects so the creation panel becomes the main view', async () => {
      render(App);
      showMainView();
      await pushRows([ws("ws1")], "/test/.worktrees/ws1");
      await waitFor(() => expect(getEventCallback("shortcut:key")).toBeDefined());

      fireEvent("ui:mode-changed", { mode: "shortcut", previousMode: "workspace" });
      fireEvent("shortcut:key", "enter");

      expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith(null);
    });

    it('shortcut "delete" requests the remove flow for the active workspace', async () => {
      render(App);
      showMainView();
      await pushRows([ws("ws1")], "/test/.worktrees/ws1");
      await waitFor(() => expect(getEventCallback("shortcut:key")).toBeDefined());

      fireEvent("ui:mode-changed", { mode: "shortcut", previousMode: "workspace" });
      fireEvent("shortcut:key", "delete");

      // The confirmation dialog is a main-side framework session now; the
      // renderer's part ends at the keyed ui:event.
      expect(mockApi.emitEvent).toHaveBeenCalledWith({
        kind: "remove-workspace",
        key: "test-project-12345678/ws1",
      });
    });
  });
});
