/**
 * Tests for the App component.
 *
 * App owns the ui:state subscription + ui-connected handshake (on mount) and
 * routes by the snapshot's main.kind: startup kinds (starting / setup /
 * agent-selection / loading) render StartupView; workspace / hibernated /
 * creation render MainView. Until the first snapshot arrives it shows a blank
 * initializing state. ARIA announcements are driven by the snapshot mode
 * (keyboard shortcuts and UI mode are main-owned now).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/svelte";
import type { UiState } from "@shared/ui-state";

const { mockApi, stateCallbacks } = vi.hoisted(() => {
  const stateCallbacks: Array<(state: unknown) => void> = [];
  return {
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
      on: vi.fn(() => vi.fn()),
      onState: vi.fn((callback: (state: unknown) => void) => {
        stateCallbacks.push(callback);
        return vi.fn();
      }),
      sendDialogEvent: vi.fn(),
      sendNotificationEvent: vi.fn(),
    },
  };
});

/** The last snapshot delivered, so panel-session helpers can extend it. */
let currentState: UiState | undefined;

/** Deliver a snapshot through the captured onState callback (App's real seam). */
function pushState(state: UiState): void {
  currentState = state;
  for (const callback of stateCallbacks as Array<(state: UiState) => void>) {
    callback(state);
  }
}

// Mock the API module before any imports use it
vi.mock("$lib/api", () => mockApi);

// Import after mock setup
import App from "./App.svelte";
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

// Simulate the backend creation module's always-alive panel session by adding a
// panel-surface dialog to the current snapshot.
function openCreationPanelSession(dialogId = "dlg-creation-1"): void {
  const current = currentState ?? makeUiState([]);
  pushState({
    ...current,
    dialogs: [
      ...current.dialogs,
      {
        id: dialogId,
        surface: "panel",
        config: {
          layout: "form",
          sections: [{ type: "text", content: "New workspace", style: "heading" }],
        },
      },
    ],
  });
}

describe("App component", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateCallbacks.length = 0;
    currentState = undefined;
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  describe("snapshot routing", () => {
    it("subscribes to ui:state and emits ui-connected on mount", async () => {
      render(App);

      await waitFor(() => expect(mockApi.onState).toHaveBeenCalledTimes(1));
      expect(mockApi.emitEvent).toHaveBeenCalledWith({ kind: "ui-connected" });
    });

    it("starts blank (no MainView) before the first snapshot", () => {
      const { container } = render(App);

      expect(container.querySelector(".initializing-container")).toBeInTheDocument();
      expect(container.querySelector(".main-view")).not.toBeInTheDocument();
    });

    it("renders StartupView for startup snapshots, not MainView", async () => {
      const { container } = render(App);
      await waitFor(() => expect(mockApi.onState).toHaveBeenCalled());

      pushState(makeUiState([], { main: { kind: "starting" }, mode: "dialog" }));
      await waitFor(() => {
        expect(container.querySelector(".startup-view")).toBeInTheDocument();
      });
      expect(container.querySelector(".main-view")).not.toBeInTheDocument();
    });

    it("renders the setup progress rows and Retry/Quit on error", async () => {
      const { container } = render(App);
      await waitFor(() => expect(mockApi.onState).toHaveBeenCalled());

      pushState(
        makeUiState([], {
          mode: "dialog",
          main: {
            kind: "setup",
            rows: [{ id: "vscode", label: "VSCode", status: "running" }],
            error: { message: "it broke" },
          },
        })
      );

      await waitFor(() => {
        expect(screen.getByText("VSCode")).toBeInTheDocument();
        expect(screen.getByText("it broke")).toBeInTheDocument();
      });
      expect(container.querySelector(".startup-view")).toBeInTheDocument();
    });

    it("agent-selection Continue emits agent-selected with the picked agent", async () => {
      render(App);
      await waitFor(() => expect(mockApi.onState).toHaveBeenCalled());

      pushState(
        makeUiState([], {
          mode: "dialog",
          main: {
            kind: "agent-selection",
            agents: [
              { agent: "claude", label: "Claude", icon: "sparkle" },
              { agent: "opencode", label: "OpenCode", icon: "terminal" },
            ],
          },
        })
      );
      await waitFor(() => expect(screen.getByText("OpenCode")).toBeInTheDocument());

      await fireEvent.click(screen.getByRole("radio", { name: /opencode/i }));
      await fireEvent.click(screen.getByRole("button", { name: "Continue" }));

      expect(mockApi.emitEvent).toHaveBeenCalledWith({
        kind: "agent-selected",
        agent: "opencode",
      });
    });

    it("renders MainView for a normal snapshot", async () => {
      const { container } = render(App);
      await pushRows([ws("ws1")]);

      await waitFor(() => {
        expect(container.querySelector(".main-view")).toBeInTheDocument();
      });
      expect(container.querySelector(".initializing-container")).not.toBeInTheDocument();
    });

    it("announces 'Application ready' when a normal snapshot arrives", async () => {
      render(App);
      await pushRows([ws("ws1")]);

      await waitFor(() => {
        const region = document.querySelector('[aria-live="polite"]');
        expect(region).toHaveTextContent("Application ready");
      });
    });
  });

  describe("rendering from snapshots", () => {
    it("renders Sidebar rows from a pushed snapshot", async () => {
      render(App);
      await pushRows([ws("ws1")]);

      await waitFor(() => {
        expect(screen.getByText("ws1")).toBeInTheDocument();
      });
    });

    it("renders the creation panel when the snapshot says creation and the session exists", async () => {
      render(App);
      await pushRows([ws("ws1")]); // no active → creation
      openCreationPanelSession();

      await waitFor(() => {
        expect(screen.getByRole("heading", { name: "New workspace" })).toBeInTheDocument();
      });
    });
  });

  describe("shortcut mode (snapshot-driven)", () => {
    it("shows the shortcut overlay when the snapshot mode is shortcut and hides it otherwise", async () => {
      const { container } = render(App);

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

      // First a normal snapshot (drains the one-shot "Application ready"
      // announcement), then transition into shortcut mode.
      await pushRows([ws("ws1")], "test-project-12345678/ws1", { mode: "workspace" });
      await waitFor(() => {
        const region = document.querySelector('[aria-live="polite"]');
        expect(region).toHaveTextContent("Application ready");
      });

      await pushRows([ws("ws1")], "test-project-12345678/ws1", { mode: "shortcut" });
      await waitFor(() => {
        const region = document.querySelector('[aria-live="polite"]');
        expect(region).toHaveTextContent(/shortcut mode active/i);
      });
    });
  });
});
