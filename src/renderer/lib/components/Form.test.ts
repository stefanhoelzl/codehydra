/**
 * Tests for Form component.
 * Tests rendering of text, progress, radio, dropdown, table, and input
 * sections, badge parsing, action buttons, event payloads, and keyboard
 * navigation.
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

  // ---- Radio sections ----

  describe("radio sections", () => {
    it("renders radio cards with labels", () => {
      const config: DialogConfig = {
        sections: [
          {
            type: "radio",
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
            type: "radio",
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
            type: "radio",
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

  // ---- Dropdown (combobox) sections ----

  describe("dropdown sections", () => {
    const dropdownConfig: DialogConfig = {
      sections: [
        {
          type: "dropdown",
          id: "region",
          suggestions: [
            {
              items: [
                { value: "us-east", label: "US East" },
                { value: "us-west", label: "US West" },
              ],
            },
          ],
        },
        {
          type: "group",
          items: [{ type: "button", id: "confirm", label: "Confirm", variant: "primary" }],
        },
      ],
    };

    it("renders a combobox whose list shows the suggestion labels on focus", async () => {
      renderForm(dropdownConfig);

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);

      expect(screen.getByRole("listbox")).toBeInTheDocument();
      expect(screen.getByText("US East")).toBeInTheDocument();
      expect(screen.getByText("US West")).toBeInTheDocument();
    });

    it("defaults to the first suggestion's value and displays its label", async () => {
      renderForm(dropdownConfig, { dialogId: "dd" });

      expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe("US East");

      await fireEvent.click(screen.getByText("Confirm"));

      expect(mockSendDialogEvent).toHaveBeenCalledWith({
        dialogId: "dd",
        actionId: "confirm",
        data: { region: "us-east" },
      });
    });

    it("starts at the suggestion matching initialValue", async () => {
      renderForm(
        {
          sections: [
            {
              type: "dropdown",
              id: "region",
              initialValue: "us-west",
              suggestions: [
                {
                  items: [
                    { value: "us-east", label: "US East" },
                    { value: "us-west", label: "US West" },
                  ],
                },
              ],
            },
            { type: "group", items: [{ type: "button", id: "confirm", label: "Confirm" }] },
          ],
        },
        { dialogId: "dd" }
      );

      expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe("US West");

      await fireEvent.click(screen.getByText("Confirm"));

      expect(mockSendDialogEvent).toHaveBeenCalledWith({
        dialogId: "dd",
        actionId: "confirm",
        data: { region: "us-west" },
      });
    });

    it("reports a picked suggestion's value while displaying its label", async () => {
      renderForm(dropdownConfig, { dialogId: "dd" });

      const input = screen.getByRole("combobox") as HTMLInputElement;
      await fireEvent.focus(input);
      // Options select on mousedown (prevents the blur-before-click issue).
      await fireEvent.mouseDown(screen.getByText("US West"));

      expect(input.value).toBe("US West");

      await fireEvent.click(screen.getByText("Confirm"));

      expect(mockSendDialogEvent).toHaveBeenCalledWith({
        dialogId: "dd",
        actionId: "confirm",
        data: { region: "us-west" },
      });
    });

    it("renders a label and error on a dropdown (FieldSection support)", () => {
      const config: DialogConfig = {
        sections: [
          {
            type: "dropdown",
            id: "region",
            label: "Region",
            error: "Region unavailable",
            suggestions: [{ items: [{ value: "us", label: "US" }] }],
          },
        ],
      };

      renderForm(config);

      const label = document.querySelector("vscode-label");
      expect(label).toHaveTextContent("Region");
      expect(label).toHaveAttribute("for", "region-input");

      const helper = document.querySelector("vscode-form-helper");
      expect(helper).toHaveAttribute("id", "region-error");
      expect(helper?.querySelector(".field-error")).toHaveTextContent("Region unavailable");

      const input = screen.getByRole("combobox");
      expect(input).toHaveAttribute("id", "region-input");
      expect(input).toHaveAttribute("aria-invalid", "true");
      expect(input).toHaveAttribute("aria-describedby", "region-error");
    });

    it("keeps the selected value when the config updates with the same suggestions", async () => {
      const { rerender } = renderForm(dropdownConfig, { dialogId: "dd" });

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);
      await fireEvent.mouseDown(screen.getByText("US West"));

      // Re-render with a new config object carrying the same suggestion values.
      await rerender({
        dialogId: "dd",
        config: {
          sections: [
            {
              type: "dropdown",
              id: "region",
              suggestions: [
                {
                  items: [
                    { value: "us-east", label: "US East" },
                    { value: "us-west", label: "US West (renamed)" },
                  ],
                },
              ],
            },
            { type: "group", items: [{ type: "button", id: "confirm", label: "Confirm" }] },
          ],
        },
      });

      await fireEvent.click(screen.getByText("Confirm"));

      expect(mockSendDialogEvent).toHaveBeenCalledWith({
        dialogId: "dd",
        actionId: "confirm",
        data: { region: "us-west" },
      });
    });

    it("falls back to the first suggestion when the choice disappears from an update", async () => {
      const { rerender } = renderForm(dropdownConfig, { dialogId: "dd" });

      const input = screen.getByRole("combobox") as HTMLInputElement;
      await fireEvent.focus(input);
      await fireEvent.mouseDown(screen.getByText("US West"));

      await rerender({
        dialogId: "dd",
        config: {
          sections: [
            {
              type: "dropdown",
              id: "region",
              suggestions: [{ items: [{ value: "eu-central", label: "EU Central" }] }],
            },
            { type: "group", items: [{ type: "button", id: "confirm", label: "Confirm" }] },
          ],
        },
      });

      expect(input.value).toBe("EU Central");

      await fireEvent.click(screen.getByText("Confirm"));

      expect(mockSendDialogEvent).toHaveBeenCalledWith({
        dialogId: "dd",
        actionId: "confirm",
        data: { region: "eu-central" },
      });
    });

    it("filters the suggestion list client-side without emitting any event", async () => {
      renderForm(dropdownConfig, { dialogId: "dd" });

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);
      await fireEvent.input(input, { target: { value: "west" } });

      expect(screen.queryByText("US East")).not.toBeInTheDocument();
      expect(screen.getByText("US West")).toBeInTheDocument();
      expect(mockSendDialogEvent).not.toHaveBeenCalled();
    });

    it("strict mode: typing does not change the reported value", async () => {
      renderForm(dropdownConfig, { dialogId: "dd" });

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);
      await fireEvent.input(input, { target: { value: "nonsense" } });

      await fireEvent.click(screen.getByText("Confirm"));

      expect(mockSendDialogEvent).toHaveBeenCalledWith({
        dialogId: "dd",
        actionId: "confirm",
        data: { region: "us-east" },
      });
    });

    it("hides a group header while the group has no matching suggestion", async () => {
      renderForm({
        sections: [
          {
            type: "dropdown",
            id: "branch",
            suggestions: [
              { header: "Local", items: [{ value: "main", label: "main" }] },
              { header: "Remote", items: [{ value: "origin/feat", label: "feat" }] },
            ],
          },
        ],
      });

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);

      expect(screen.getByText("Local")).toBeInTheDocument();
      expect(screen.getByText("Remote")).toBeInTheDocument();

      await fireEvent.input(input, { target: { value: "feat" } });

      expect(screen.queryByText("Local")).not.toBeInTheDocument();
      expect(screen.getByText("Remote")).toBeInTheDocument();
      expect(screen.getByText("feat")).toBeInTheDocument();
    });

    describe("free text", () => {
      const freeTextConfig: DialogConfig = {
        sections: [
          {
            type: "dropdown",
            id: "name",
            freeText: true,
            suggestions: [
              {
                items: [
                  { value: "refs/feature-x", label: "feature-x" },
                  { value: "refs/feature-y", label: "feature-y" },
                ],
              },
            ],
          },
          { type: "group", items: [{ type: "button", id: "create", label: "Create" }] },
        ],
      };

      it("starts empty and reports the typed text", async () => {
        renderForm(freeTextConfig, { dialogId: "ft" });

        const input = screen.getByRole("combobox") as HTMLInputElement;
        expect(input.value).toBe("");

        await fireEvent.input(input, { target: { value: "my-branch" } });
        await fireEvent.click(screen.getByText("Create"));

        expect(mockSendDialogEvent).toHaveBeenCalledWith({
          dialogId: "ft",
          actionId: "create",
          data: { name: "my-branch" },
        });
      });

      it("seeds from initialValue", () => {
        renderForm({
          sections: [
            {
              type: "dropdown",
              id: "name",
              freeText: true,
              initialValue: "seeded",
              suggestions: [{ items: [] }],
            },
          ],
        });

        expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe("seeded");
      });

      it("reports a picked suggestion's value, then the typed text after editing", async () => {
        renderForm(freeTextConfig, { dialogId: "ft" });

        const input = screen.getByRole("combobox") as HTMLInputElement;
        await fireEvent.focus(input);
        await fireEvent.keyDown(input, { key: "ArrowDown" });
        await fireEvent.keyDown(input, { key: "Enter" });

        // Picked: displays the label, reports the value.
        expect(input.value).toBe("feature-x");
        await fireEvent.click(screen.getByText("Create"));
        expect(mockSendDialogEvent).toHaveBeenLastCalledWith({
          dialogId: "ft",
          actionId: "create",
          data: { name: "refs/feature-x" },
        });

        // Editing the text reverts to reporting the typed text.
        await fireEvent.input(input, { target: { value: "feature-x2" } });
        await fireEvent.click(screen.getByText("Create"));
        expect(mockSendDialogEvent).toHaveBeenLastCalledWith({
          dialogId: "ft",
          actionId: "create",
          data: { name: "feature-x2" },
        });
      });
    });

    describe("keyboard", () => {
      it("Enter picks the highlighted suggestion without submitting", async () => {
        renderForm(dropdownConfig, { dialogId: "dd" });

        const input = screen.getByRole("combobox") as HTMLInputElement;
        await fireEvent.focus(input);
        await fireEvent.keyDown(input, { key: "ArrowDown" });
        await fireEvent.keyDown(input, { key: "Enter" });

        expect(input.value).toBe("US East");
        expect(mockSendDialogEvent).not.toHaveBeenCalled();
      });

      it("Enter with no highlighted suggestion triggers the primary action", async () => {
        renderForm(dropdownConfig, { dialogId: "dd" });

        const input = screen.getByRole("combobox");
        await fireEvent.focus(input);
        await fireEvent.keyDown(input, { key: "Escape" });
        await fireEvent.keyDown(input, { key: "Enter" });

        expect(mockSendDialogEvent).toHaveBeenCalledWith({
          dialogId: "dd",
          actionId: "confirm",
          data: { region: "us-east" },
        });
      });
    });

    describe("loading flag", () => {
      it("shows a loading spinner when loading is true", () => {
        const config: DialogConfig = {
          sections: [{ type: "dropdown", id: "branch", suggestions: [], loading: true }],
        };

        renderForm(config);

        const spinner = screen.getByRole("status", { name: "Loading options" });
        expect(spinner).toBeInTheDocument();
      });

      it("shows no spinner when loading is absent", () => {
        renderForm(dropdownConfig);

        expect(screen.queryByRole("status")).not.toBeInTheDocument();
      });

      it("keeps the control interactive while loading", () => {
        const config: DialogConfig = {
          sections: [{ type: "dropdown", id: "branch", suggestions: [], loading: true }],
        };

        renderForm(config);

        expect(screen.getByRole("combobox")).not.toBeDisabled();
      });

      it("reports an empty value while loading with cleared suggestions", async () => {
        const config: DialogConfig = {
          sections: [
            { type: "dropdown", id: "branch", suggestions: [], loading: true },
            { type: "group", items: [{ type: "button", id: "confirm", label: "Confirm" }] },
          ],
        };

        renderForm(config, { dialogId: "dd" });

        await fireEvent.click(screen.getByText("Confirm"));

        expect(mockSendDialogEvent).toHaveBeenCalledWith({
          dialogId: "dd",
          actionId: "confirm",
          data: { branch: "" },
        });
      });

      it("removes the spinner when an update sets loading false", async () => {
        const { rerender } = renderForm(
          {
            sections: [{ type: "dropdown", id: "branch", suggestions: [], loading: true }],
          },
          { dialogId: "dd" }
        );

        expect(screen.getByRole("status", { name: "Loading options" })).toBeInTheDocument();

        await rerender({
          dialogId: "dd",
          config: {
            sections: [
              {
                type: "dropdown",
                id: "branch",
                suggestions: [{ items: [{ value: "main", label: "main" }] }],
                loading: false,
              },
            ],
          },
        });

        expect(screen.queryByRole("status")).not.toBeInTheDocument();
      });
    });

    describe("change events", () => {
      it("emits immediately when a suggestion is picked (opt-in)", async () => {
        renderForm(
          {
            sections: [
              {
                type: "dropdown",
                id: "region",
                changeEvent: true,
                suggestions: [
                  {
                    items: [
                      { value: "us-east", label: "US East" },
                      { value: "us-west", label: "US West" },
                    ],
                  },
                ],
              },
            ],
          },
          { dialogId: "dc" }
        );

        const input = screen.getByRole("combobox");
        await fireEvent.focus(input);
        await fireEvent.mouseDown(screen.getByText("US West"));

        expect(mockSendDialogEvent).toHaveBeenCalledTimes(1);
        expect(mockSendDialogEvent).toHaveBeenCalledWith({
          kind: "change",
          dialogId: "dc",
          fieldId: "region",
          data: { region: "us-west" },
        });
      });

      it("debounces free-text typing (default 200ms)", async () => {
        vi.useFakeTimers();
        try {
          renderForm(
            {
              sections: [
                {
                  type: "dropdown",
                  id: "name",
                  freeText: true,
                  changeEvent: true,
                  suggestions: [{ items: [{ value: "main", label: "main" }] }],
                },
              ],
            },
            { dialogId: "dc2" }
          );

          const input = screen.getByRole("combobox");
          await fireEvent.input(input, { target: { value: "ma" } });

          expect(mockSendDialogEvent).not.toHaveBeenCalled();

          await vi.advanceTimersByTimeAsync(200);

          expect(mockSendDialogEvent).toHaveBeenCalledTimes(1);
          expect(mockSendDialogEvent).toHaveBeenCalledWith({
            kind: "change",
            dialogId: "dc2",
            fieldId: "name",
            data: { name: "ma" },
          });
        } finally {
          vi.useRealTimers();
        }
      });

      it("a pick cancels the pending typing debounce and emits once, immediately", async () => {
        vi.useFakeTimers();
        try {
          renderForm(
            {
              sections: [
                {
                  type: "dropdown",
                  id: "name",
                  freeText: true,
                  changeEvent: true,
                  suggestions: [{ items: [{ value: "refs/main", label: "main" }] }],
                },
              ],
            },
            { dialogId: "dc3" }
          );

          const input = screen.getByRole("combobox");
          await fireEvent.focus(input);
          await fireEvent.input(input, { target: { value: "mai" } });
          await fireEvent.mouseDown(screen.getByText("main"));

          // The pick emitted immediately with the picked value...
          expect(mockSendDialogEvent).toHaveBeenCalledTimes(1);
          expect(mockSendDialogEvent).toHaveBeenCalledWith({
            kind: "change",
            dialogId: "dc3",
            fieldId: "name",
            data: { name: "refs/main" },
          });

          // ...and the stale typing emit never fires.
          await vi.advanceTimersByTimeAsync(500);
          expect(mockSendDialogEvent).toHaveBeenCalledTimes(1);
        } finally {
          vi.useRealTimers();
        }
      });

      it("does not emit for picks when the field did not opt in", async () => {
        renderForm(dropdownConfig, { dialogId: "dd" });

        const input = screen.getByRole("combobox");
        await fireEvent.focus(input);
        await fireEvent.mouseDown(screen.getByText("US West"));

        expect(mockSendDialogEvent).not.toHaveBeenCalled();
      });
    });

    it("renders label and error around the combobox", () => {
      renderForm({
        sections: [
          {
            type: "dropdown",
            id: "region",
            label: "Region",
            error: "Unknown region",
            suggestions: [{ items: [{ value: "us-east", label: "US East" }] }],
          },
        ],
      });

      const label = document.querySelector("vscode-label");
      expect(label).toHaveTextContent("Region");
      expect(label).toHaveAttribute("for", "region-input");

      const input = screen.getByRole("combobox");
      expect(input).toHaveAttribute("id", "region-input");
      expect(input).toHaveAttribute("aria-invalid", "true");
      expect(input).toHaveAttribute("aria-describedby", "region-error");

      const helper = document.querySelector("vscode-form-helper");
      expect(helper).toHaveAttribute("id", "region-error");
      expect(helper?.querySelector(".field-error")).toHaveTextContent("Unknown region");
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

  // ---- Buttons (footer-style button groups) ----

  describe("buttons", () => {
    it("renders buttons declared in a button-only group", () => {
      const config: DialogConfig = {
        sections: [
          { type: "text", content: "Confirm?", style: "heading" },
          {
            type: "group",
            items: [
              { type: "button", id: "confirm", label: "OK" },
              { type: "button", id: "cancel", label: "Cancel", variant: "secondary" },
            ],
          },
        ],
      };

      renderForm(config);

      expect(screen.getByText("OK")).toBeInTheDocument();
      expect(screen.getByText("Cancel")).toBeInTheDocument();
    });

    it("clicking a button calls sendDialogEvent with correct dialogId and actionId", async () => {
      const config: DialogConfig = {
        sections: [
          { type: "text", content: "Proceed?", style: "heading" },
          { type: "group", items: [{ type: "button", id: "go", label: "Go" }] },
        ],
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

    it("disabled buttons do not fire events", async () => {
      const config: DialogConfig = {
        sections: [
          { type: "text", content: "Wait", style: "heading" },
          { type: "group", items: [{ type: "button", id: "go", label: "Go", disabled: true }] },
        ],
      };

      renderForm(config);

      const button = screen.getByText("Go");
      await fireEvent.click(button);

      expect(mockSendDialogEvent).not.toHaveBeenCalled();
    });

    it("busy buttons show busyLabel", () => {
      const config: DialogConfig = {
        sections: [
          { type: "text", content: "Working", style: "heading" },
          {
            type: "group",
            items: [
              {
                type: "button",
                id: "submit",
                label: "Submit",
                busy: true,
                busyLabel: "Submitting...",
              },
            ],
          },
        ],
      };

      renderForm(config);

      expect(screen.getByText("Submitting...")).toBeInTheDocument();
      expect(screen.queryByText("Submit")).not.toBeInTheDocument();
    });

    it("busy buttons do not fire events", async () => {
      const config: DialogConfig = {
        sections: [
          { type: "text", content: "Working", style: "heading" },
          {
            type: "group",
            items: [
              {
                type: "button",
                id: "submit",
                label: "Submit",
                busy: true,
                busyLabel: "Submitting...",
              },
            ],
          },
        ],
      };

      renderForm(config);

      const button = screen.getByText("Submitting...");
      await fireEvent.click(button);

      expect(mockSendDialogEvent).not.toHaveBeenCalled();
    });

    it("clicking a button includes selection data", async () => {
      const config: DialogConfig = {
        sections: [
          { type: "text", content: "Pick one", style: "heading" },
          {
            type: "radio",
            id: "choice",
            options: [
              { id: "opt-a", label: "Option A" },
              { id: "opt-b", label: "Option B" },
            ],
          },
          { type: "group", items: [{ type: "button", id: "confirm", label: "Confirm" }] },
        ],
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
            type: "radio",
            id: "agent",
            options: [
              { id: "claude", label: "Claude" },
              { id: "opencode", label: "OpenCode" },
            ],
          },
          { type: "input", id: "note", multiline: true, placeholder: "Note" },
          { type: "group", items: [{ type: "button", id: "confirm", label: "Confirm" }] },
        ],
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

  // ---- Group sections (field rows with attached buttons) ----

  describe("group sections", () => {
    const projectRow: DialogConfig = {
      sections: [
        {
          type: "group",
          label: "Project",
          items: [
            {
              type: "dropdown",
              id: "project",
              suggestions: [
                {
                  items: [
                    { value: "p1", label: "Project One" },
                    { value: "p2", label: "Project Two" },
                  ],
                },
              ],
            },
            {
              type: "button",
              id: "open-folder",
              icon: "folder-opened",
              title: "Open project folder",
            },
            { type: "button", id: "clone", icon: "source-control", title: "Clone from Git" },
          ],
        },
      ],
    };

    it("renders the field control and buttons in declaration order", () => {
      renderForm(projectRow);

      const row = document.querySelector(".group-row");
      expect(row).toBeInTheDocument();
      const children = Array.from(row!.children);
      expect(children).toHaveLength(3);
      expect(children[0]!.querySelector("[role='combobox']")).toBeInTheDocument();
      expect(children[1]!.tagName.toLowerCase()).toBe("vscode-button");
      expect(children[2]!.tagName.toLowerCase()).toBe("vscode-button");
    });

    it("renders the group label pointing at the first field's input", () => {
      renderForm(projectRow);

      const label = document.querySelector("vscode-label");
      expect(label).toHaveTextContent("Project");
      expect(label).toHaveAttribute("for", "project-input");
    });

    it("renders icon-only buttons with title doubling as accessible name", () => {
      renderForm(projectRow);

      const button = document.querySelectorAll(".group-row vscode-button")[0];
      expect(button).toHaveClass("icon-button");
      expect(button).toHaveAttribute("title", "Open project folder");
      expect(button).toHaveAttribute("aria-label", "Open project folder");
    });

    it("clicking a field-attached button emits an action event with the values snapshot", async () => {
      renderForm(projectRow, { dialogId: "ws" });

      const clone = document.querySelectorAll(".group-row vscode-button")[1]!;
      await fireEvent.click(clone);

      expect(mockSendDialogEvent).toHaveBeenCalledTimes(1);
      expect(mockSendDialogEvent).toHaveBeenCalledWith({
        dialogId: "ws",
        actionId: "clone",
        data: { project: "p1" },
      });
    });

    it("does not fire from a busy field-attached button", async () => {
      const config: DialogConfig = {
        sections: [
          {
            type: "group",
            items: [
              { type: "input", id: "url" },
              { type: "button", id: "fetch", icon: "cloud-download", title: "Fetch", busy: true },
            ],
          },
        ],
      };

      renderForm(config);

      await fireEvent.click(document.querySelector(".group-row vscode-button")!);

      expect(mockSendDialogEvent).not.toHaveBeenCalled();
    });

    it("renders a child field error below the row and marks the control invalid", () => {
      const config: DialogConfig = {
        sections: [
          {
            type: "group",
            label: "Clone URL",
            items: [
              { type: "input", id: "url", error: "Not a valid git URL" },
              { type: "button", id: "clone", icon: "source-control", title: "Clone" },
            ],
          },
        ],
      };

      renderForm(config);

      const helper = document.querySelector("vscode-form-helper");
      expect(helper).toHaveAttribute("id", "url-error");
      expect(helper?.querySelector(".field-error")).toHaveTextContent("Not a valid git URL");
      const field = document.querySelector("vscode-textfield");
      expect(field).toHaveAttribute("aria-invalid", "true");
      expect(field).toHaveAttribute("aria-describedby", "url-error");
    });

    it("emits an immediate change event when an opted-in dropdown in a group changes", async () => {
      const config: DialogConfig = {
        sections: [
          {
            type: "group",
            label: "Project",
            items: [
              {
                type: "dropdown",
                id: "project",
                changeEvent: true,
                suggestions: [
                  {
                    items: [
                      { value: "p1", label: "One" },
                      { value: "p2", label: "Two" },
                    ],
                  },
                ],
              },
              { type: "button", id: "open", icon: "folder-opened", title: "Open" },
            ],
          },
        ],
      };

      renderForm(config, { dialogId: "g1" });

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);
      // Options select on mousedown (prevents the blur-before-click issue).
      await fireEvent.mouseDown(screen.getByText("Two"));

      expect(mockSendDialogEvent).toHaveBeenCalledTimes(1);
      expect(mockSendDialogEvent).toHaveBeenCalledWith({
        kind: "change",
        dialogId: "g1",
        fieldId: "project",
        data: { project: "p2" },
      });
    });

    it("centers a button-only group by default in the centered layout", () => {
      const config: DialogConfig = {
        sections: [{ type: "group", items: [{ type: "button", id: "ok", label: "OK" }] }],
      };

      renderForm(config);

      expect(document.querySelector(".group-row")).toHaveClass("align-center");
    });

    it("left-aligns groups by default in the form layout", () => {
      const config: DialogConfig = {
        layout: "form",
        sections: [{ type: "group", items: [{ type: "button", id: "ok", label: "OK" }] }],
      };

      renderForm(config);

      expect(document.querySelector(".group-row")).toHaveClass("align-left");
    });

    it("applies an explicit align over the layout default", () => {
      const config: DialogConfig = {
        layout: "form",
        sections: [
          { type: "group", align: "right", items: [{ type: "button", id: "ok", label: "OK" }] },
        ],
      };

      renderForm(config);

      expect(document.querySelector(".group-row")).toHaveClass("align-right");
    });
  });

  // ---- Enter-key submit ----

  describe("Enter-key submit", () => {
    const radioSection = {
      type: "radio",
      id: "agent",
      options: [
        { id: "claude", label: "Claude" },
        { id: "opencode", label: "OpenCode" },
      ],
    } as const;

    it("activates the first variant 'primary' button on Enter in a radio group", async () => {
      const config: DialogConfig = {
        sections: [
          radioSection,
          {
            type: "group",
            items: [
              { type: "button", id: "open", icon: "folder-opened", title: "Open" },
              { type: "button", id: "select", label: "Continue", variant: "primary" },
            ],
          },
        ],
      };

      renderForm(config, { dialogId: "enter" });

      await fireEvent.keyDown(screen.getAllByRole("radio")[0]!, { key: "Enter" });

      expect(mockSendDialogEvent).toHaveBeenCalledTimes(1);
      expect(mockSendDialogEvent).toHaveBeenCalledWith({
        dialogId: "enter",
        actionId: "select",
        data: { agent: "claude" },
      });
    });

    it("does nothing on Enter when no button declares variant 'primary'", async () => {
      const config: DialogConfig = {
        sections: [
          radioSection,
          {
            type: "group",
            items: [{ type: "button", id: "open", icon: "folder-opened", title: "Open" }],
          },
        ],
      };

      renderForm(config);

      await fireEvent.keyDown(screen.getAllByRole("radio")[0]!, { key: "Enter" });

      expect(mockSendDialogEvent).not.toHaveBeenCalled();
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

  // ---- Field labels ----

  describe("field labels", () => {
    it("renders a vscode-label associated with an input via for/id", () => {
      const config: DialogConfig = {
        sections: [{ type: "input", id: "branch", label: "Branch name" }],
      };

      renderForm(config);

      const label = document.querySelector("vscode-label");
      expect(label).toBeInTheDocument();
      expect(label).toHaveTextContent("Branch name");
      expect(label).toHaveAttribute("for", "branch");

      // The control carries the matching id the label points at.
      expect(document.querySelector("vscode-textfield")).toHaveAttribute("id", "branch");
    });

    it("renders no label element when the field has none", () => {
      const config: DialogConfig = {
        sections: [{ type: "input", id: "branch" }],
      };

      renderForm(config);

      expect(document.querySelector("vscode-label")).not.toBeInTheDocument();
    });

    it("renders a vscode-label associated with a dropdown via for/id", () => {
      const config: DialogConfig = {
        sections: [
          {
            type: "dropdown",
            id: "region",
            label: "Region",
            suggestions: [{ items: [{ value: "us-east", label: "US East" }] }],
          },
        ],
      };

      renderForm(config);

      const label = document.querySelector("vscode-label");
      expect(label).toBeInTheDocument();
      expect(label).toHaveTextContent("Region");
      expect(label).toHaveAttribute("for", "region-input");

      expect(screen.getByRole("combobox")).toHaveAttribute("id", "region-input");
    });

    it("names a selection group from its label via aria-label", () => {
      const config: DialogConfig = {
        sections: [
          {
            type: "radio",
            id: "agent",
            label: "Agent",
            options: [
              { id: "claude", label: "Claude" },
              { id: "opencode", label: "OpenCode" },
            ],
          },
        ],
      };

      renderForm(config);

      expect(document.querySelector("vscode-label")).toHaveTextContent("Agent");
      expect(screen.getByRole("radiogroup")).toHaveAttribute("aria-label", "Agent");
    });
  });

  // ---- Field errors ----

  describe("field errors", () => {
    it("renders the error below a single-line input and marks the control invalid", () => {
      const config: DialogConfig = {
        sections: [
          { type: "input", id: "branch", label: "Branch", error: "Branch already exists" },
        ],
      };

      renderForm(config);

      // Error message lives in a vscode-form-helper, colored red via .field-error.
      const helper = document.querySelector("vscode-form-helper");
      expect(helper).toBeInTheDocument();
      expect(helper).toHaveAttribute("id", "branch-error");
      expect(helper?.querySelector(".field-error")).toHaveTextContent("Branch already exists");

      // The control is wired to the error and marked invalid (red border).
      const field = document.querySelector("vscode-textfield");
      expect(field).toHaveAttribute("aria-invalid", "true");
      expect(field).toHaveAttribute("aria-describedby", "branch-error");
      expect((field as HTMLElement & { invalid?: boolean }).invalid).toBe(true);
    });

    it("renders the error below a multiline input with the errored border class", () => {
      const config: DialogConfig = {
        sections: [{ type: "input", id: "note", multiline: true, error: "Required" }],
      };

      renderForm(config);

      const textarea = document.querySelector("textarea");
      expect(textarea).toHaveClass("errored");
      expect(textarea).toHaveAttribute("aria-invalid", "true");
      expect(textarea).toHaveAttribute("aria-describedby", "note-error");
      expect(document.querySelector("vscode-form-helper .field-error")).toHaveTextContent(
        "Required"
      );
    });

    it("renders the error below a selection and outlines the group", () => {
      const config: DialogConfig = {
        sections: [
          {
            type: "radio",
            id: "agent",
            error: "Pick an agent",
            options: [
              { id: "claude", label: "Claude" },
              { id: "opencode", label: "OpenCode" },
            ],
          },
        ],
      };

      renderForm(config);

      const group = screen.getByRole("radiogroup");
      expect(group).toHaveClass("errored");
      expect(group).toHaveAttribute("aria-describedby", "agent-error");
      const helper = document.querySelector("vscode-form-helper");
      expect(helper).toHaveAttribute("id", "agent-error");
      expect(helper?.querySelector(".field-error")).toHaveTextContent("Pick an agent");
    });

    it("renders the error below a dropdown and marks the control invalid", () => {
      const config: DialogConfig = {
        sections: [
          {
            type: "dropdown",
            id: "region",
            label: "Region",
            error: "Region unavailable",
            suggestions: [{ items: [{ value: "us-east", label: "US East" }] }],
          },
        ],
      };

      renderForm(config);

      const helper = document.querySelector("vscode-form-helper");
      expect(helper).toBeInTheDocument();
      expect(helper).toHaveAttribute("id", "region-error");
      expect(helper?.querySelector(".field-error")).toHaveTextContent("Region unavailable");

      const input = screen.getByRole("combobox");
      expect(input).toHaveAttribute("aria-invalid", "true");
      expect(input).toHaveAttribute("aria-describedby", "region-error");
      expect(input).toHaveClass("invalid");
    });

    it("renders no error element and no invalid state when error is absent", () => {
      const config: DialogConfig = {
        sections: [{ type: "input", id: "branch", label: "Branch" }],
      };

      renderForm(config);

      expect(document.querySelector("vscode-form-helper")).not.toBeInTheDocument();
      const field = document.querySelector("vscode-textfield");
      expect(field).not.toHaveAttribute("aria-invalid");
      expect(field).not.toHaveAttribute("aria-describedby");
    });

    it("treats an empty-string error as no error", () => {
      const config: DialogConfig = {
        sections: [{ type: "input", id: "branch", error: "" }],
      };

      renderForm(config);

      expect(document.querySelector("vscode-form-helper")).not.toBeInTheDocument();
      expect(document.querySelector("vscode-textfield")).not.toHaveAttribute("aria-invalid");
    });
  });

  // ---- Layout ----

  describe("layout", () => {
    it("uses the centered layout by default", () => {
      const config: DialogConfig = {
        sections: [{ type: "input", id: "branch", label: "Branch" }],
      };

      renderForm(config);

      expect(document.querySelector(".form")).not.toHaveClass("layout-form");
    });

    it("applies the form layout when config.layout is 'form'", () => {
      const config: DialogConfig = {
        layout: "form",
        sections: [{ type: "input", id: "branch", label: "Branch" }],
      };

      renderForm(config);

      expect(document.querySelector(".form")).toHaveClass("layout-form");
    });
  });

  // ---- Field-change channel ----

  describe("field-change channel", () => {
    it("does not emit a change event for fields that did not opt in", async () => {
      const config: DialogConfig = {
        sections: [
          {
            type: "radio",
            id: "agent",
            options: [
              { id: "claude", label: "Claude" },
              { id: "opencode", label: "OpenCode" },
            ],
          },
          { type: "input", id: "note", multiline: true, placeholder: "Note" },
          {
            type: "dropdown",
            id: "region",
            suggestions: [
              {
                items: [
                  { value: "us-east", label: "US East" },
                  { value: "us-west", label: "US West" },
                ],
              },
            ],
          },
        ],
      };

      renderForm(config);

      await fireEvent.click(screen.getAllByRole("radio")[1]!);
      const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
      await fireEvent.input(textarea, { target: { value: "hi" } });
      await fireEvent.focus(screen.getByRole("combobox"));
      await fireEvent.mouseDown(screen.getByText("US West"));

      expect(mockSendDialogEvent).not.toHaveBeenCalled();
    });

    it("emits a change event immediately when an opted-in selection changes", async () => {
      const config: DialogConfig = {
        sections: [
          {
            type: "radio",
            id: "agent",
            changeEvent: true,
            options: [
              { id: "claude", label: "Claude" },
              { id: "opencode", label: "OpenCode" },
            ],
          },
        ],
      };

      renderForm(config, { dialogId: "d1" });

      await fireEvent.click(screen.getAllByRole("radio")[1]!);

      expect(mockSendDialogEvent).toHaveBeenCalledTimes(1);
      expect(mockSendDialogEvent).toHaveBeenCalledWith({
        kind: "change",
        dialogId: "d1",
        fieldId: "agent",
        data: { agent: "opencode" },
      });
    });

    it("emits a change event immediately when an opted-in dropdown changes", async () => {
      const config: DialogConfig = {
        sections: [
          {
            type: "dropdown",
            id: "region",
            changeEvent: true,
            suggestions: [
              {
                items: [
                  { value: "us-east", label: "US East" },
                  { value: "us-west", label: "US West" },
                ],
              },
            ],
          },
        ],
      };

      renderForm(config, { dialogId: "d1" });

      await fireEvent.focus(screen.getByRole("combobox"));
      await fireEvent.mouseDown(screen.getByText("US West"));

      expect(mockSendDialogEvent).toHaveBeenCalledTimes(1);
      expect(mockSendDialogEvent).toHaveBeenCalledWith({
        kind: "change",
        dialogId: "d1",
        fieldId: "region",
        data: { region: "us-west" },
      });
    });

    it("debounces an opted-in input (default 200ms) and sends the full snapshot", async () => {
      vi.useFakeTimers();
      try {
        const config: DialogConfig = {
          sections: [
            {
              type: "radio",
              id: "agent",
              options: [
                { id: "claude", label: "Claude" },
                { id: "opencode", label: "OpenCode" },
              ],
            },
            { type: "input", id: "name", multiline: true, changeEvent: true, placeholder: "Name" },
          ],
        };

        renderForm(config, { dialogId: "d2" });

        const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
        await fireEvent.input(textarea, { target: { value: "ab" } });

        // Nothing emitted before the debounce window elapses.
        expect(mockSendDialogEvent).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(200);

        expect(mockSendDialogEvent).toHaveBeenCalledTimes(1);
        expect(mockSendDialogEvent).toHaveBeenCalledWith({
          kind: "change",
          dialogId: "d2",
          fieldId: "name",
          data: { agent: "claude", name: "ab" },
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("coalesces rapid typing into a single debounced emit (custom interval)", async () => {
      vi.useFakeTimers();
      try {
        const config: DialogConfig = {
          sections: [
            {
              type: "input",
              id: "q",
              multiline: true,
              changeEvent: { debounceMs: 100 },
              placeholder: "Q",
            },
          ],
        };

        renderForm(config, { dialogId: "d3" });

        const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
        await fireEvent.input(textarea, { target: { value: "a" } });
        await vi.advanceTimersByTimeAsync(50);
        await fireEvent.input(textarea, { target: { value: "ab" } });
        await vi.advanceTimersByTimeAsync(50);
        await fireEvent.input(textarea, { target: { value: "abc" } });

        // Still within the debounce window of the most recent keystroke.
        expect(mockSendDialogEvent).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(100);

        expect(mockSendDialogEvent).toHaveBeenCalledTimes(1);
        expect(mockSendDialogEvent).toHaveBeenCalledWith({
          kind: "change",
          dialogId: "d3",
          fieldId: "q",
          data: { q: "abc" },
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not emit a change when the backend updates the config (no feedback loop)", async () => {
      const config: DialogConfig = {
        sections: [
          {
            type: "radio",
            id: "agent",
            changeEvent: true,
            options: [
              { id: "claude", label: "Claude" },
              { id: "opencode", label: "OpenCode" },
            ],
          },
        ],
      };

      const { rerender } = renderForm(config, { dialogId: "d4" });

      // Backend-driven update drops the current option; reconcile re-picks the
      // first option, but that value change must NOT emit a change event.
      await rerender({
        dialogId: "d4",
        config: {
          sections: [
            {
              type: "radio",
              id: "agent",
              changeEvent: true,
              options: [
                { id: "gemini", label: "Gemini" },
                { id: "opencode", label: "OpenCode" },
              ],
            },
          ],
        },
      });

      expect(mockSendDialogEvent).not.toHaveBeenCalled();
    });

    it("does not emit a change when the backend updates a dropdown's config (no feedback loop)", async () => {
      const config: DialogConfig = {
        sections: [
          {
            type: "dropdown",
            id: "region",
            changeEvent: true,
            suggestions: [
              {
                items: [
                  { value: "us-east", label: "US East" },
                  { value: "us-west", label: "US West" },
                ],
              },
            ],
          },
        ],
      };

      const { rerender } = renderForm(config, { dialogId: "d4" });

      // Backend-driven update drops the current option; reconcile re-picks the
      // first option, but that value change must NOT emit a change event.
      await rerender({
        dialogId: "d4",
        config: {
          sections: [
            {
              type: "dropdown",
              id: "region",
              changeEvent: true,
              suggestions: [
                {
                  items: [
                    { value: "eu-central", label: "EU Central" },
                    { value: "us-west", label: "US West" },
                  ],
                },
              ],
            },
          ],
        },
      });

      expect(mockSendDialogEvent).not.toHaveBeenCalled();
    });

    it("cancels a pending debounced change when an action is submitted", async () => {
      vi.useFakeTimers();
      try {
        const config: DialogConfig = {
          sections: [
            { type: "input", id: "name", multiline: true, changeEvent: true, placeholder: "Name" },
            { type: "group", items: [{ type: "button", id: "go", label: "Go" }] },
          ],
        };

        renderForm(config, { dialogId: "d5" });

        const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
        await fireEvent.input(textarea, { target: { value: "abc" } });
        await fireEvent.click(screen.getByText("Go"));

        // Advancing past the debounce must not produce a late, redundant change
        // event — the action already carried the snapshot.
        await vi.advanceTimersByTimeAsync(500);

        const events = mockSendDialogEvent.mock.calls.map((c) => c[0]);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ actionId: "go", data: { name: "abc" } });
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
