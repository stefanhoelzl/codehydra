/**
 * Tests for the MainView component.
 *
 * Since the read cutover MainView is a pure render function over the UiState
 * snapshot, passed in as the `ui` prop (App.svelte owns the onState
 * subscription and hands MainView the snapshot). Tests render with a snapshot
 * prop and drive updates via rerender. The view-model semantics themselves
 * (placeholders, deletion lifecycle, active fallback, ground-state panel) are
 * covered by the presenter's integration tests in
 * src/modules/presentation-module.integration.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/svelte";
import type { UiState } from "@shared/ui-state";
import type { DialogSection } from "@shared/dialog-types";

// Shared fake: src/renderer/lib/api/__mocks__/index.ts
vi.mock("$lib/api");

import * as api from "$lib/api";

const mockApi = vi.mocked(api);

// Import after mock setup
import MainView from "./MainView.svelte";
import { makeUiState, makeUiProjectRow, makeUiWorkspaceRow } from "$lib/test-utils";

/** The snapshot currently rendered; updated by pushState/openCreationPanelSession. */
let current: UiState;
let rerenderView: (props: { ui: UiState }) => Promise<void>;

/** Render MainView with an initial snapshot (App only mounts it post-genesis). */
function renderMainView(initial: UiState = makeUiState([])): { container: HTMLElement } {
  current = initial;
  const result = render(MainView, { props: { ui: current } });
  rerenderView = result.rerender;
  return { container: result.container };
}

/** Push a new snapshot (replaces the `ui` prop, as App's onState would). */
function pushState(state: UiState): Promise<void> {
  current = state;
  return rerenderView({ ui: current });
}

/** Simulate the backend creation module's always-alive session by adding
 *  a "modeless" dialog to the current snapshot. */
function openCreationPanelSession(
  dialogId = "dlg-creation-1",
  extraSections: DialogSection[] = []
): Promise<void> {
  current = {
    ...current,
    dialogs: [
      ...current.dialogs,
      {
        id: dialogId,
        kind: "modeless",
        config: {
          layout: "form",
          sections: [
            { type: "text", content: "New workspace", style: "heading" },
            ...extraSections,
          ],
        },
      },
    ],
  };
  return rerenderView({ ui: current });
}

/** The creation form's Prompt field, as the module declares it. */
function promptSection(initialValue: string): DialogSection {
  return {
    type: "input",
    id: "prompt",
    label: "Prompt",
    multiline: true,
    rows: 3,
    initialValue,
    changeEvent: true,
  };
}

const WS1 = makeUiWorkspaceRow("feature-1");
const WS1_ACTIVE = { ...WS1, active: true };
const PROJECT = makeUiProjectRow([WS1]);

