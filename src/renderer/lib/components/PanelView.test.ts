/**
 * Tests for PanelView component (the persistent panel surface).
 * Section/action rendering and the keyboard contract (Escape, Cmd/Ctrl+Enter,
 * Tab trap) live in Form.test.ts — these cover only the panel shell:
 * accessible name, the dialogId-keyed Form remount (the reset gesture), and
 * refocusing the form when the last modal stacked above the panel closes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/svelte";
import type { DialogConfig } from "@shared/dialog-types";

// Mock setup - must be hoisted
const { mockSendDialogEvent } = vi.hoisted(() => ({
  mockSendDialogEvent: vi.fn(),
}));

vi.mock("$lib/api", () => ({
  sendDialogEvent: mockSendDialogEvent,
  on: vi.fn(() => vi.fn()),
}));

// Import after mock setup
import PanelView from "./PanelView.svelte";

function createConfig(overrides?: Partial<DialogConfig>): DialogConfig {
  return {
    layout: "form",
    sections: [
      { type: "text", content: "New Workspace", style: "heading" },
      { type: "input", id: "name", label: "Name" },
      {
        type: "group",
        items: [
          { type: "button", id: "cancel", label: "Cancel", variant: "secondary" },
          { type: "button", id: "create", label: "Create", variant: "primary" },
        ],
      },
    ],
    ...overrides,
  };
}

function renderPanel(
  config: DialogConfig,
  dialogId = "panel-1",
  modalAbove = false,
  kind: "modeless" | "panel" = "modeless"
) {
  return render(PanelView, { props: { dialogId, config, kind, modalAbove } });
}

describe("PanelView component (panel surface)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders sections through the wrapped Form", () => {
    renderPanel(createConfig());

    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent("New Workspace");
  });

  describe("accessibility", () => {
    it("panel is a region named after the heading", () => {
      renderPanel(createConfig());

      expect(screen.getByRole("region", { name: "New Workspace" })).toBeInTheDocument();
    });

    it("accessible name falls back to 'Panel' when no heading", () => {
      renderPanel(createConfig({ sections: [{ type: "text", content: "Just text" }] }));

      expect(screen.getByRole("region", { name: "Panel" })).toBeInTheDocument();
    });
  });

  describe("refocus on modal close", () => {
    // A multiline autofocus input renders as a native <textarea> with
    // data-autofocus — focusable in happy-dom, unlike vscode-elements.
    const autofocusConfig = createConfig({
      sections: [
        { type: "text", content: "New Workspace", style: "heading" },
        { type: "input", id: "note", label: "Note", multiline: true, autofocus: true },
      ],
    });

    it("re-places focus on the autofocus control when the last modal above closes", async () => {
      const { rerender } = renderPanel(autofocusConfig, "panel-1", false);
      const textarea = document.querySelector("textarea")!;
      await waitFor(() => expect(document.activeElement).toBe(textarea));

      // A modal opens above the panel and takes focus elsewhere.
      await rerender({ dialogId: "panel-1", config: autofocusConfig, modalAbove: true });
      textarea.blur();
      await waitFor(() => expect(document.activeElement).not.toBe(textarea));

      // Modal closes — the panel is the active surface again.
      await rerender({ dialogId: "panel-1", config: autofocusConfig, modalAbove: false });

      await waitFor(() => expect(document.activeElement).toBe(textarea));
    });

    it("a modal opening above does not disturb existing panel focus", async () => {
      const { rerender } = renderPanel(autofocusConfig, "panel-1", false);
      const textarea = document.querySelector("textarea")!;
      await waitFor(() => expect(document.activeElement).toBe(textarea));

      // A modal opens above (modalAbove false→true). The refocus gate fires
      // only on the true→false close, so focus is left exactly where it is.
      await rerender({ dialogId: "panel-1", config: autofocusConfig, modalAbove: true });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(document.activeElement).toBe(textarea);
    });
  });

  describe("reset gesture (close + reopen = new dialogId)", () => {
    it("remounts Form when the dialogId changes, dropping field values", async () => {
      const config = createConfig({
        sections: [
          { type: "text", content: "New Workspace", style: "heading" },
          { type: "input", id: "note", label: "Note", multiline: true },
          {
            type: "group",
            items: [
              { type: "button", id: "cancel", label: "Cancel", variant: "secondary" },
              { type: "button", id: "create", label: "Create", variant: "primary" },
            ],
          },
        ],
      });
      const { rerender } = renderPanel(config, "panel-1");

      const textarea = document.querySelector("textarea")!;
      await fireEvent.input(textarea, { target: { value: "draft text" } });
      await fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });
      expect(mockSendDialogEvent).toHaveBeenCalledWith(
        expect.objectContaining({ data: { note: "draft text" } })
      );
      mockSendDialogEvent.mockClear();

      // Backend reset: close + reopen arrives as a new dialogId.
      await rerender({ dialogId: "panel-2", config });

      await fireEvent.keyDown(document.querySelector("textarea")!, { key: "Enter", ctrlKey: true });
      expect(mockSendDialogEvent).toHaveBeenCalledWith(
        expect.objectContaining({ dialogId: "panel-2", data: { note: "" } })
      );
    });
  });

  // When the owning dialog leaves the ui:state snapshot, MainView's
  // `xDialog?.config` getter yields `undefined` for the frame between the
  // dialog disappearing and this component being destroyed. Dereferencing it
  // (the old `config.sections` / non-null props) threw a TypeError that the
  // main-process crash guard reported and — until fixed — force-quit the app.
  describe("teardown tolerance (dialog leaves the snapshot mid-flush)", () => {
    it("renders only the shell, no Form, when config/dialogId are undefined", () => {
      expect(() =>
        render(PanelView, {
          props: { dialogId: undefined, config: undefined, kind: "modeless", modalAbove: false },
        })
      ).not.toThrow();

      expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
      expect(document.querySelector("textarea")).toBeNull();
      // Heading derivation short-circuits to the default accessible name.
      expect(screen.getByRole("region", { name: "Panel" })).toBeInTheDocument();
    });

    it("survives config/dialogId going undefined on the teardown flush", async () => {
      const { rerender } = renderPanel(createConfig(), "panel-1");
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("New Workspace");

      // The teardown frame: no throw, and the Form is torn down.
      await rerender({
        dialogId: undefined,
        config: undefined,
        kind: "modeless",
        modalAbove: false,
      });

      expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
    });
  });
});
