/**
 * Tests for DialogView component (the modal surface).
 * Section/action rendering lives in Form.test.ts — these cover only the
 * modal chrome: the dialog role + aria-label, the backdrop, the workspace-area
 * offset, and that sections render through the wrapped <Form>.
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
import DialogView from "./DialogView.svelte";

/** Helper to render DialogView with a config. */
function renderDialog(
  config: DialogConfig,
  options?: { dialogId?: string; workspaceArea?: boolean }
) {
  return render(DialogView, {
    props: {
      dialogId: options?.dialogId ?? "test-dialog",
      config,
      workspaceArea: options?.workspaceArea ?? false,
    },
  });
}

describe("DialogView component (modal surface)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders sections through the wrapped Form", () => {
    const config: DialogConfig = {
      sections: [{ type: "text", content: "My Heading", style: "heading" }],
    };

    renderDialog(config);

    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent("My Heading");
  });

  describe("accessibility", () => {
    it("dialog has role='dialog'", () => {
      const config: DialogConfig = {
        sections: [{ type: "text", content: "Hello", style: "heading" }],
      };

      renderDialog(config);

      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it("dialog aria-label uses heading text", () => {
      const config: DialogConfig = {
        sections: [{ type: "text", content: "Update Available", style: "heading" }],
      };

      renderDialog(config);

      const dialog = screen.getByRole("dialog");
      expect(dialog).toHaveAttribute("aria-label", "Update Available");
    });

    it("dialog aria-label falls back to 'Dialog' when no heading", () => {
      const config: DialogConfig = {
        sections: [{ type: "text", content: "Just a paragraph" }],
      };

      renderDialog(config);

      const dialog = screen.getByRole("dialog");
      expect(dialog).toHaveAttribute("aria-label", "Dialog");
    });

    it("backdrop has aria-hidden='true'", () => {
      const config: DialogConfig = {
        sections: [{ type: "text", content: "Test", style: "heading" }],
      };

      renderDialog(config);

      const backdrop = document.querySelector(".backdrop");
      expect(backdrop).toBeInTheDocument();
      expect(backdrop).toHaveAttribute("aria-hidden", "true");
    });
  });

  describe("workspace area offset", () => {
    it("adds the workspace-area class when workspaceArea is true", () => {
      const config: DialogConfig = {
        sections: [{ type: "text", content: "Test", style: "heading" }],
      };

      renderDialog(config, { workspaceArea: true });

      expect(document.querySelector(".dialog-view.workspace-area")).toBeInTheDocument();
    });

    it("omits the workspace-area class by default", () => {
      const config: DialogConfig = {
        sections: [{ type: "text", content: "Test", style: "heading" }],
      };

      renderDialog(config);

      expect(document.querySelector(".dialog-view")).toBeInTheDocument();
      expect(document.querySelector(".dialog-view.workspace-area")).not.toBeInTheDocument();
    });
  });

  describe("keyboard (owned by the wrapped Form)", () => {
    const config: DialogConfig = {
      sections: [
        { type: "text", content: "Clone from Git Repository", style: "heading" },
        { type: "input", id: "url" },
        {
          type: "group",
          items: [
            { type: "button", id: "do-clone", label: "Clone", variant: "primary" },
            { type: "button", id: "cancel", label: "Cancel", variant: "secondary" },
          ],
        },
      ],
    };

    it("Escape emits a dismiss event for the modal session", async () => {
      renderDialog(config, { dialogId: "clone-1" });

      await fireEvent.keyDown(document.querySelector(".form")!, { key: "Escape" });

      expect(mockSendDialogEvent).toHaveBeenCalledWith({ kind: "dismiss", dialogId: "clone-1" });
    });

    it("Cmd/Ctrl+Enter fires the primary action", async () => {
      renderDialog(config, { dialogId: "clone-1" });

      await fireEvent.keyDown(document.querySelector(".form")!, { key: "Enter", metaKey: true });

      expect(mockSendDialogEvent).toHaveBeenCalledWith({
        dialogId: "clone-1",
        actionId: "do-clone",
        data: { url: "" },
      });
    });
  });

  describe("tab trap", () => {
    const config: DialogConfig = {
      sections: [
        { type: "input", id: "url" },
        {
          type: "group",
          items: [
            { type: "button", id: "ok", label: "OK", variant: "primary" },
            { type: "button", id: "cancel", label: "Cancel" },
          ],
        },
      ],
    };

    it("Tab on the last focusable wraps to the first", async () => {
      renderDialog(config);

      const focusables = Array.from(
        document.querySelectorAll<HTMLElement>("vscode-textfield, vscode-button")
      );
      const last = focusables[focusables.length - 1]!;
      last.focus();

      await fireEvent.keyDown(last, { key: "Tab" });

      expect(document.activeElement).toBe(focusables[0]);
    });

    it("Shift+Tab on the first focusable wraps to the last", async () => {
      renderDialog(config);

      const focusables = Array.from(
        document.querySelectorAll<HTMLElement>("vscode-textfield, vscode-button")
      );
      const first = focusables[0]!;
      first.focus();

      await fireEvent.keyDown(first, { key: "Tab", shiftKey: true });

      expect(document.activeElement).toBe(focusables[focusables.length - 1]);
    });
  });
});
