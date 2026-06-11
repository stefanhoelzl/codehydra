/**
 * Tests for DropdownSection component.
 * Controlled combobox leaf: rendering from the display-value prop, suggestion
 * list mapping (groups -> headers), interaction reporting (onPick/onType/
 * onSubmit), label, error, loading, disabled, and searchable states. Value
 * semantics (initialValue, controlled pushes, freeText reporting) are the
 * owner's reconcile concern (covered in Form tests).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import DropdownSection from "./DropdownSection.svelte";
import type { DropdownSectionConfig } from "./types";

const regions: DropdownSectionConfig = {
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
};

function renderDropdown(section: DropdownSectionConfig, value = "") {
  const onPick = vi.fn();
  const onType = vi.fn();
  const onSubmit = vi.fn();
  render(DropdownSection, { props: { section, value, onPick, onType, onSubmit } });
  return { onPick, onType, onSubmit };
}

describe("DropdownSection component", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders a combobox whose list shows the suggestion labels on focus", async () => {
    renderDropdown(regions);

    const input = screen.getByRole("combobox");
    await fireEvent.focus(input);

    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(screen.getByText("US East")).toBeInTheDocument();
    expect(screen.getByText("US West")).toBeInTheDocument();
  });

  it("displays the value prop as the input text", () => {
    renderDropdown(regions, "US West");

    expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe("US West");
  });

  it("reports a picked suggestion's value via onPick", async () => {
    const { onPick } = renderDropdown(regions);

    await fireEvent.focus(screen.getByRole("combobox"));
    // Options select on mousedown (prevents the blur-before-click issue).
    await fireEvent.mouseDown(screen.getByText("US West"));

    expect(onPick).toHaveBeenCalledWith("us-west");
  });

  it("reports typed text via onType", async () => {
    const { onType } = renderDropdown(regions);

    const input = screen.getByRole("combobox");
    await fireEvent.focus(input);
    await fireEvent.input(input, { target: { value: "west" } });

    expect(onType).toHaveBeenCalledWith("west");
  });

  it("Enter with no highlighted suggestion reports onSubmit", async () => {
    const { onSubmit } = renderDropdown(regions);

    const input = screen.getByRole("combobox");
    await fireEvent.focus(input);
    await fireEvent.keyDown(input, { key: "Escape" });
    await fireEvent.keyDown(input, { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("hides a group header while the group has no matching suggestion", async () => {
    renderDropdown({
      type: "dropdown",
      id: "branch",
      suggestions: [
        { header: "Local", items: [{ value: "main", label: "main" }] },
        { header: "Remote", items: [{ value: "origin/feat", label: "feat" }] },
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

  it("renders label and error around the combobox", () => {
    renderDropdown({ ...regions, label: "Region", error: "Unknown region" });

    const label = document.querySelector("vscode-label");
    expect(label).toHaveTextContent("Region");
    expect(label).toHaveAttribute("for", "region-input");

    const input = screen.getByRole("combobox");
    expect(input).toHaveAttribute("id", "region-input");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAttribute("aria-describedby", "region-error");
    expect(input).toHaveClass("invalid");

    const helper = document.querySelector("vscode-form-helper");
    expect(helper).toHaveAttribute("id", "region-error");
    expect(helper?.querySelector(".field-error")).toHaveTextContent("Unknown region");
  });

  it("shows a loading spinner when loading is true", () => {
    renderDropdown({ type: "dropdown", id: "branch", suggestions: [], loading: true });

    const spinner = screen.getByRole("status", { name: "Loading options" });
    expect(spinner).toBeInTheDocument();
  });

  it("shows no spinner when loading is absent", () => {
    renderDropdown(regions);

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("keeps the control interactive while loading", () => {
    renderDropdown({ type: "dropdown", id: "branch", suggestions: [], loading: true });

    expect(screen.getByRole("combobox")).not.toBeDisabled();
  });

  it("disables the dropdown control", () => {
    renderDropdown({ type: "dropdown", id: "base", suggestions: [], disabled: true });

    expect(screen.getByRole("combobox")).toBeDisabled();
  });

  it("searchable: false renders a read-only input", () => {
    renderDropdown({
      type: "dropdown",
      id: "mode",
      searchable: false,
      suggestions: [{ items: [{ value: "", label: "Full permissions" }] }],
    });

    expect(screen.getByRole("combobox")).toHaveAttribute("readonly");
  });
});
