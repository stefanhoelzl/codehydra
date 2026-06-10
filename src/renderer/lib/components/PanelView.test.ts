/**
 * Tests for PanelView component (the persistent panel surface).
 * Section/action rendering lives in Form.test.ts — these cover only the
 * panel shell: accessible name, Escape -> dismiss event, Cmd/Ctrl+Enter ->
 * primary action, the Tab trap at the panel boundaries, and the
 * dialogId-keyed Form remount (the reset gesture).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
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

  describe("Escape", () => {
    it("emits a dismiss event for the session", async () => {
      renderPanel(createConfig(), "panel-42");

      await fireEvent.keyDown(screen.getByRole("region", { name: "New Workspace" }), {
        key: "Escape",
      });

      expect(mockSendDialogEvent).toHaveBeenCalledWith({
        kind: "dismiss",
        dialogId: "panel-42",
      });
    });
  });

  describe("Cmd/Ctrl+Enter", () => {
    it("fires the primary action with the field-values snapshot", async () => {
      renderPanel(createConfig(), "panel-1");

      await fireEvent.keyDown(screen.getByRole("region", { name: "New Workspace" }), {
        key: "Enter",
        ctrlKey: true,
      });

      expect(mockSendDialogEvent).toHaveBeenCalledWith({
        dialogId: "panel-1",
        actionId: "create",
        data: { name: "" },
      });
    });

    it("plain Enter on the shell does not submit", async () => {
      renderPanel(createConfig());

      await fireEvent.keyDown(screen.getByRole("region", { name: "New Workspace" }), {
        key: "Enter",
      });

      expect(mockSendDialogEvent).not.toHaveBeenCalled();
    });

    it("does nothing when the config has no actions", async () => {
      renderPanel({
        layout: "form",
        sections: [{ type: "text", content: "New Workspace", style: "heading" }],
      });

      await fireEvent.keyDown(screen.getByRole("region", { name: "New Workspace" }), {
        key: "Enter",
        metaKey: true,
      });

      expect(mockSendDialogEvent).not.toHaveBeenCalled();
    });
  });

  describe("Tab trap", () => {
    // Multiline inputs render as native <textarea>s — focusable in happy-dom,
    // unlike the vscode-elements web components whose internals aren't wired.
    const trapConfig: DialogConfig = {
      layout: "form",
      sections: [
        { type: "text", content: "New Workspace", style: "heading" },
        { type: "input", id: "first", label: "First", multiline: true },
        { type: "input", id: "last", label: "Last", multiline: true },
      ],
    };

    function getTextareas(): [HTMLTextAreaElement, HTMLTextAreaElement] {
      const areas = document.querySelectorAll("textarea");
      return [areas[0] as HTMLTextAreaElement, areas[1] as HTMLTextAreaElement];
    }

    it("Tab on the last control wraps to the first", async () => {
      renderPanel(trapConfig);
      const [first, last] = getTextareas();

      last.focus();
      await fireEvent.keyDown(last, { key: "Tab" });

      expect(document.activeElement).toBe(first);
    });

    it("Shift+Tab on the first control wraps to the last", async () => {
      renderPanel(trapConfig);
      const [first, last] = getTextareas();

      first.focus();
      await fireEvent.keyDown(first, { key: "Tab", shiftKey: true });

      expect(document.activeElement).toBe(last);
    });

    it("Tab pulls focus back in when it sits outside the panel", async () => {
      renderPanel(trapConfig);
      const [first] = getTextareas();

      (document.activeElement as HTMLElement | null)?.blur();
      await fireEvent.keyDown(screen.getByRole("region", { name: "New Workspace" }), {
        key: "Tab",
      });

      expect(document.activeElement).toBe(first);
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
      await fireEvent.keyDown(screen.getByRole("region", { name: "New Workspace" }), {
        key: "Enter",
        ctrlKey: true,
      });
      expect(mockSendDialogEvent).toHaveBeenCalledWith(
        expect.objectContaining({ data: { note: "draft text" } })
      );
      mockSendDialogEvent.mockClear();

      // Backend reset: close + reopen arrives as a new dialogId.
      await rerender({ dialogId: "panel-2", config });

      await fireEvent.keyDown(screen.getByRole("region", { name: "New Workspace" }), {
        key: "Enter",
        ctrlKey: true,
      });
      expect(mockSendDialogEvent).toHaveBeenCalledWith(
        expect.objectContaining({ dialogId: "panel-2", data: { note: "" } })
      );
    });
  });
});
