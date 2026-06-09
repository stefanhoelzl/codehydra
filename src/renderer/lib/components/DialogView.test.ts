/**
 * Tests for DialogView component (the modal surface).
 * Section/action rendering lives in Form.test.ts — these cover only the
 * modal chrome: the dialog role + aria-label, the backdrop, the workspace-area
 * offset, and that sections render through the wrapped <Form>.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/svelte";
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
});
