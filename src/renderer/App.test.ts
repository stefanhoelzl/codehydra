/**
 * Tests for the App component.
 *
 * App owns the ui:state subscription + ui-connected handshake (on mount) and
 * routes by the snapshot's main.kind: `starting` (the single pre-app:started
 * marker) shows a blank base with the presenter's startup surfaces rendered as
 * modal dialogs via DialogHost; workspace / hibernated / creation render
 * MainView. Until the first snapshot arrives it shows a blank initializing
 * state. ARIA announcements are driven by the snapshot mode (keyboard shortcuts
 * and UI mode are main-owned now).
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
        kind: "modeless",
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

    it("shows a blank base (no MainView) for the starting marker, with the startup dialog on top", async () => {
      const { container } = render(App);
      await waitFor(() => expect(mockApi.onState).toHaveBeenCalled());

      pushState(
        makeUiState([], {
          main: { kind: "starting" },
          mode: "dialog",
          dialogs: [
            {
              id: "dlg-startup-1",
              kind: "modal",
              config: {
                sections: [
                  {
                    type: "progress",
                    style: "spinner",
                    items: [{ id: "status", label: "CodeHydra is starting…", status: "running" }],
                  },
                ],
              },
            },
          ],
        })
      );

      await waitFor(() => {
        expect(screen.getByText(/CodeHydra is starting/i)).toBeInTheDocument();
      });
      // No MainView while starting; the blank base + startup dialog own the screen.
      expect(container.querySelector(".main-view")).not.toBeInTheDocument();
      expect(container.querySelector(".initializing-container")).toBeInTheDocument();
    });

    it("renders the setup progress rows and Retry/Quit from the startup dialog on error", async () => {
      const { container } = render(App);
      await waitFor(() => expect(mockApi.onState).toHaveBeenCalled());

      pushState(
        makeUiState([], {
          mode: "dialog",
          main: { kind: "starting" },
          dialogs: [
            {
              id: "dlg-setup-1",
              kind: "modal",
              config: {
                sections: [
                  { type: "text", content: "Setting up CodeHydra", style: "heading" },
                  {
                    type: "progress",
                    style: "spinner",
                    items: [{ id: "vscode", label: "VSCode", status: "running" }],
                  },
                  { type: "text", content: "it broke", style: "error" },
                  {
                    type: "group",
                    items: [
                      { type: "button", id: "retry", label: "Retry", variant: "primary" },
                      { type: "button", id: "quit", label: "Quit", variant: "secondary" },
                    ],
                  },
                ],
              },
            },
          ],
        })
      );

      await waitFor(() => {
        expect(screen.getByText("VSCode")).toBeInTheDocument();
        expect(screen.getByText("it broke")).toBeInTheDocument();
      });
      expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Quit" })).toBeInTheDocument();
      expect(container.querySelector(".main-view")).not.toBeInTheDocument();
    });

    it("agent picker Continue emits a dialog-action with the picked agent", async () => {
      render(App);
      await waitFor(() => expect(mockApi.onState).toHaveBeenCalled());

      pushState(
        makeUiState([], {
          mode: "dialog",
          main: { kind: "starting" },
          dialogs: [
            {
              id: "dlg-agent-1",
              kind: "modal",
              config: {
                sections: [
                  { type: "text", content: "Choose Agent", style: "heading" },
                  {
                    type: "radio",
                    id: "agent",
                    options: [
                      { id: "claude", label: "Claude", icon: "sparkle" },
                      { id: "opencode", label: "OpenCode", icon: "terminal" },
                    ],
                  },
                  {
                    type: "group",
                    items: [
                      { type: "button", id: "continue", label: "Continue", variant: "primary" },
                    ],
                  },
                ],
              },
            },
          ],
        })
      );
      await waitFor(() => expect(screen.getByText("OpenCode")).toBeInTheDocument());

      await fireEvent.click(screen.getByRole("radio", { name: /opencode/i }));
      await fireEvent.click(screen.getByRole("button", { name: "Continue" }));

      // Continue is an ordinary dialog action now; main resolves the pick.
      expect(mockApi.sendDialogEvent).toHaveBeenCalledWith({
        dialogId: "dlg-agent-1",
        actionId: "continue",
        data: { agent: "opencode" },
      });
    });

    it("agent picker keyboard works when the persistent startup dialog swaps spinner→radio", async () => {
      // Reproduces the real flow: the startup surfaces are ONE modal dialog
      // handle updated across phases, so the Form never remounts. Focus must
      // follow onto the radio when the config changes, or arrows/Enter are dead.
      render(App);
      await waitFor(() => expect(mockApi.onState).toHaveBeenCalled());

      const spinner = {
        id: "dlg-sys",
        kind: "modal" as const,
        config: {
          sections: [
            {
              type: "progress" as const,
              style: "spinner" as const,
              items: [
                { id: "status", label: "CodeHydra is starting…", status: "running" as const },
              ],
            },
          ],
        },
      };
      pushState(
        makeUiState([], { main: { kind: "starting" }, mode: "dialog", dialogs: [spinner] })
      );

      // Same dialog id, config swapped to the agent radio (autofocus opts in).
      const agentDialog = {
        id: "dlg-sys",
        kind: "modal" as const,
        config: {
          sections: [
            { type: "text" as const, content: "Choose Agent", style: "heading" as const },
            {
              type: "radio" as const,
              id: "agent",
              autofocus: true,
              options: [
                { id: "claude", label: "Claude", icon: "sparkle" },
                { id: "opencode", label: "OpenCode", icon: "terminal" },
              ],
            },
            {
              type: "group" as const,
              items: [
                {
                  type: "button" as const,
                  id: "continue",
                  label: "Continue",
                  variant: "primary" as const,
                },
              ],
            },
          ],
        },
      };
      pushState(
        makeUiState([], { main: { kind: "starting" }, mode: "dialog", dialogs: [agentDialog] })
      );

      // The focus-follow lands focus on the selected (first) card — without this
      // the arrow-key handler never fires (nothing is focused).
      const claude = await screen.findByRole("radio", { name: /claude/i });
      await waitFor(() => expect(document.activeElement).toBe(claude));

      // ArrowDown moves the selection to opencode; Enter confirms it.
      await fireEvent.keyDown(claude, { key: "ArrowDown" });
      const opencode = screen.getByRole("radio", { name: /opencode/i });
      await waitFor(() => expect(opencode).toHaveAttribute("aria-checked", "true"));

      await fireEvent.keyDown(opencode, { key: "Enter" });
      expect(mockApi.sendDialogEvent).toHaveBeenCalledWith({
        dialogId: "dlg-sys",
        actionId: "continue",
        data: { agent: "opencode" },
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

  describe("mid-session loading keeps workspace iframes mounted", () => {
    it("shows the loading dialog over a surviving MainView (iframes not torn down)", async () => {
      const { container } = render(App);
      await waitFor(() => expect(mockApi.onState).toHaveBeenCalled());

      const wsA = ws("alpha");
      const creatingKey = "test-project-12345678/beta";
      const frames = { [wsA.key]: "http://127.0.0.1:25448/?workspace=alpha" };

      // First normal snapshot: one workspace active, its iframe mounted.
      pushState(
        makeUiState([makeUiProjectRow([{ ...wsA, active: true }])], {
          frames,
          main: { kind: "workspace", frameKey: wsA.key },
        })
      );

      let iframe: Element | null = null;
      await waitFor(() => {
        iframe = container.querySelector(`iframe[data-key="${wsA.key}"]`);
        expect(iframe).toBeInTheDocument();
      });
      expect(container.querySelector(".main-view")).toBeInTheDocument();

      // A new workspace is being created and becomes active: the presenter opens
      // a modal loading dialog and points main at the creating workspace, whose
      // frame is NOT in the snapshot yet (blank behind the dialog). The existing
      // workspace's frame stays in `frames`, so MainView must survive.
      const loadingDialog = {
        id: "dlg-loading-1",
        kind: "modal" as const,
        config: {
          sections: [
            {
              type: "progress" as const,
              style: "spinner" as const,
              items: [{ id: "status", label: "Loading workspace...", status: "running" as const }],
            },
          ],
        },
      };
      pushState(
        makeUiState([makeUiProjectRow([{ ...wsA, active: false }])], {
          frames,
          main: { kind: "workspace", frameKey: creatingKey },
          mode: "dialog",
          dialogs: [loadingDialog],
        })
      );

      // The loading dialog shows over the still-mounted MainView.
      await waitFor(() => {
        expect(screen.getByText("Loading workspace...")).toBeInTheDocument();
      });
      expect(container.querySelector(".main-view")).toBeInTheDocument();

      // The kept-alive frame is the same DOM node — no remount, no reload.
      const sameIframe = container.querySelector(`iframe[data-key="${wsA.key}"]`);
      expect(sameIframe).toBe(iframe);

      // Creation completes: the loading dialog closes, frame still the same.
      pushState(
        makeUiState([makeUiProjectRow([{ ...wsA, active: true }])], {
          frames,
          main: { kind: "workspace", frameKey: wsA.key },
        })
      );
      await waitFor(() => {
        expect(screen.queryByText("Loading workspace...")).not.toBeInTheDocument();
      });
      expect(container.querySelector(`iframe[data-key="${wsA.key}"]`)).toBe(iframe);
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
