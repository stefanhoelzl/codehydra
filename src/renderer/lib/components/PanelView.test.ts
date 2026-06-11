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
  onModeChange: vi.fn(() => vi.fn()),
  onShortcut: vi.fn(() => vi.fn()),
}));

// Import after mock setup
import PanelView from "./PanelView.svelte";
import { processCommand, reset as resetDialogs } from "$lib/stores/dialog-framework.svelte";

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

function renderPanel(config: DialogConfig, dialogId = "panel-1") {
  return render(PanelView, { props: { dialogId, config } });
}

describe("PanelView component (panel surface)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDialogs();
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
      renderPanel(autofocusConfig);
      const textarea = document.querySelector("textarea")!;
      await waitFor(() => expect(document.activeElement).toBe(textarea));

      // A modal opens above the panel and takes focus elsewhere.
      processCommand({ action: "open", dialogId: "modal-1", config: { sections: [] } });
      textarea.blur();
      await waitFor(() => expect(document.activeElement).not.toBe(textarea));

      // Modal closes — the panel is the active surface again.
      processCommand({ action: "close", dialogId: "modal-1" });

      await waitFor(() => expect(document.activeElement).toBe(textarea));
    });

    it("does not refocus while a modal is still open above", async () => {
      renderPanel(autofocusConfig);
      const textarea = document.querySelector("textarea")!;
      await waitFor(() => expect(document.activeElement).toBe(textarea));

      processCommand({ action: "open", dialogId: "modal-1", config: { sections: [] } });
      processCommand({ action: "open", dialogId: "modal-2", config: { sections: [] } });
      textarea.blur();

      // Only one of the two modals closes.
      processCommand({ action: "close", dialogId: "modal-1" });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(document.activeElement).not.toBe(textarea);
    });

    it("a panel-surface session does not count as a modal above", async () => {
      renderPanel(autofocusConfig);
      const textarea = document.querySelector("textarea")!;
      await waitFor(() => expect(document.activeElement).toBe(textarea));

      processCommand({
        action: "open",
        dialogId: "panel-x",
        config: { sections: [] },
        surface: "panel",
      });
      textarea.blur();
      processCommand({ action: "close", dialogId: "panel-x" });
      await new Promise((resolve) => setTimeout(resolve, 10));

      // No modal ever closed above the panel — focus is left alone.
      expect(document.activeElement).not.toBe(textarea);
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
});
