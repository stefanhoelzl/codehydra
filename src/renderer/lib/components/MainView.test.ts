// @vitest-environment-options {"settings": {"disableIframePageLoading": true}}
/**
 * Tests for the MainView component.
 *
 * Since the read cutover MainView is a render function over the UiState
 * snapshot: tests push snapshots through the captured onState callback
 * (wired by initializeApp on mount) and assert the rendered result. The
 * view-model semantics themselves (placeholders, deletion lifecycle, active
 * fallback, ground-state panel) are covered by the presenter's integration
 * tests in src/modules/presentation-module.integration.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/svelte";
import { flushSync } from "svelte";
import type { UiState } from "@shared/ui-state";

type StateCallback = (state: UiState) => void;
const { mockApi, stateCallbacks } = vi.hoisted(() => {
  const stateCallbacks: Array<(state: unknown) => void> = [];
  return {
    stateCallbacks,
    mockApi: {
      emitEvent: vi.fn(),
      projects: {
        open: vi.fn().mockResolvedValue(undefined),
      },
      workspaces: {
        hibernate: vi.fn().mockResolvedValue({ started: true }),
        wake: vi.fn().mockResolvedValue(null),
      },
      ui: {
        switchWorkspace: vi.fn().mockResolvedValue(undefined),
        setMode: vi.fn().mockResolvedValue(undefined),
      },
      lifecycle: {
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

vi.mock("$lib/api", () => mockApi);

// Import after mock setup
import MainView from "./MainView.svelte";
import * as shortcutsStore from "$lib/stores/shortcuts.svelte.js";
import * as dialogFrameworkStore from "$lib/stores/dialog-framework.svelte.js";
import { resetUiState } from "$lib/stores/ui-state.svelte.js";
import { makeUiState, makeUiProjectRow, makeUiWorkspaceRow } from "$lib/test-utils";

/** Deliver a snapshot through the captured onState callback (real holder). */
function pushState(state: UiState): void {
  expect(stateCallbacks.length).toBeGreaterThan(0);
  for (const callback of stateCallbacks as StateCallback[]) {
    callback(state);
  }
}

/** Render MainView and wait for initializeApp to subscribe. */
async function renderMainView(): Promise<{ container: HTMLElement }> {
  const { container } = render(MainView);
  await waitFor(() => expect(mockApi.onState).toHaveBeenCalled());
  return { container };
}

/** Simulate the backend creation module's always-alive panel session. */
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

const WS1 = makeUiWorkspaceRow("feature-1");
const WS1_ACTIVE = { ...WS1, active: true };
const PROJECT = makeUiProjectRow([WS1]);

