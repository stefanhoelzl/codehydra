/**
 * Tests for CheckboxSection component.
 * Controlled checkbox leaf: renders the inline label, reports toggles via
 * onToggle, shows error helper text, honors disabled.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent } from "@testing-library/svelte";
import CheckboxSection from "./CheckboxSection.svelte";
import type { CheckboxSectionConfig } from "./types";

function renderSection(
  section: CheckboxSectionConfig,
  options?: { value?: string; onToggle?: (checked: boolean) => void }
) {
  return render(CheckboxSection, {
    props: {
      section,
      value: options?.value ?? "false",
      onToggle: options?.onToggle ?? vi.fn(),
    },
  });
}

function getCheckbox(): HTMLElement & { checked: boolean; label: string; disabled: boolean } {
  return document.querySelector("vscode-checkbox") as HTMLElement & {
    checked: boolean;
    label: string;
    disabled: boolean;
  };
}

describe("CheckboxSection component", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders a vscode-checkbox with the inline label", () => {
    renderSection({ type: "checkbox", id: "keep", label: "Keep branch" });

    const checkbox = getCheckbox();
    expect(checkbox).toBeInTheDocument();
    // Svelte assigns custom-element properties, not attributes.
    expect(checkbox.label).toBe("Keep branch");
    expect(checkbox).toHaveAttribute("id", "keep");
  });

  it("reports toggles through onToggle with the new checked state", async () => {
    const onToggle = vi.fn();
    renderSection({ type: "checkbox", id: "keep", label: "Keep branch" }, { onToggle });

    const checkbox = getCheckbox();
    checkbox.checked = true;
    await fireEvent(checkbox, new Event("change", { bubbles: true }));

    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it("renders the disabled state", () => {
    renderSection({ type: "checkbox", id: "keep", label: "Keep branch", disabled: true });

    expect(getCheckbox().disabled).toBe(true);
  });

  it("renders error helper text below the control", () => {
    renderSection({ type: "checkbox", id: "keep", label: "Keep branch", error: "Nope" });

    const helper = document.querySelector("vscode-form-helper");
    expect(helper).toBeInTheDocument();
    expect(helper).toHaveTextContent("Nope");
  });
});
