/**
 * Integration tests for the UI layer.
 *
 * Complete user flows under the read-cutover architecture: interactions fire
 * invokes; the test then plays the main process's part by pushing the
 * resulting UiState snapshot through the captured onState callback and
 * asserting the rendered outcome.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/svelte";
import type { UiState, UiWorkspaceRow } from "@shared/ui-state";

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
      on: vi.fn((event: string, callback: EventCallback) => {
        callbacks.set(event, callback);
        return vi.fn();
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

vi.mock("$lib/api", () => mockApi);

// Import after mock setup
import App from "../App.svelte";
import * as dialogFrameworkStore from "$lib/stores/dialog-framework.svelte.js";
import { resetUiState } from "$lib/stores/ui-state.svelte.js";
import { makeUiState, makeUiProjectRow, makeUiWorkspaceRow } from "$lib/test-utils";

function fireApiEvent(event: string, payload?: unknown): void {
  eventCallbacks.get(event)?.(payload);
}

function pushState(state: UiState): void {
  expect(stateCallbacks.length).toBeGreaterThan(0);
  for (const callback of stateCallbacks as Array<(state: UiState) => void>) {
    callback(state);
  }
}

function ws(name: string, overrides?: Partial<UiWorkspaceRow>): UiWorkspaceRow {
  return makeUiWorkspaceRow(name, {
    path: `/test/.worktrees/${name}`,
    key: `test-project-12345678/${name}`,
    ...overrides,
  });
}

/** Snapshot where the row at activeName is active (else: creation panel). */
function snapshotOf(rows: UiWorkspaceRow[], activeName?: string): UiState {
  const marked = rows.map((row) => ({ ...row, active: row.name === activeName }));
  const activeRow = marked.find((row) => row.active);
  return makeUiState([makeUiProjectRow(marked)], {
    main: activeRow ? { kind: "workspace", frameKey: activeRow.key } : { kind: "creation" },
  });
}

async function renderApp(initial?: UiState): Promise<{ container: HTMLElement }> {
  const { container } = render(App);
  fireApiEvent("lifecycle:show-main-view");
  await waitFor(() => expect(mockApi.onState).toHaveBeenCalled());
  if (initial) {
    pushState(initial);
  }
  return { container };
}

/** Expand the sidebar so label cells (remove/close buttons) are interactable. */
async function expandSidebar(): Promise<void> {
  const sidebar = document.querySelector(".sidebar")!;
  await fireEvent.mouseEnter(sidebar);
}

