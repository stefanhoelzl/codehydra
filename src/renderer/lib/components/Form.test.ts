/**
 * Tests for Form component.
 * Tests rendering of text, progress, selection, table, and input sections,
 * badge parsing, action buttons, event payloads, and keyboard navigation.
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
import Form from "./Form.svelte";

/** Helper to render Form with a config. */
function renderForm(config: DialogConfig, options?: { dialogId?: string }) {
  return render(Form, {
    props: {
      dialogId: options?.dialogId ?? "test-dialog",
      config,
    },
  });
}

describe("Form component", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  // ---- Text sections ----

  describe("text sections", () => {
    it("renders heading text as h1", () => {
      const config: DialogConfig = {
        sections: [{ type: "text", content: "My Heading", style: "heading" }],
      };

      renderForm(config);

      const heading = screen.getByRole("heading", { level: 1 });
      expect(heading).toHaveTextContent("My Heading");
    });

    it("renders subtitle text with subtitle class", () => {
      const config: DialogConfig = {
        sections: [{ type: "text", content: "A subtitle", style: "subtitle" }],
      };

      renderForm(config);

      const subtitle = document.querySelector("p.section-subtitle");
      expect(subtitle).toBeInTheDocument();
      expect(subtitle).toHaveTextContent("A subtitle");
    });

    it("renders mono text in pre element", () => {
      const config: DialogConfig = {
        sections: [{ type: "text", content: "some code", style: "mono" }],
      };

      renderForm(config);

      const pre = document.querySelector("pre.section-mono");
      expect(pre).toBeInTheDocument();
      expect(pre).toHaveTextContent("some code");
    });

    it("renders default text as paragraph", () => {
      const config: DialogConfig = {
        sections: [{ type: "text", content: "Normal text" }],
      };

      renderForm(config);

      const p = document.querySelector("p.section-text");
      expect(p).toBeInTheDocument();
      expect(p).toHaveTextContent("Normal text");
    });
  });

  // ---- Badge parsing ----

  describe("badge parsing", () => {
    it("renders {badge:text} as a vscode-badge element", () => {
      const config: DialogConfig = {
        sections: [{ type: "text", content: "Version {badge:v1.0} released", style: "heading" }],
      };

      renderForm(config);

      const badge = document.querySelector("vscode-badge");
      expect(badge).toBeInTheDocument();
      expect(badge).toHaveTextContent("v1.0");

      // Surrounding text should also be present
      const heading = screen.getByRole("heading", { level: 1 });
      expect(heading).toHaveTextContent("Version v1.0 released");
    });
  });

  // ---- Progress sections ----

  describe("progress sections", () => {
    it("renders progress items with labels", () => {
      const config: DialogConfig = {
        sections: [
          {
            type: "progress",
            items: [
              { id: "step-1", label: "Downloading", status: "done" },
              { id: "step-2", label: "Installing", status: "running" },
            ],
          },
        ],
      };

      renderForm(config);

      expect(screen.getByText("Downloading")).toBeInTheDocument();
      expect(screen.getByText("Installing")).toBeInTheDocument();
    });

    it("shows indeterminate progress bar for running items without progress value", () => {
      const config: DialogConfig = {
        sections: [
          {
            type: "progress",
            items: [{ id: "step-1", label: "Loading", status: "running" }],
          },
        ],
      };

      renderForm(config);

      const progressBar = document.querySelector("vscode-progress-bar");
      expect(progressBar).toBeInTheDocument();
      // In Svelte, boolean props on custom elements are set as DOM properties.
      // Verify the aria-label identifies the running item's progress bar.
      expect(progressBar).toHaveAttribute("aria-label", "Loading progress");
    });
  });

  // ---- Selection sections ----

  describe("selection sections", () => {
    it("renders selection cards with labels", () => {
      const config: DialogConfig = {
        sections: [
          {
            type: "selection",
            id: "choice",
            options: [
              { id: "opt-a", label: "Option A" },
              { id: "opt-b", label: "Option B" },
            ],
          },
        ],
      };

      renderForm(config);

      expect(screen.getByText("Option A")).toBeInTheDocument();
      expect(screen.getByText("Option B")).toBeInTheDocument();
    });

    it("clicking a card selects it", async () => {
      const config: DialogConfig = {
        sections: [
          {
            type: "selection",
            id: "choice",
            options: [
              { id: "opt-a", label: "Option A" },
              { id: "opt-b", label: "Option B" },
            ],
          },
        ],
      };

      renderForm(config);

      // First option is selected by default
      const radios = screen.getAllByRole("radio");
      expect(radios[0]).toHaveAttribute("aria-checked", "true");
      expect(radios[1]).toHaveAttribute("aria-checked", "false");

      // Click the second option
      await fireEvent.click(radios[1]!);

      expect(radios[0]).toHaveAttribute("aria-checked", "false");
      expect(radios[1]).toHaveAttribute("aria-checked", "true");
    });

    it("arrow keys navigate between cards", async () => {
      const config: DialogConfig = {
        sections: [
          {
            type: "selection",
            id: "choice",
            options: [
              { id: "opt-a", label: "Option A" },
              { id: "opt-b", label: "Option B" },
            ],
          },
        ],
      };

      renderForm(config);

      const radios = screen.getAllByRole("radio");
      // First option is selected by default
      expect(radios[0]).toHaveAttribute("aria-checked", "true");

      // Press ArrowDown on the first radio to navigate to second
      await fireEvent.keyDown(radios[0]!, { key: "ArrowDown" });

      await waitFor(() => {
        expect(radios[1]).toHaveAttribute("aria-checked", "true");
        expect(radios[0]).toHaveAttribute("aria-checked", "false");
      });
    });
  });

  // ---- Table sections ----

  describe("table sections", () => {
    it("renders table with header and rows", () => {
      const config: DialogConfig = {
        sections: [
          {
            type: "table",
            header: "Details",
            columns: [
              { key: "name", label: "Name" },
              { key: "value", label: "Value" },
            ],
            rows: [
              { name: "Version", value: "1.0.0" },
              { name: "Size", value: "4.2 MB" },
            ],
          },
        ],
      };

      renderForm(config);

      // Table header text
      expect(screen.getByText("Details")).toBeInTheDocument();

      // Column headers
      expect(screen.getByText("Name")).toBeInTheDocument();
      expect(screen.getByText("Value")).toBeInTheDocument();

      // Row data
      expect(screen.getByText("Version")).toBeInTheDocument();
      expect(screen.getByText("1.0.0")).toBeInTheDocument();
      expect(screen.getByText("Size")).toBeInTheDocument();
      expect(screen.getByText("4.2 MB")).toBeInTheDocument();
    });
  });

  // ---- Actions ----

  describe("actions", () => {
    it("renders action buttons", () => {
      const config: DialogConfig = {
        sections: [{ type: "text", content: "Confirm?", style: "heading" }],
        actions: [
          { id: "confirm", label: "OK" },
          { id: "cancel", label: "Cancel", variant: "secondary" },
        ],
      };

      renderForm(config);

      expect(screen.getByText("OK")).toBeInTheDocument();
      expect(screen.getByText("Cancel")).toBeInTheDocument();
    });

    it("clicking an action calls sendDialogEvent with correct dialogId and actionId", async () => {
      const config: DialogConfig = {
        sections: [{ type: "text", content: "Proceed?", style: "heading" }],
        actions: [{ id: "go", label: "Go" }],
      };

      renderForm(config, { dialogId: "my-dialog" });

      const button = screen.getByText("Go");
      await fireEvent.click(button);

      expect(mockSendDialogEvent).toHaveBeenCalledTimes(1);
      expect(mockSendDialogEvent).toHaveBeenCalledWith({
        dialogId: "my-dialog",
        actionId: "go",
        data: {},
      });
    });

    it("disabled actions do not fire events", async () => {
      const config: DialogConfig = {
        sections: [{ type: "text", content: "Wait", style: "heading" }],
        actions: [{ id: "go", label: "Go", disabled: true }],
      };

      renderForm(config);

      const button = screen.getByText("Go");
      await fireEvent.click(button);

      expect(mockSendDialogEvent).not.toHaveBeenCalled();
    });

    it("busy actions show busyLabel", () => {
      const config: DialogConfig = {
        sections: [{ type: "text", content: "Working", style: "heading" }],
        actions: [{ id: "submit", label: "Submit", busy: true, busyLabel: "Submitting..." }],
      };

      renderForm(config);

      expect(screen.getByText("Submitting...")).toBeInTheDocument();
      expect(screen.queryByText("Submit")).not.toBeInTheDocument();
    });

    it("busy actions do not fire events", async () => {
      const config: DialogConfig = {
        sections: [{ type: "text", content: "Working", style: "heading" }],
        actions: [{ id: "submit", label: "Submit", busy: true, busyLabel: "Submitting..." }],
      };

      renderForm(config);

      const button = screen.getByText("Submitting...");
      await fireEvent.click(button);

      expect(mockSendDialogEvent).not.toHaveBeenCalled();
    });

    it("clicking an action includes selection data", async () => {
      const config: DialogConfig = {
        sections: [
          { type: "text", content: "Pick one", style: "heading" },
          {
            type: "selection",
            id: "choice",
            options: [
              { id: "opt-a", label: "Option A" },
              { id: "opt-b", label: "Option B" },
            ],
          },
        ],
        actions: [{ id: "confirm", label: "Confirm" }],
      };

      renderForm(config, { dialogId: "sel-dialog" });

      // Select second option
      const radios = screen.getAllByRole("radio");
      await fireEvent.click(radios[1]!);

      // Click action
      const button = screen.getByText("Confirm");
      await fireEvent.click(button);

      expect(mockSendDialogEvent).toHaveBeenCalledWith({
        dialogId: "sel-dialog",
        actionId: "confirm",
        data: { choice: "opt-b" },
      });
    });

    it("includes all field values (selection + input) keyed by id", async () => {
      const config: DialogConfig = {
        sections: [
          { type: "text", content: "Pick + note", style: "heading" },
          {
            type: "selection",
            id: "agent",
            options: [
              { id: "claude", label: "Claude" },
              { id: "opencode", label: "OpenCode" },
            ],
          },
          { type: "input", id: "note", multiline: true, placeholder: "Note" },
        ],
        actions: [{ id: "confirm", label: "Confirm" }],
      };

      renderForm(config, { dialogId: "multi-dialog" });

      // Switch the selection from its default (first option) to the second.
      const radios = screen.getAllByRole("radio");
      await fireEvent.click(radios[1]!);

      // Type into the input.
      const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
      await fireEvent.input(textarea, { target: { value: "hello" } });

      await fireEvent.click(screen.getByText("Confirm"));

      expect(mockSendDialogEvent).toHaveBeenCalledWith({
        dialogId: "multi-dialog",
        actionId: "confirm",
        data: { agent: "opencode", note: "hello" },
      });
    });
  });

  // ---- Input sections ----

  describe("input sections", () => {
    it("selects the seeded text when selectInitialValue is true", async () => {
      const config: DialogConfig = {
        sections: [
          {
            type: "input",
            id: "desc",
            multiline: true,
            initialValue: "hello world",
            selectInitialValue: true,
          },
        ],
      };

      renderForm(config);

      const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
      expect(textarea).toBeInTheDocument();
      await waitFor(() => {
        expect(textarea.selectionStart).toBe(0);
        expect(textarea.selectionEnd).toBe("hello world".length);
      });
    });

    it("places caret at cursorOffset when selectInitialValue is not set", async () => {
      const config: DialogConfig = {
        sections: [
          {
            type: "input",
            id: "desc",
            multiline: true,
            initialValue: "hello world",
            cursorOffset: 5,
          },
        ],
      };

      renderForm(config);

      const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
      await waitFor(() => {
        expect(textarea.selectionStart).toBe(5);
        expect(textarea.selectionEnd).toBe(5);
      });
    });

    it("re-focuses the textarea on Alt keyup when focus was lost to body", async () => {
      const config: DialogConfig = {
        sections: [
          {
            type: "input",
            id: "desc",
            multiline: true,
            initialValue: "hello",
            selectInitialValue: true,
          },
        ],
      };

      renderForm(config);

      const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
      await waitFor(() => {
        expect(document.activeElement).toBe(textarea);
      });

      // Simulate Chromium's Alt-up stealing focus back to the document body
      textarea.blur();
      expect(document.activeElement).toBe(document.body);

      window.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt" }));

      await waitFor(() => {
        expect(document.activeElement).toBe(textarea);
      });
    });
  });
});