describe("MainView component", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateCallbacks.length = 0;
    resetUiState();
    shortcutsStore.reset();
    dialogFrameworkStore.reset();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  describe("initialization", () => {
    it("subscribes to ui:state and emits ui-connected on mount", async () => {
      await renderMainView();

      expect(mockApi.onState).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(mockApi.emitEvent).toHaveBeenCalledWith({ kind: "ui-connected" }));
    });
  });

  describe("rendering from the snapshot", () => {
    it("renders main-view container, Sidebar, and frames region", async () => {
      const { container } = await renderMainView();

      expect(container.querySelector(".main-view")).toBeInTheDocument();
      expect(screen.getByRole("navigation", { name: "Projects" })).toBeInTheDocument();
      expect(container.querySelector(".workspace-frames")).toBeInTheDocument();
    });

    it("renders sidebar rows from a pushed snapshot", async () => {
      await renderMainView();

      pushState(makeUiState([PROJECT]));

      await waitFor(() => {
        expect(screen.getByText("feature-1")).toBeInTheDocument();
        expect(screen.getByText("test-project")).toBeInTheDocument();
      });
    });

    it("mounts iframes from the snapshot frames region with the active one visible", async () => {
      const { container } = await renderMainView();

      pushState(
        makeUiState([makeUiProjectRow([WS1_ACTIVE])], {
          frames: { [WS1.key]: "http://127.0.0.1:9000/?folder=/ws" },
          main: { kind: "workspace", frameKey: WS1.key },
        })
      );

      await waitFor(() => {
        const iframe = container.querySelector("iframe");
        expect(iframe).toBeInTheDocument();
        expect(iframe).toHaveClass("active");
        expect(iframe!.title).toBe("Workspace feature-1");
      });
    });

    it("renders the creation panel when main is creation and the session exists", async () => {
      const { container } = await renderMainView();
      openCreationPanelSession();

      pushState(makeUiState([PROJECT], { main: { kind: "creation" } }));

      await waitFor(() => {
        expect(container.querySelector(".panel-view")).toBeInTheDocument();
      });
    });

    it("renders no panel when main is creation but the session has not arrived", async () => {
      const { container } = await renderMainView();

      pushState(makeUiState([PROJECT], { main: { kind: "creation" } }));

      await waitFor(() => {
        expect(screen.getByText("feature-1")).toBeInTheDocument();
      });
      expect(container.querySelector(".panel-view")).not.toBeInTheDocument();
    });

    it("renders the HibernatedOverlay with the snapshot's inline screenshot", async () => {
      const { container } = await renderMainView();

      pushState(
        makeUiState([makeUiProjectRow([{ ...WS1_ACTIVE, hibernated: true }])], {
          main: { kind: "hibernated", screenshot: "data:image/png;base64,UE5H" },
        })
      );

      await waitFor(() => {
        const overlay = container.querySelector(".hibernated-overlay");
        expect(overlay).toBeInTheDocument();
        const img = overlay!.querySelector<HTMLImageElement>("img.screenshot");
        expect(img?.src).toBe("data:image/png;base64,UE5H");
      });
    });
  });

  describe("actions", () => {
    it("clicking a workspace invokes switchWorkspace without eager local state", async () => {
      await renderMainView();
      pushState(makeUiState([PROJECT]));
      await waitFor(() => expect(screen.getByText("feature-1")).toBeInTheDocument());

      await fireEvent.click(screen.getByRole("button", { name: "feature-1" }));

      expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith(WS1.path);
      // No local mutation: the row stays inactive until a push says otherwise.
      const item = screen.getByText("feature-1").closest("li");
      expect(item).not.toHaveAttribute("aria-current");
    });

    it("the New workspace entry deselects (switchWorkspace null)", async () => {
      await renderMainView();
      pushState(
        makeUiState([makeUiProjectRow([WS1_ACTIVE])], {
          main: { kind: "workspace", frameKey: WS1.key },
        })
      );
      await waitFor(() => expect(screen.getByText("feature-1")).toBeInTheDocument());

      await fireEvent.click(screen.getByRole("button", { name: /new workspace/i }));

      expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith(null);
    });

    it("close-project emits the close-project ui:event (dialog opens main-side)", async () => {
      await renderMainView();
      pushState(makeUiState([PROJECT]));
      await waitFor(() => expect(screen.getByText("test-project")).toBeInTheDocument());

      await fireEvent.click(screen.getByLabelText(/close project/i));

      expect(mockApi.emitEvent).toHaveBeenCalledWith({
        kind: "close-project",
        projectId: PROJECT.id,
      });
    });

    it("the workspace remove button emits the remove-workspace ui:event", async () => {
      await renderMainView();
      pushState(makeUiState([PROJECT]));
      await waitFor(() => expect(screen.getByText("feature-1")).toBeInTheDocument());

      await fireEvent.click(screen.getByRole("button", { name: "Remove workspace" }));

      expect(mockApi.emitEvent).toHaveBeenCalledWith({
        kind: "remove-workspace",
        key: WS1.key,
      });
    });
  });

  describe("ui-mode sync", () => {
    it("pushes hover mode while the creation panel is the main view", async () => {
      await renderMainView();

      pushState(makeUiState([PROJECT], { main: { kind: "creation" } }));

      await waitFor(() => {
        expect(mockApi.ui.setMode).toHaveBeenCalledWith("hover");
      });
    });

    it("pushes dialog mode when a modal framework dialog opens and workspace mode when it closes", async () => {
      await renderMainView();
      pushState(
        makeUiState([makeUiProjectRow([WS1_ACTIVE])], {
          main: { kind: "workspace", frameKey: WS1.key },
        })
      );

      dialogFrameworkStore.processCommand({
        action: "open",
        dialogId: "dlg-confirm-1",
        config: {
          modal: true,
          sections: [{ type: "text", content: "Remove Workspace", style: "heading" }],
        },
      });
      await waitFor(() => {
        expect(mockApi.ui.setMode).toHaveBeenCalledWith("dialog");
      });

      dialogFrameworkStore.processCommand({ action: "close", dialogId: "dlg-confirm-1" });
      await waitFor(() => {
        expect(mockApi.ui.setMode).toHaveBeenCalledWith("workspace");
      });
    });
  });

  describe("fresh-form dismiss on panel show", () => {
    it("sends one dismiss per show transition once the session exists", async () => {
      await renderMainView();
      openCreationPanelSession("dlg-1");

      pushState(makeUiState([PROJECT], { main: { kind: "creation" } }));
      await waitFor(() => {
        expect(mockApi.sendDialogEvent).toHaveBeenCalledWith({
          kind: "dismiss",
          dialogId: "dlg-1",
        });
      });
      expect(mockApi.sendDialogEvent).toHaveBeenCalledTimes(1);

      // Leaving and returning re-sends (new show transition). Flush between
      // pushes so the effect observes the intermediate workspace state.
      pushState(
        makeUiState([makeUiProjectRow([WS1_ACTIVE])], {
          main: { kind: "workspace", frameKey: WS1.key },
        })
      );
      flushSync();
      pushState(makeUiState([PROJECT], { main: { kind: "creation" } }));

      await waitFor(() => {
        expect(mockApi.sendDialogEvent).toHaveBeenCalledTimes(2);
      });
    });

    it("covers the startup race: snapshot shows the panel before the session arrives", async () => {
      await renderMainView();

      pushState(makeUiState([PROJECT], { main: { kind: "creation" } }));
      expect(mockApi.sendDialogEvent).not.toHaveBeenCalled();

      openCreationPanelSession("dlg-late");

      await waitFor(() => {
        expect(mockApi.sendDialogEvent).toHaveBeenCalledWith({
          kind: "dismiss",
          dialogId: "dlg-late",
        });
      });
    });
  });

  describe("modal sweep on panel show", () => {
    it("closes modal framework dialogs at the moment the panel is shown", async () => {
      await renderMainView();

      // A modal dialog (e.g. "Loading workspace...") is open while the
      // main view shows a workspace.
      pushState(
        makeUiState([makeUiProjectRow([WS1_ACTIVE])], {
          main: { kind: "workspace", frameKey: WS1.key },
        })
      );
      dialogFrameworkStore.processCommand({
        action: "open",
        dialogId: "dlg-modal",
        config: { layout: "form", modal: true, sections: [] },
        surface: "modal",
      });
      expect(dialogFrameworkStore.dialogs.value.size).toBe(1);

      // The panel becomes the main view → modal dialogs are swept.
      pushState(makeUiState([PROJECT], { main: { kind: "creation" } }));

      await waitFor(() => {
        expect(dialogFrameworkStore.dialogs.value.size).toBe(0);
      });
    });

    it("keeps modal dialogs opened while the panel is already shown", async () => {
      await renderMainView();

      pushState(makeUiState([PROJECT], { main: { kind: "creation" } }));
      await waitFor(() => {
        expect(mockApi.ui.setMode).toHaveBeenCalledWith("hover");
      });

      // e.g. the creation module's git-clone sub-dialog
      dialogFrameworkStore.processCommand({
        action: "open",
        dialogId: "dlg-clone",
        config: { layout: "form", modal: true, sections: [] },
        surface: "modal",
      });

      // Still open: the sweep is transition-based, not continuous.
      expect(dialogFrameworkStore.dialogs.value.size).toBe(1);
    });
  });
});
