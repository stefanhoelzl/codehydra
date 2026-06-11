/**
 * Tests for InputSection component.
 * Controlled text input (single-line vscode-textfield / multiline textarea):
 * rendering from the value prop, interaction reporting (onInput/onSubmit),
 * label, error, disabled, and the seeded-cursor behaviors. Value seeding from
 * initialValue is the owner's reconcile concern (covered in Form tests).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import InputSection from "./InputSection.svelte";
import type { InputSectionConfig } from "./types";

function renderInput(section: InputSectionConfig, value = "") {
  const onInput = vi.fn();
  const onSubmit = vi.fn();
  render(InputSection, { props: { section, value, onInput, onSubmit } });
  return { onInput, onSubmit };
}

describe("InputSection component", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders a single-line textfield displaying the value", () => {
    renderInput({ type: "input", id: "url", placeholder: "Repo URL" }, "org/repo");

    const field = document.querySelector("vscode-textfield");
    expect(field).toHaveAttribute("id", "url");
    // Svelte sets custom-element fields as DOM properties, not attributes.
    expect((field as HTMLInputElement).placeholder).toBe("Repo URL");
    expect((field as HTMLInputElement).value).toBe("org/repo");
  });

  it("typing reports the new text via onInput", async () => {
    const { onInput } = renderInput({ type: "input", id: "url" });

    await fireEvent.input(document.getElementById("url")!, { target: { value: "org/repo" } });

    expect(onInput).toHaveBeenCalledWith("org/repo");
  });

  it("Enter in a single-line input reports onSubmit", async () => {
    const { onSubmit } = renderInput({ type: "input", id: "url" });

    await fireEvent.keyDown(document.getElementById("url")!, { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("disables a single-line input", () => {
    renderInput({ type: "input", id: "field", disabled: true });

    // vscode-textfield receives `disabled` as a property (custom element).
    const field = document.getElementById("field") as unknown as { disabled?: boolean };
    expect(field.disabled).toBe(true);
  });

  it("disables a multiline input", () => {
    renderInput({ type: "input", id: "field", multiline: true, disabled: true });

    expect(document.getElementById("field")).toBeDisabled();
  });

  it("renders a vscode-label associated with the input via for/id", () => {
    renderInput({ type: "input", id: "branch", label: "Branch name" });

    const label = document.querySelector("vscode-label");
    expect(label).toBeInTheDocument();
    expect(label).toHaveTextContent("Branch name");
    expect(label).toHaveAttribute("for", "branch");

    // The control carries the matching id the label points at.
    expect(document.querySelector("vscode-textfield")).toHaveAttribute("id", "branch");
  });

  it("renders no label element when the field has none", () => {
    renderInput({ type: "input", id: "branch" });

    expect(document.querySelector("vscode-label")).not.toBeInTheDocument();
  });

  it("renders the error below a single-line input and marks the control invalid", () => {
    renderInput({ type: "input", id: "branch", label: "Branch", error: "Branch already exists" });

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
    renderInput({ type: "input", id: "note", multiline: true, error: "Required" });

    const textarea = document.querySelector("textarea");
    expect(textarea).toHaveClass("errored");
    expect(textarea).toHaveAttribute("aria-invalid", "true");
    expect(textarea).toHaveAttribute("aria-describedby", "note-error");
    expect(document.querySelector("vscode-form-helper .field-error")).toHaveTextContent("Required");
  });

  it("renders no error element and no invalid state when error is absent", () => {
    renderInput({ type: "input", id: "branch", label: "Branch" });

    expect(document.querySelector("vscode-form-helper")).not.toBeInTheDocument();
    const field = document.querySelector("vscode-textfield");
    expect(field).not.toHaveAttribute("aria-invalid");
    expect(field).not.toHaveAttribute("aria-describedby");
  });

  it("treats an empty-string error as no error", () => {
    renderInput({ type: "input", id: "branch", error: "" });

    expect(document.querySelector("vscode-form-helper")).not.toBeInTheDocument();
    expect(document.querySelector("vscode-textfield")).not.toHaveAttribute("aria-invalid");
  });

  it("applies `rows` to a multiline textarea and drops the viewport min-height", () => {
    renderInput({ type: "input", id: "prompt", multiline: true, rows: 3 });

    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea).toHaveAttribute("rows", "3");
    expect(textarea.classList.contains("fixed-rows")).toBe(true);
  });

  it("selects the seeded text when selectInitialValue is true", async () => {
    renderInput(
      {
        type: "input",
        id: "desc",
        multiline: true,
        initialValue: "hello world",
        selectInitialValue: true,
      },
      "hello world"
    );

    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea).toBeInTheDocument();
    await waitFor(() => {
      expect(textarea.selectionStart).toBe(0);
      expect(textarea.selectionEnd).toBe("hello world".length);
    });
  });

  it("places caret at cursorOffset when selectInitialValue is not set", async () => {
    renderInput(
      { type: "input", id: "desc", multiline: true, initialValue: "hello world", cursorOffset: 5 },
      "hello world"
    );

    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    await waitFor(() => {
      expect(textarea.selectionStart).toBe(5);
      expect(textarea.selectionEnd).toBe(5);
    });
  });

  it("re-focuses the textarea on Alt keyup when focus was lost to body", async () => {
    renderInput(
      {
        type: "input",
        id: "desc",
        multiline: true,
        initialValue: "hello",
        selectInitialValue: true,
      },
      "hello"
    );

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
