/**
 * Tests for FormButton component.
 * Rendering of label/icon/busy states and click reporting. Click suppression
 * for disabled/busy buttons is the owner's concern (covered in Form tests).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import FormButton from "./FormButton.svelte";
import type { ButtonItem } from "./types";

function renderButton(button: ButtonItem, onClick = vi.fn()) {
  render(FormButton, { props: { button, onClick } });
  return onClick;
}

describe("FormButton component", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders the label", () => {
    renderButton({ type: "button", id: "go", label: "Go" });

    expect(screen.getByText("Go")).toBeInTheDocument();
  });

  it("renders icon-only buttons with title doubling as accessible name", () => {
    renderButton({
      type: "button",
      id: "open-folder",
      icon: "folder-opened",
      title: "Open project folder",
    });

    const button = document.querySelector("vscode-button");
    expect(button).toHaveClass("icon-button");
    expect(button).toHaveAttribute("title", "Open project folder");
    expect(button).toHaveAttribute("aria-label", "Open project folder");
  });

  it("renders the secondary variant via the secondary property", () => {
    renderButton({ type: "button", id: "cancel", label: "Cancel", variant: "secondary" });

    // Svelte sets custom-element fields as DOM properties, not attributes.
    const button = document.querySelector("vscode-button") as unknown as { secondary?: boolean };
    expect(button.secondary).toBe(true);
  });

  it("busy buttons show busyLabel and are disabled", () => {
    renderButton({
      type: "button",
      id: "submit",
      label: "Submit",
      busy: true,
      busyLabel: "Submitting...",
    });

    expect(screen.getByText("Submitting...")).toBeInTheDocument();
    expect(screen.queryByText("Submit")).not.toBeInTheDocument();
    // Svelte sets custom-element fields as DOM properties, not attributes.
    const button = document.querySelector("vscode-button") as unknown as { disabled?: boolean };
    expect(button.disabled).toBe(true);
  });

  it("reports a click via onClick", async () => {
    const onClick = renderButton({ type: "button", id: "go", label: "Go" });

    await fireEvent.click(screen.getByText("Go"));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("marks the autofocus target via data-autofocus", () => {
    renderButton({ type: "button", id: "go", label: "Go", autofocus: true });

    expect(document.querySelector("vscode-button")).toHaveAttribute("data-autofocus");
  });
});
