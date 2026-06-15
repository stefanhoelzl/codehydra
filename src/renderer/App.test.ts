/**
 * Tests for the App component.
 *
 * App owns mode routing (initializing → ready) and ARIA announcements (driven
 * by the snapshot mode — keyboard shortcuts and UI mode are main-owned now).
 * Workspace/project data arrives as UiState snapshots pushed through the
 * captured onState callback.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/svelte";
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
      sendDialogEvent: vi.fn(),
      sendNotificationEvent: vi.fn(),
    },
  };
});

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
import * as dialogFrameworkStore from "$lib/stores/dialog-framework.svelte.js";
import { resetUiState } from "$lib/stores/ui-state.svelte.js";
import { makeUiState, makeUiProjectRow, makeUiWorkspaceRow } from "$lib/test-utils";
import type { UiWorkspaceRow } from "@shared/ui-state";

/** Push a snapshot with the given rows; active row drives main. */
async function pushRows(
  rows: UiWorkspaceRow[],
  activeKey?: string,
  overrides?: Partial<UiState>
): Promise<void> {
  await waitFor(() => expect(mockApi.onState).toHaveBeenCalled());
  const marked = rows.map((row) => ({ ...row, active: row.key === activeKey }));
  const activeRow = marked.find((row) => row.active);
  pushState(
    makeUiState([makeUiProjectRow(marked)], {
      main: activeRow ? { kind: "workspace", frameKey: activeRow.key } : { kind: "creation" },
      ...overrides,
    })
  );
}

function ws(name: string): UiWorkspaceRow {
  return makeUiWorkspaceRow(name, {
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
    dialogFrameworkStore.reset();
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

  describe("shortcut mode (snapshot-driven)", () => {
    it("shows the shortcut overlay when the snapshot mode is shortcut and hides it otherwise", async () => {
      const { container } = render(App);
      showMainView();

      await pushRows([ws("ws1")], "test-project-12345678/ws1", { mode: "shortcut" });
      await waitFor(() => {
        expect(container.querySelector(".shortcut-overlay.active")).toBeInTheDocument();
      });

      await pushRows([ws("ws1")], "test-project-12345678/ws1", { mode: "workspace" });
      await waitFor(() => {
        expect(container.querySelector(".shortcut-overlay.active")).not.toBeInTheDocument();
      });
    });

    it("announces shortcut mode for screen readers on the snapshot transition", async () => {
      render(App);
      showMainView();

      await pushRows([ws("ws1")], "test-project-12345678/ws1", { mode: "shortcut" });

      await waitFor(() => {
        const region = document.querySelector('[aria-live="polite"]');
        expect(region).toHaveTextContent(/shortcut mode active/i);
      });
    });
  });
});
