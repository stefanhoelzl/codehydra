/**
 * Tests for the Form orchestrator.
 * Form-global behavior: field-value reconciliation against config pushes
 * (adoption, preservation, fallbacks, seeding), the field-change channel
 * (debounce, cancel-on-submit, no feedback loops), action event payloads,
 * primary-action resolution, autofocus management, and layout switching.
 * Per-section rendering and raw interaction reporting are covered by the
 * section leaf tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/svelte";
import type { DialogConfig, DialogKind } from "@shared/dialog-types";

// Shared fake: src/renderer/lib/api/__mocks__/index.ts
vi.mock("$lib/api");
import { sendDialogEvent } from "$lib/api";
const mockSendDialogEvent = vi.mocked(sendDialogEvent);

// Import after mock setup
import Form from "./Form.svelte";

/** Helper to render Form with a config. */
function renderForm(config: DialogConfig, options?: { dialogId?: string; kind?: DialogKind }) {
  return render(Form, {
    props: {
      dialogId: options?.dialogId ?? "test-dialog",
      config,
      ...(options?.kind ? { kind: options.kind } : {}),
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

  // ---- Radio wiring (controlled round-trip) ----

  describe("radio wiring", () => {
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
  });

  // ---- Dropdown value semantics (reconcile) ----

  describe("dropdown value semantics", () => {
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

      it("typing filters the suggestion list (the value echo must not clear it)", async () => {
        renderForm(freeTextConfig, { dialogId: "ft" });

        const input = screen.getByRole("combobox") as HTMLInputElement;
        await fireEvent.focus(input);
        await fireEvent.input(input, { target: { value: "feature-x" } });

        await waitFor(() => {
          expect(screen.getByText("feature-x")).toBeInTheDocument();
          expect(screen.queryByText("feature-y")).not.toBeInTheDocument();
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

    describe("controlled value push", () => {
      const suggestions = [
        {
          items: [
            { value: "main", label: "main" },
            { value: "develop", label: "develop" },
          ],
        },
      ];

      function valueConfig(value: string, extra?: { error?: string }): DialogConfig {
        return {
          sections: [
            { type: "dropdown", id: "base", suggestions, value, ...extra },
            {
              type: "group",
              items: [{ type: "button", id: "confirm", label: "Confirm", variant: "primary" }],
            },
          ],
        };
      }

      it("adopts the pushed value (display follows the suggestion label)", async () => {
        renderForm(valueConfig("develop"), { dialogId: "dd" });

        expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe("develop");

        await fireEvent.click(screen.getByText("Confirm"));
        expect(mockSendDialogEvent).toHaveBeenCalledWith({
          dialogId: "dd",
          actionId: "confirm",
          data: { base: "develop" },
        });
      });

      it("re-sending the same value preserves a user pick made in between", async () => {
        const { rerender } = renderForm(valueConfig("main"), { dialogId: "dd" });

        const input = screen.getByRole("combobox") as HTMLInputElement;
        await fireEvent.focus(input);
        await fireEvent.mouseDown(screen.getByText("develop"));
        expect(input.value).toBe("develop");

        // Backend re-sends the same value (e.g. alongside an error update).
        await rerender({ dialogId: "dd", config: valueConfig("main", { error: "nope" }) });

        expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe("develop");
      });

      it("pushing a DIFFERENT value adopts it over the user's choice", async () => {
        const { rerender } = renderForm(valueConfig("main"), { dialogId: "dd" });

        const input = screen.getByRole("combobox") as HTMLInputElement;
        await fireEvent.focus(input);
        await fireEvent.mouseDown(screen.getByText("develop"));

        await rerender({ dialogId: "dd", config: valueConfig("main") });
        // still develop (same value re-sent)
        expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe("develop");

        await rerender({ dialogId: "dd", config: valueConfig("develop") });
        // a new pushed value is adopted... it matches the current choice
        await rerender({ dialogId: "dd", config: valueConfig("main") });
        expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe("main");
      });

      it("an invalid pushed value falls back to the first suggestion", async () => {
        renderForm(valueConfig("gone"), { dialogId: "dd" });

        await fireEvent.click(screen.getByText("Confirm"));
        expect(mockSendDialogEvent).toHaveBeenCalledWith({
          dialogId: "dd",
          actionId: "confirm",
          data: { base: "main" },
        });
      });

      it("adopts a pushed value on a freeText dropdown as the field text", async () => {
        renderForm(
          {
            sections: [
              { type: "dropdown", id: "name", freeText: true, suggestions: [], value: "seeded" },
              {
                type: "group",
                items: [{ type: "button", id: "confirm", label: "Confirm", variant: "primary" }],
              },
            ],
          },
          { dialogId: "dd" }
        );

        expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe("seeded");

        await fireEvent.click(screen.getByText("Confirm"));
        expect(mockSendDialogEvent).toHaveBeenCalledWith({
          dialogId: "dd",
          actionId: "confirm",
          data: { name: "seeded" },
        });
      });
    });
  });

  // ---- Input value semantics (reconcile) ----

  describe("input value semantics", () => {
    it("seeds an input from initialValue into the snapshot", async () => {
      renderForm(
        {
          sections: [
            { type: "input", id: "url", initialValue: "org/repo" },
            { type: "group", items: [{ type: "button", id: "go", label: "Go" }] },
          ],
        },
        { dialogId: "dd" }
      );

      await fireEvent.click(screen.getByText("Go"));

      expect(mockSendDialogEvent).toHaveBeenCalledWith({
        dialogId: "dd",
        actionId: "go",
        data: { url: "org/repo" },
      });
    });

    it("Enter in a single-line input activates the primary action", async () => {
      renderForm(
        {
          sections: [
            { type: "input", id: "url" },
            {
              type: "group",
              items: [{ type: "button", id: "go", label: "Go", variant: "primary" }],
            },
          ],
        },
        { dialogId: "dd" }
      );

      const field = document.getElementById("url")!;
      await fireEvent.input(field, { target: { value: "org/repo" } });
      await fireEvent.keyDown(field, { key: "Enter" });

      expect(mockSendDialogEvent).toHaveBeenCalledWith({
        dialogId: "dd",
        actionId: "go",
        data: { url: "org/repo" },
      });
    });
  });

  // ---- Buttons (action events) ----

  // ---- Checkbox value semantics ----

  describe("checkbox value semantics", () => {
    function checkboxConfig(options?: { value?: boolean; changeEvent?: boolean }): DialogConfig {
      return {
        sections: [
          {
            type: "checkbox",
            id: "keep",
            label: "Keep branch",
            ...(options?.value !== undefined && { value: options.value }),
            ...(options?.changeEvent !== undefined && { changeEvent: options.changeEvent }),
          },
          {
            type: "group",
            items: [{ type: "button", id: "confirm", label: "Confirm", variant: "primary" }],
          },
        ],
      };
    }

    function getCheckbox(): HTMLElement & { checked: boolean } {
      return document.querySelector("vscode-checkbox") as HTMLElement & { checked: boolean };
    }

    async function toggle(checked: boolean): Promise<void> {
      const checkbox = getCheckbox();
      checkbox.checked = checked;
      await fireEvent(checkbox, new Event("change", { bubbles: true }));
    }

    async function submittedValue(): Promise<string | undefined> {
      await fireEvent.click(screen.getByText("Confirm"));
      const call = mockSendDialogEvent.mock.calls.at(-1)?.[0] as
        | { data?: Record<string, string> }
        | undefined;
      return call?.data?.["keep"];
    }

    it("defaults to false and reports the string form in action data", async () => {
      renderForm(checkboxConfig(), { dialogId: "cb" });

      expect(await submittedValue()).toBe("false");
    });

    it("a toggle is tracked and reported as true", async () => {
      renderForm(checkboxConfig(), { dialogId: "cb" });

      await toggle(true);

      expect(await submittedValue()).toBe("true");
    });

    it("changeEvent: true emits an immediate field-change with the snapshot", async () => {
      renderForm(checkboxConfig({ changeEvent: true }), { dialogId: "cb" });

      await toggle(true);

      expect(mockSendDialogEvent).toHaveBeenCalledWith({
        kind: "change",
        dialogId: "cb",
        fieldId: "keep",
        data: { keep: "true" },
      });
    });

    it("re-sending the same pushed value preserves the user's toggle", async () => {
      const { rerender } = renderForm(checkboxConfig({ value: false }), { dialogId: "cb" });

      await toggle(true);
      // Backend re-sends value: false (e.g. alongside an unrelated update).
      await rerender({ dialogId: "cb", config: checkboxConfig({ value: false }) });

      expect(await submittedValue()).toBe("true");
    });

    it("pushing a DIFFERENT value adopts it over the user's toggle", async () => {
      const { rerender } = renderForm(checkboxConfig({ value: false }), { dialogId: "cb" });

      await toggle(true);
      // Backend forces the box off (e.g. a checkbox interlock): true -> false
      // only adopts when the pushed value differs from the last adopted one,
      // so the backend echoes its model: push true (tracking the toggle),
      // then push false (the forced state).
      await rerender({ dialogId: "cb", config: checkboxConfig({ value: true }) });
      await rerender({ dialogId: "cb", config: checkboxConfig({ value: false }) });

      expect(await submittedValue()).toBe("false");
    });
  });

  describe("buttons", () => {
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

    it("clicking a field-attached button emits an action event with the values snapshot", async () => {
      const config: DialogConfig = {
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

      renderForm(config, { dialogId: "ws" });

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
  });

  // ---- Group wiring (children render as ordinary sections) ----

  describe("group wiring", () => {
    it("a group child input is wired into the form's field values", async () => {
      const config: DialogConfig = {
        sections: [
          {
            type: "group",
            label: "Clone URL",
            items: [
              { type: "input", id: "url", changeEvent: { debounceMs: 0 } },
              { type: "button", id: "clone", icon: "source-control", title: "Clone" },
            ],
          },
        ],
      };

      renderForm(config, { dialogId: "gw" });

      await fireEvent.input(document.getElementById("url")!, { target: { value: "org/repo" } });

      expect(mockSendDialogEvent).toHaveBeenCalledWith({
        kind: "change",
        dialogId: "gw",
        fieldId: "url",
        data: { url: "org/repo" },
      });
    });

    it("renders a child field error inline in its cell and marks the control invalid", () => {
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

      // The child renders as an ordinary section: its error helper sits inside
      // the child's cell within the row.
      const helper = document.querySelector(".group-field vscode-form-helper");
      expect(helper).toHaveAttribute("id", "url-error");
      expect(helper?.querySelector(".field-error")).toHaveTextContent("Not a valid git URL");
      const field = document.querySelector("vscode-textfield");
      expect(field).toHaveAttribute("aria-invalid", "true");
      expect(field).toHaveAttribute("aria-describedby", "url-error");
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

    const radioWithPrimary: DialogConfig = {
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

    it("plain Enter in a radio group activates the primary button (submits once)", async () => {
      renderForm(radioWithPrimary, { dialogId: "enter" });

      await fireEvent.keyDown(screen.getAllByRole("radio")[0]!, { key: "Enter" });

      expect(mockSendDialogEvent).toHaveBeenCalledTimes(1);
      expect(mockSendDialogEvent).toHaveBeenCalledWith({
        dialogId: "enter",
        actionId: "select",
        data: { agent: "claude" },
      });
    });

    it("Cmd/Ctrl+Enter in a radio group activates the primary button", async () => {
      renderForm(radioWithPrimary, { dialogId: "enter" });

      await fireEvent.keyDown(screen.getAllByRole("radio")[0]!, { key: "Enter", ctrlKey: true });

      expect(mockSendDialogEvent).toHaveBeenCalledTimes(1);
      expect(mockSendDialogEvent).toHaveBeenCalledWith({
        dialogId: "enter",
        actionId: "select",
        data: { agent: "claude" },
      });
    });

    it("does nothing on Cmd/Ctrl+Enter when no button declares variant 'primary'", async () => {
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

      await fireEvent.keyDown(screen.getAllByRole("radio")[0]!, { key: "Enter", ctrlKey: true });

      expect(mockSendDialogEvent).not.toHaveBeenCalled();
    });

    it("Enter with no highlighted suggestion in a dropdown triggers the primary action", async () => {
      renderForm(
        {
          sections: [
            {
              type: "dropdown",
              id: "region",
              suggestions: [{ items: [{ value: "us-east", label: "US East" }] }],
            },
            {
              type: "group",
              items: [{ type: "button", id: "confirm", label: "Confirm", variant: "primary" }],
            },
          ],
        },
        { dialogId: "dd" }
      );

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

    // Regression: a focused field that preventDefaults Enter without submitting
    // (vscode-checkbox) must not swallow the form-global Cmd/Ctrl+Enter gesture.
    it("Cmd/Ctrl+Enter submits even when the focused field preventDefaults Enter", async () => {
      const config: DialogConfig = {
        sections: [
          { type: "checkbox", id: "keep-branch", label: "Keep branch" },
          {
            type: "group",
            items: [{ type: "button", id: "remove", label: "Remove", variant: "primary" }],
          },
        ],
      };
      renderForm(config, { dialogId: "rm" });

      const checkbox = document.getElementById("keep-branch")!;
      // Mirror vscode-checkbox: it preventDefaults Enter (with no submit of its own).
      checkbox.addEventListener("keydown", (e) => {
        if (e.key === "Enter") e.preventDefault();
      });

      await fireEvent.keyDown(checkbox, { key: "Enter", ctrlKey: true });

      expect(mockSendDialogEvent).toHaveBeenCalledTimes(1);
      expect(mockSendDialogEvent).toHaveBeenCalledWith({
        dialogId: "rm",
        actionId: "remove",
        data: { "keep-branch": "false" },
      });
    });

    it("Cmd/Ctrl+Enter on a single-line input submits exactly once (no double)", async () => {
      renderForm(
        {
          sections: [
            { type: "input", id: "url" },
            {
              type: "group",
              items: [{ type: "button", id: "go", label: "Go", variant: "primary" }],
            },
          ],
        },
        { dialogId: "once" }
      );

      const field = document.getElementById("url")!;
      await fireEvent.input(field, { target: { value: "org/repo" } });
      await fireEvent.keyDown(field, { key: "Enter", ctrlKey: true });

      expect(mockSendDialogEvent).toHaveBeenCalledTimes(1);
      expect(mockSendDialogEvent).toHaveBeenCalledWith({
        dialogId: "once",
        actionId: "go",
        data: { url: "org/repo" },
      });
    });
  });

  // ---- Form-global keyboard contract ----

  describe("keyboard contract", () => {
    const keyConfig: DialogConfig = {
      sections: [
        { type: "input", id: "name", label: "Name" },
        {
          type: "group",
          items: [
            { type: "button", id: "cancel", label: "Cancel", variant: "secondary", role: "cancel" },
            { type: "button", id: "create", label: "Create", variant: "primary" },
          ],
        },
      ],
    };

    it("Escape clicks the cancel-role button with the values snapshot", async () => {
      renderForm(keyConfig, { dialogId: "kb-1" });

      const field = document.getElementById("name")!;
      await fireEvent.input(field, { target: { value: "ws" } });
      await fireEvent.keyDown(document.querySelector(".form")!, { key: "Escape" });

      expect(mockSendDialogEvent).toHaveBeenCalledWith({
        dialogId: "kb-1",
        actionId: "cancel",
        data: { name: "ws" },
      });
    });

    it("Escape clicking the cancel-role button bubbles up from inside a field", async () => {
      renderForm(keyConfig, { dialogId: "kb-2" });

      await fireEvent.keyDown(document.getElementById("name")!, { key: "Escape" });

      expect(mockSendDialogEvent).toHaveBeenCalledWith({
        dialogId: "kb-2",
        actionId: "cancel",
        data: { name: "" },
      });
    });

    it("Escape is a no-op on a modal with no enabled cancel-role button", async () => {
      renderForm(
        {
          sections: [
            { type: "input", id: "name", label: "Name" },
            {
              type: "group",
              items: [{ type: "button", id: "create", label: "Create", variant: "primary" }],
            },
          ],
        },
        { dialogId: "kb-modal" }
      );

      await fireEvent.keyDown(document.querySelector(".form")!, { key: "Escape" });

      expect(mockSendDialogEvent).not.toHaveBeenCalled();
    });

    it("Escape skips a disabled cancel-role button (no-op on a modal)", async () => {
      renderForm(
        {
          sections: [
            {
              type: "group",
              items: [
                {
                  type: "button",
                  id: "cancel",
                  label: "Cancel",
                  variant: "secondary",
                  role: "cancel",
                  disabled: true,
                },
              ],
            },
          ],
        },
        { dialogId: "kb-disabled" }
      );

      await fireEvent.keyDown(document.querySelector(".form")!, { key: "Escape" });

      expect(mockSendDialogEvent).not.toHaveBeenCalled();
    });

    it("Escape emits a dismiss event on a modeless dialog with no cancel-role button", async () => {
      renderForm(
        {
          sections: [{ type: "input", id: "name", label: "Name" }],
        },
        { dialogId: "kb-modeless", kind: "modeless" }
      );

      await fireEvent.keyDown(document.querySelector(".form")!, { key: "Escape" });

      expect(mockSendDialogEvent).toHaveBeenCalledWith({
        kind: "dismiss",
        dialogId: "kb-modeless",
      });
    });

    it("an open dropdown consumes the first Escape; the second clicks cancel-role", async () => {
      renderForm(
        {
          sections: [
            {
              type: "dropdown",
              id: "region",
              suggestions: [{ items: [{ value: "us-east", label: "US East" }] }],
            },
            {
              type: "group",
              items: [
                {
                  type: "button",
                  id: "cancel",
                  label: "Cancel",
                  variant: "secondary",
                  role: "cancel",
                },
              ],
            },
          ],
        },
        { dialogId: "kb-3" }
      );

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);
      expect(input).toHaveAttribute("aria-expanded", "true");

      // First Escape closes the dropdown without acting on the session.
      await fireEvent.keyDown(input, { key: "Escape" });
      expect(input).toHaveAttribute("aria-expanded", "false");
      expect(mockSendDialogEvent).not.toHaveBeenCalled();

      // Second Escape reaches the form and clicks the cancel-role button.
      await fireEvent.keyDown(input, { key: "Escape" });
      expect(mockSendDialogEvent).toHaveBeenCalledWith({
        dialogId: "kb-3",
        actionId: "cancel",
        data: { region: "us-east" },
      });
    });

    it("Cmd/Ctrl+Enter activates the primary button with the values snapshot", async () => {
      renderForm(keyConfig, { dialogId: "kb-4" });

      const field = document.getElementById("name")!;
      await fireEvent.input(field, { target: { value: "ws" } });
      await fireEvent.keyDown(document.querySelector(".form")!, { key: "Enter", ctrlKey: true });

      expect(mockSendDialogEvent).toHaveBeenCalledTimes(1);
      expect(mockSendDialogEvent).toHaveBeenCalledWith({
        dialogId: "kb-4",
        actionId: "create",
        data: { name: "ws" },
      });
    });

    it("Ctrl+Enter inside a single-line input submits exactly once", async () => {
      renderForm(keyConfig, { dialogId: "kb-5" });

      // The input's own Enter handler consumes the key (defaultPrevented);
      // the form-level handler must not fire a second action.
      await fireEvent.keyDown(document.getElementById("name")!, { key: "Enter", ctrlKey: true });

      expect(mockSendDialogEvent).toHaveBeenCalledTimes(1);
      expect(mockSendDialogEvent).toHaveBeenCalledWith(
        expect.objectContaining({ actionId: "create" })
      );
    });

    it("Cmd/Ctrl+Enter does nothing without an explicit primary button", async () => {
      renderForm({
        sections: [
          { type: "text", content: "Working", style: "heading" },
          { type: "group", items: [{ type: "button", id: "go", label: "Go" }] },
        ],
      });

      await fireEvent.keyDown(document.querySelector(".form")!, { key: "Enter", metaKey: true });

      expect(mockSendDialogEvent).not.toHaveBeenCalled();
    });

    it("plain Enter on the form root does not submit", async () => {
      renderForm(keyConfig);

      await fireEvent.keyDown(document.querySelector(".form")!, { key: "Enter" });

      expect(mockSendDialogEvent).not.toHaveBeenCalled();
    });

    describe("Tab trap", () => {
      // Multiline inputs render as native <textarea>s — focusable in happy-dom,
      // unlike the vscode-elements web components whose internals aren't wired.
      const trapConfig: DialogConfig = {
        sections: [
          { type: "input", id: "first", label: "First", multiline: true },
          { type: "input", id: "last", label: "Last", multiline: true },
        ],
      };

      function getTextareas(): [HTMLTextAreaElement, HTMLTextAreaElement] {
        const areas = document.querySelectorAll("textarea");
        return [areas[0] as HTMLTextAreaElement, areas[1] as HTMLTextAreaElement];
      }

      it("Tab on the last control wraps to the first", async () => {
        renderForm(trapConfig);
        const [first, last] = getTextareas();

        last.focus();
        await fireEvent.keyDown(last, { key: "Tab" });

        expect(document.activeElement).toBe(first);
      });

      it("Shift+Tab on the first control wraps to the last", async () => {
        renderForm(trapConfig);
        const [first, last] = getTextareas();

        first.focus();
        await fireEvent.keyDown(first, { key: "Tab", shiftKey: true });

        expect(document.activeElement).toBe(last);
      });
    });
  });

  // ---- Autofocus ----

  describe("autofocus", () => {
    const twoDropdowns = (target: "a" | "b"): DialogConfig => ({
      sections: [
        {
          type: "dropdown",
          id: "a",
          suggestions: [{ items: [{ value: "x", label: "x" }] }],
          ...(target === "a" && { autofocus: true }),
        },
        {
          type: "dropdown",
          id: "b",
          suggestions: [{ items: [{ value: "y", label: "y" }] }],
          ...(target === "b" && { autofocus: true }),
        },
      ],
    });

    it("focuses the autofocus control on mount", async () => {
      renderForm(twoDropdowns("b"));

      await waitFor(() => {
        expect(document.activeElement?.id).toBe("b-input");
      });
    });

    it("moves focus when an update moves the autofocus target", async () => {
      const { rerender } = renderForm(twoDropdowns("a"));

      await waitFor(() => {
        expect(document.activeElement?.id).toBe("a-input");
      });

      await rerender({ dialogId: "test-dialog", config: twoDropdowns("b") });

      await waitFor(() => {
        expect(document.activeElement?.id).toBe("b-input");
      });
    });

    it("does not steal focus when an update re-sends the same target", async () => {
      const { rerender } = renderForm(twoDropdowns("a"));

      await waitFor(() => {
        expect(document.activeElement?.id).toBe("a-input");
      });

      // User moves focus manually...
      (document.getElementById("b-input") as HTMLInputElement).focus();
      // ...then the backend re-sends a config with the unchanged target.
      await rerender({ dialogId: "test-dialog", config: twoDropdowns("a") });
      // Give the (absent) focus timeout a tick.
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(document.activeElement?.id).toBe("b-input");
    });

    it("keeps focus when an update inserts sections above the focused control (stable keys)", async () => {
      // Mirrors a confirm dialog whose async warnings arrive while the Cancel
      // button holds focus: the group keeps its identity-derived key, so its
      // DOM survives the insertion and focus never leaves.
      const buttonConfig = (withWarning: boolean): DialogConfig => ({
        sections: [
          ...(withWarning ? [{ type: "text", content: "Careful", style: "warning" } as const] : []),
          {
            type: "group",
            items: [
              { type: "button", id: "ok", label: "OK", variant: "primary" },
              { type: "button", id: "cancel", label: "Cancel", autofocus: true },
            ],
          },
        ],
      });
      const { rerender } = renderForm(buttonConfig(false));

      await waitFor(() => {
        expect(document.activeElement?.textContent).toContain("Cancel");
      });
      const focusedBefore = document.activeElement;

      await rerender({ dialogId: "test-dialog", config: buttonConfig(true) });

      // Synchronous, same node: focus was never dropped (no restore needed).
      expect(document.activeElement).toBe(focusedBefore);
    });

    it("restores the autofocus target when an update genuinely orphans focus", async () => {
      // The group's identity changes (different sibling button id), so its
      // DOM is recreated and focus drops to <body>; the safety net restores
      // the autofocus target.
      const groupConfig = (okId: string): DialogConfig => ({
        sections: [
          {
            type: "group",
            items: [
              { type: "button", id: okId, label: "OK", variant: "primary" },
              { type: "button", id: "cancel", label: "Cancel", autofocus: true },
            ],
          },
        ],
      });
      const { rerender } = renderForm(groupConfig("ok"));

      await waitFor(() => {
        expect(document.activeElement?.textContent).toContain("Cancel");
      });

      await rerender({ dialogId: "test-dialog", config: groupConfig("proceed") });

      await waitFor(() => {
        expect(document.activeElement?.textContent).toContain("Cancel");
      });
    });

    // ---- Default focus (no explicit autofocus flag) ----

    it("defaults focus to the first enabled field on mount", async () => {
      renderForm({
        sections: [
          {
            type: "dropdown",
            id: "region",
            suggestions: [{ items: [{ value: "x", label: "x" }] }],
          },
          {
            type: "group",
            items: [
              {
                type: "button",
                id: "cancel",
                label: "Cancel",
                variant: "secondary",
                role: "cancel",
              },
              { type: "button", id: "ok", label: "OK", variant: "primary" },
            ],
          },
        ],
      });

      await waitFor(() => {
        expect(document.activeElement?.id).toBe("region-input");
      });
    });

    it("defaults focus to the primary button when there are no fields", async () => {
      renderForm({
        sections: [
          { type: "text", content: "Removing workspace", style: "heading" },
          {
            type: "group",
            items: [
              { type: "button", id: "retry", label: "Kill & Retry", variant: "primary" },
              {
                type: "button",
                id: "dismiss",
                label: "Dismiss",
                variant: "secondary",
                role: "cancel",
              },
            ],
          },
        ],
      });

      await waitFor(() => {
        expect(document.activeElement?.textContent).toContain("Kill & Retry");
      });
    });

    it("defaults focus to the selected radio card (subsumes the old fallback)", async () => {
      renderForm({
        sections: [
          {
            type: "radio",
            id: "agent",
            options: [
              { id: "claude", label: "Claude" },
              { id: "opencode", label: "OpenCode" },
            ],
          },
          {
            type: "group",
            items: [{ type: "button", id: "go", label: "Go", variant: "primary" }],
          },
        ],
      });

      await waitFor(() => {
        expect(document.activeElement).toHaveAttribute("role", "radio");
        expect(document.activeElement).toHaveAttribute("aria-checked", "true");
      });
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
});
