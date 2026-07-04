/**
 * Tests for RadioSection component.
 * Controlled radio cards: rendering from the value prop, click/keyboard
 * interaction reporting (onSelect/onSubmit), label, error, and disabled
 * states. The value round-trip (callback -> state -> prop) is covered in
 * Form tests.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/svelte";
import RadioSection from "./RadioSection.svelte";
import type { FormLayout, RadioSectionConfig } from "./types";

const twoOptions: RadioSectionConfig = {
  type: "radio",
  id: "choice",
  options: [
    { id: "opt-a", label: "Option A" },
    { id: "opt-b", label: "Option B" },
  ],
};

function renderRadio(
  section: RadioSectionConfig,
  options?: { value?: string; layout?: FormLayout }
) {
  const onSelect = vi.fn();
  const onSubmit = vi.fn();
  render(RadioSection, {
    props: {
      section,
      value: options?.value ?? section.options[0]?.id ?? "",
      layout: options?.layout ?? "centered",
      onSelect,
      onSubmit,
    },
  });
  return { onSelect, onSubmit };
}

describe("RadioSection component", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders radio cards with labels", () => {
    renderRadio(twoOptions);

    expect(screen.getByText("Option A")).toBeInTheDocument();
    expect(screen.getByText("Option B")).toBeInTheDocument();
  });

  it("checks the card matching the value prop and makes it the tab stop", () => {
    renderRadio(twoOptions, { value: "opt-b" });

    const radios = screen.getAllByRole("radio");
    expect(radios[0]).toHaveAttribute("aria-checked", "false");
    expect(radios[0]).toHaveAttribute("tabindex", "-1");
    expect(radios[1]).toHaveAttribute("aria-checked", "true");
    expect(radios[1]).toHaveAttribute("tabindex", "0");
  });

  it("clicking a card reports its option id", async () => {
    const { onSelect } = renderRadio(twoOptions);

    await fireEvent.click(screen.getAllByRole("radio")[1]!);

    expect(onSelect).toHaveBeenCalledWith("opt-b");
  });

  it("Space reports the focused card's option id", async () => {
    const { onSelect } = renderRadio(twoOptions, { value: "opt-b" });

    await fireEvent.keyDown(screen.getAllByRole("radio")[1]!, { key: " " });

    expect(onSelect).toHaveBeenCalledWith("opt-b");
  });

  it("arrow keys report the neighbouring option and move focus", async () => {
    const { onSelect } = renderRadio(twoOptions);

    const radios = screen.getAllByRole("radio");
    await fireEvent.keyDown(radios[0]!, { key: "ArrowDown" });

    expect(onSelect).toHaveBeenCalledWith("opt-b");
    await waitFor(() => {
      expect(document.activeElement).toBe(radios[1]);
    });
  });

  it("arrow navigation wraps around the ends", async () => {
    const { onSelect } = renderRadio(twoOptions);

    await fireEvent.keyDown(screen.getAllByRole("radio")[0]!, { key: "ArrowUp" });

    expect(onSelect).toHaveBeenCalledWith("opt-b");
  });

  it("Enter activates the form's primary action (onSubmit) without re-selecting", async () => {
    const { onSelect, onSubmit } = renderRadio(twoOptions);

    await fireEvent.keyDown(screen.getAllByRole("radio")[0]!, { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("marks the selected card data-autofocus only when the section opts in", () => {
    const { unmount } = render(RadioSection, {
      props: { section: twoOptions, value: "opt-b", layout: "centered", onSelect: vi.fn() },
    });
    // No autofocus flag → no card is a focus target.
    expect(document.querySelector("[data-autofocus]")).toBeNull();
    unmount();

    renderRadio({ ...twoOptions, autofocus: true }, { value: "opt-b" });
    // The flag lands on the selected (tabbable) card, so the form's focus-follow
    // can move focus onto it when this section replaces another on a config push.
    const focusTarget = document.querySelector("[data-autofocus]");
    expect(focusTarget).toHaveAttribute("data-option", "opt-b");
  });

  it("disables all cards when the section is disabled", () => {
    renderRadio({ ...twoOptions, disabled: true });

    for (const radio of screen.getAllByRole("radio")) {
      expect(radio).toBeDisabled();
    }
  });

  it("names the selection group from its label via aria-label", () => {
    renderRadio({ ...twoOptions, label: "Agent" });

    expect(document.querySelector("vscode-label")).toHaveTextContent("Agent");
    expect(screen.getByRole("radiogroup")).toHaveAttribute("aria-label", "Agent");
  });

  it("renders the error below the cards and outlines the group", () => {
    renderRadio({ ...twoOptions, id: "agent", error: "Pick an agent" });

    const group = screen.getByRole("radiogroup");
    expect(group).toHaveClass("errored");
    expect(group).toHaveAttribute("aria-describedby", "agent-error");
    const helper = document.querySelector("vscode-form-helper");
    expect(helper).toHaveAttribute("id", "agent-error");
    expect(helper?.querySelector(".field-error")).toHaveTextContent("Pick an agent");
  });

  it("left-aligns the card row in the form layout", () => {
    renderRadio(twoOptions, { layout: "form" });

    expect(document.querySelector(".radio-cards")).toHaveClass("layout-form");
  });
});
