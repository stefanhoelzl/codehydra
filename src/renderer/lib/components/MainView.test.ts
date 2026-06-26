// @vitest-environment-options {"settings": {"disableIframePageLoading": true}}
/**
 * Tests for the MainView component.
 *
 * Since the read cutover MainView is a render function over the UiState
 * snapshot (the `uiState` store, fed by App.svelte's onState subscription).
 * Tests seed the store directly via setUiState and assert the rendered
 * result. The view-model semantics themselves (placeholders, deletion
 * lifecycle, active fallback, ground-state panel) are covered by the
 * presenter's integration tests in
 * src/modules/presentation-module.integration.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/svelte";
import { flushSync } from "svelte";
import type { UiState } from "@shared/ui-state";

const { mockApi } = vi.hoisted(() => {
  return {
    mockApi: {
      emitEvent: vi.fn(),
      lifecycle: {
        quit: vi.fn().mockResolvedValue(undefined),
      },
      on: vi.fn(() => vi.fn()),
      onState: vi.fn(() => vi.fn()),
      sendDialogEvent: vi.fn(),
      sendNotificationEvent: vi.fn(),
    },
  };
});

vi.mock("$lib/api", () => mockApi);

// Import after mock setup
import MainView from "./MainView.svelte";
import { uiState, resetUiState, setUiState } from "$lib/stores/ui-state.svelte.js";
import { makeUiState, makeUiProjectRow, makeUiWorkspaceRow } from "$lib/test-utils";

/**
 * Seed the snapshot store directly (App.svelte owns the onState subscription;
 * MainView reads the resulting `uiState` store).
 */
function pushState(state: UiState): void {
  setUiState(state);
}

/** Render MainView. The store can be seeded before or after via pushState. */
async function renderMainView(): Promise<{ container: HTMLElement }> {
  const { container } = render(MainView);
  return { container };
}

/** Simulate the backend creation module's always-alive panel session by adding
 *  a panel-surface dialog to the current snapshot. */
function openCreationPanelSession(dialogId = "dlg-creation-1"): void {
  const current = uiState.value ?? makeUiState([]);
  setUiState({
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

const WS1 = makeUiWorkspaceRow("feature-1");
const WS1_ACTIVE = { ...WS1, active: true };
const PROJECT = makeUiProjectRow([WS1]);

describe("MainView component", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetUiState();
  });

  afterEach(() => {
    document.body.innerHTML = "";
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
      pushState(makeUiState([PROJECT], { main: { kind: "creation" } }));
      openCreationPanelSession();

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
    it("clicking a workspace emits the switch-workspace ui:event without eager local state", async () => {
      await renderMainView();
      pushState(makeUiState([PROJECT]));
      await waitFor(() => expect(screen.getByText("feature-1")).toBeInTheDocument());

      await fireEvent.click(screen.getByRole("button", { name: "feature-1" }));

      expect(mockApi.emitEvent).toHaveBeenCalledWith({
        kind: "switch-workspace",
        key: WS1.key,
      });
      // No local mutation: the row stays inactive until a push says otherwise.
      const item = screen.getByText("feature-1").closest("li");
      expect(item).not.toHaveAttribute("aria-current");
    });

    it("the New workspace entry deselects (switch-workspace key null)", async () => {
      await renderMainView();
      pushState(
        makeUiState([makeUiProjectRow([WS1_ACTIVE])], {
          main: { kind: "workspace", frameKey: WS1.key },
        })
      );
      await waitFor(() => expect(screen.getByText("feature-1")).toBeInTheDocument());

      await fireEvent.click(screen.getByRole("button", { name: /new workspace/i }));

      expect(mockApi.emitEvent).toHaveBeenCalledWith({ kind: "switch-workspace", key: null });
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

  describe("fresh-form dismiss on panel show", () => {
    it("sends one dismiss per show transition once the session exists", async () => {
      await renderMainView();
      pushState(makeUiState([PROJECT], { main: { kind: "creation" } }));
      openCreationPanelSession("dlg-1");
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
      openCreationPanelSession("dlg-1");

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
});