describe("Integration tests", () => {
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

  describe("switch workspace flow", () => {
    it("click workspace → switchWorkspace invoke → pushed snapshot moves aria-current", async () => {
      await renderApp(snapshotOf([ws("ws1"), ws("ws2")], "ws1"));
      await waitFor(() => expect(screen.getByText("ws2")).toBeInTheDocument());

      await fireEvent.click(screen.getByRole("button", { name: "ws2" }));
      expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith("/test/.worktrees/ws2");

      // The presenter answers with a new snapshot (workspace:switched).
      pushState(snapshotOf([ws("ws1"), ws("ws2")], "ws2"));

      await waitFor(() => {
        const ws2Item = screen.getByText("ws2").closest("li");
        expect(ws2Item).toHaveAttribute("aria-current", "true");
        const ws1Item = screen.getByText("ws1").closest("li");
        expect(ws1Item).not.toHaveAttribute("aria-current");
      });
    });
  });

  describe("remove workspace flow", () => {
    it("click [×] → remove-workspace ui:event → pushed snapshots show deletion and drop the row", async () => {
      await renderApp(snapshotOf([ws("ws1"), ws("ws2")], "ws1"));
      await waitFor(() => expect(screen.getByText("ws2")).toBeInTheDocument());
      await expandSidebar();

      // Request the remove flow for ws2 (the confirmation dialog is a
      // main-side framework session now; this test covers the renderer's
      // part: the gesture emits the keyed event).
      const removeButton = document.getElementById("remove-ws-test-project-12345678/ws2");
      expect(removeButton).toBeInTheDocument();
      await fireEvent.click(removeButton!);

      expect(mockApi.emitEvent).toHaveBeenCalledWith({
        kind: "remove-workspace",
        key: "test-project-12345678/ws2",
      });

      // Deletion progress + removal arrive as snapshots
      pushState(snapshotOf([ws("ws1"), ws("ws2", { status: "deleting" })], "ws1"));
      await waitFor(() => {
        expect(document.querySelector("vscode-progress-ring.deletion-spinner")).toBeInTheDocument();
      });

      pushState(snapshotOf([ws("ws1")], "ws1"));
      await waitFor(() => {
        expect(screen.queryByText("ws2")).not.toBeInTheDocument();
      });
    });
  });

  describe("creation panel (ground state) flows", () => {
    it("deleting the last workspace lands on the creation panel", async () => {
      dialogFrameworkStore.processCommand({
        action: "open",
        dialogId: "dlg-creation",
        config: {
          layout: "form",
          sections: [{ type: "text", content: "New workspace", style: "heading" }],
        },
        surface: "panel",
      });
      await renderApp(snapshotOf([ws("ws1")], "ws1"));
      await waitFor(() => expect(screen.getByText("ws1")).toBeInTheDocument());

      // Last workspace removed: the presenter pushes the ground state.
      pushState(snapshotOf([]));

      await waitFor(() => {
        expect(screen.getByRole("heading", { name: "New workspace" })).toBeInTheDocument();
      });
    });

    it("snapshot mode drives sidebar expansion (hover panel → workspace)", async () => {
      // Panel showing: main pushes mode "hover" → sidebar expanded.
      await renderApp({ ...snapshotOf([ws("ws1")]), mode: "hover" });

      await waitFor(() => {
        expect(document.querySelector(".sidebar")).toHaveClass("expanded");
      });

      // Selecting a workspace: the presenter closes the panel and pushes
      // mode "workspace" in the same snapshot.
      pushState({ ...snapshotOf([ws("ws1")], "ws1"), mode: "workspace" });

      await waitFor(() => {
        expect(document.querySelector(".sidebar")).not.toHaveClass("expanded");
      });
    });
  });

  describe("state consistency", () => {
    it("the sidebar always mirrors the latest snapshot", async () => {
      await renderApp(snapshotOf([ws("alpha")]));
      await waitFor(() => expect(screen.getByText("alpha")).toBeInTheDocument());

      pushState(snapshotOf([ws("alpha"), ws("beta")]));
      await waitFor(() => expect(screen.getByText("beta")).toBeInTheDocument());

      pushState(snapshotOf([ws("beta")]));
      await waitFor(() => {
        expect(screen.queryByText("alpha")).not.toBeInTheDocument();
        expect(screen.getByText("beta")).toBeInTheDocument();
      });
    });
  });

  describe("shortcut overlay (snapshot mode driven)", () => {
    it("the overlay reflects the snapshot mode and the active row follows pushes", async () => {
      // Main owns shortcut detection + navigation now: the renderer only
      // shows/hides the overlay from the snapshot mode, and the active row
      // moves as the presenter pushes the post-switch snapshot.
      const { container } = await renderApp({
        ...snapshotOf([ws("ws1"), ws("ws2")], "ws1"),
        mode: "shortcut",
      });

      await waitFor(() => {
        expect(container.querySelector(".shortcut-overlay.active")).toBeInTheDocument();
      });

      // The presenter navigated and pushed the post-switch snapshot, still in
      // shortcut mode.
      pushState({ ...snapshotOf([ws("ws1"), ws("ws2")], "ws2"), mode: "shortcut" });
      await waitFor(() => {
        const ws2Item = screen.getByText("ws2").closest("li");
        expect(ws2Item).toHaveAttribute("aria-current", "true");
      });

      // Shortcut mode exits (Alt released): the snapshot mode flips and the
      // overlay hides.
      pushState({ ...snapshotOf([ws("ws1"), ws("ws2")], "ws2"), mode: "workspace" });
      await waitFor(() => {
        expect(container.querySelector(".shortcut-overlay.active")).not.toBeInTheDocument();
      });
    });
  });

  describe("onboarding flow", () => {
    it("empty state: ground-state snapshot + panel session render the creation form", async () => {
      dialogFrameworkStore.processCommand({
        action: "open",
        dialogId: "dlg-creation",
        config: {
          layout: "form",
          sections: [{ type: "text", content: "New workspace", style: "heading" }],
        },
        surface: "panel",
      });

      await renderApp(makeUiState([]));

      await waitFor(() => {
        expect(screen.getByRole("heading", { name: "New workspace" })).toBeInTheDocument();
      });
    });
  });
});