describe("MainView component", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  describe("rendering from the snapshot", () => {
    it("renders main-view container, Sidebar, and frames region", async () => {
      const { container } = renderMainView();

      expect(container.querySelector(".main-view")).toBeInTheDocument();
      expect(screen.getByRole("navigation", { name: "Projects" })).toBeInTheDocument();
      expect(container.querySelector(".workspace-frames")).toBeInTheDocument();
    });

    it("renders sidebar rows from a pushed snapshot", async () => {
      renderMainView();

      await pushState(makeUiState([PROJECT]));

      await waitFor(() => {
        expect(screen.getByText("feature-1")).toBeInTheDocument();
        expect(screen.getByText("test-project")).toBeInTheDocument();
      });
    });

    it("mounts iframes from the snapshot frames region with the active one visible", async () => {
      const { container } = renderMainView();

      await pushState(
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
      const { container } = renderMainView();
      await pushState(makeUiState([PROJECT], { main: { kind: "creation" } }));
      await openCreationPanelSession();

      await waitFor(() => {
        expect(container.querySelector(".panel-view")).toBeInTheDocument();
      });
    });

    it("renders no panel when main is creation but the session has not arrived", async () => {
      const { container } = renderMainView();

      await pushState(makeUiState([PROJECT], { main: { kind: "creation" } }));

      await waitFor(() => {
        expect(screen.getByText("feature-1")).toBeInTheDocument();
      });
      expect(container.querySelector(".panel-view")).not.toBeInTheDocument();
    });

    it("renders the HibernatedOverlay with the snapshot's inline screenshot", async () => {
      const { container } = renderMainView();

      await pushState(
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
      renderMainView();
      await pushState(makeUiState([PROJECT]));
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
      renderMainView();
      await pushState(
        makeUiState([makeUiProjectRow([WS1_ACTIVE])], {
          main: { kind: "workspace", frameKey: WS1.key },
        })
      );
      await waitFor(() => expect(screen.getByText("feature-1")).toBeInTheDocument());

      await fireEvent.click(screen.getByRole("button", { name: /new workspace/i }));

      expect(mockApi.emitEvent).toHaveBeenCalledWith({ kind: "switch-workspace", key: null });
    });

    it("close-project emits the close-project ui:event (dialog opens main-side)", async () => {
      renderMainView();
      await pushState(makeUiState([PROJECT]));
      await waitFor(() => expect(screen.getByText("test-project")).toBeInTheDocument());

      await fireEvent.click(screen.getByLabelText(/close project/i));

      expect(mockApi.emitEvent).toHaveBeenCalledWith({
        kind: "close-project",
        projectId: PROJECT.id,
      });
    });

    it("the workspace remove button emits the remove-workspace ui:event", async () => {
      renderMainView();
      await pushState(makeUiState([PROJECT]));
      await waitFor(() => expect(screen.getByText("feature-1")).toBeInTheDocument());

      await fireEvent.click(screen.getByRole("button", { name: "Remove workspace" }));

      expect(mockApi.emitEvent).toHaveBeenCalledWith({
        kind: "remove-workspace",
        key: WS1.key,
      });
    });
  });

  describe("creation form survives a panel hide/show", () => {
    /** The live Prompt textarea in the currently mounted panel. */
    function promptField(): HTMLTextAreaElement {
      const node = document.querySelector<HTMLTextAreaElement>("textarea#prompt");
      expect(node, "prompt field").not.toBeNull();
      return node!;
    }

    /** Hide the panel (workspace view) and bring it back, as a switch does. */
    async function hideAndShow(dialogId: string, sections: DialogSection[]): Promise<void> {
      await pushState(
        makeUiState([makeUiProjectRow([WS1_ACTIVE])], {
          main: { kind: "workspace", frameKey: WS1.key },
        })
      );
      await pushState(makeUiState([PROJECT], { main: { kind: "creation" } }));
      await openCreationPanelSession(dialogId, sections);
    }

    it("restores the remembered text through a real unmount/remount", async () => {
      renderMainView();
      await pushState(makeUiState([PROJECT], { main: { kind: "creation" } }));
      await openCreationPanelSession("dlg-1", [promptSection("")]);

      // vscode-label is a custom element, so getByLabelText cannot see it.
      const prompt = promptField();
      await fireEvent.input(prompt, { target: { value: "do the thing" } });
      expect(prompt.value).toBe("do the thing");

      // MainView mounts the panel under {#if}, so hiding it destroys the Form
      // and every value it held. Only the config the module pushed survives —
      // which is why the module tracks each field and seeds it back.
      await hideAndShow("dlg-1", [promptSection("do the thing")]);

      expect(promptField().value).toBe("do the thing");
    });

    it("comes back blank when the module has nothing to seed", async () => {
      renderMainView();
      await pushState(makeUiState([PROJECT], { main: { kind: "creation" } }));
      await openCreationPanelSession("dlg-1", [promptSection("")]);

      await fireEvent.input(promptField(), { target: { value: "typed but not tracked" } });

      // The negative control for the test above: the restore comes from the
      // pushed config, never from the DOM surviving on its own.
      await hideAndShow("dlg-1", [promptSection("")]);

      expect(promptField().value).toBe("");
    });
  });

  describe("no fresh-form dismiss on panel show", () => {
    it("does not reset the form when the panel is shown", async () => {
      renderMainView();
      await pushState(makeUiState([PROJECT], { main: { kind: "creation" } }));
      await openCreationPanelSession("dlg-1");

      // The creation form remembers what was typed across a close/reopen, so
      // showing the panel must NOT send the dismiss that resets the session.
      expect(mockApi.sendDialogEvent).not.toHaveBeenCalled();
    });

    it("does not reset when leaving and returning to the panel", async () => {
      renderMainView();
      await pushState(makeUiState([PROJECT], { main: { kind: "creation" } }));
      await openCreationPanelSession("dlg-1");

      await pushState(
        makeUiState([makeUiProjectRow([WS1_ACTIVE])], {
          main: { kind: "workspace", frameKey: WS1.key },
        })
      );
      await pushState(makeUiState([PROJECT], { main: { kind: "creation" } }));
      await openCreationPanelSession("dlg-1");

      expect(mockApi.sendDialogEvent).not.toHaveBeenCalled();
    });

    it("does not reset when the session arrives after the panel is shown", async () => {
      renderMainView();

      await pushState(makeUiState([PROJECT], { main: { kind: "creation" } }));
      expect(mockApi.sendDialogEvent).not.toHaveBeenCalled();

      await openCreationPanelSession("dlg-late");

      expect(mockApi.sendDialogEvent).not.toHaveBeenCalled();
    });
  });
});
