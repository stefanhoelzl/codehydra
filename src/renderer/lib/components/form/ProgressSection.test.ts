/**
 * Tests for ProgressSection component.
 * Rendering of progress items, status indicators, and progress bars.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen } from "@testing-library/svelte";
import ProgressSection from "./ProgressSection.svelte";
import type { ProgressSectionConfig } from "./types";

function renderSection(section: ProgressSectionConfig) {
  return render(ProgressSection, { props: { section } });
}

describe("ProgressSection component", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders progress items with labels", () => {
    renderSection({
      type: "progress",
      items: [
        { id: "step-1", label: "Downloading", status: "done" },
        { id: "step-2", label: "Installing", status: "running" },
      ],
    });

    expect(screen.getByText("Downloading")).toBeInTheDocument();
    expect(screen.getByText("Installing")).toBeInTheDocument();
  });

  it("shows indeterminate progress bar for running items without progress value", () => {
    renderSection({
      type: "progress",
      items: [{ id: "step-1", label: "Loading", status: "running" }],
    });

    const progressBar = document.querySelector("vscode-progress-bar");
    expect(progressBar).toBeInTheDocument();
    // In Svelte, boolean props on custom elements are set as DOM properties.
    // Verify the aria-label identifies the running item's progress bar.
    expect(progressBar).toHaveAttribute("aria-label", "Loading progress");
  });

  it("renders an error item's message as the error detail line", () => {
    renderSection({
      type: "progress",
      items: [{ id: "step-1", label: "Cloning", status: "error", message: "access denied" }],
    });

    const detail = document.querySelector(".progress-error-detail");
    expect(detail).toHaveTextContent("access denied");
  });

  it("omits progress bars in spinner style", () => {
    renderSection({
      type: "progress",
      style: "spinner",
      items: [{ id: "step-1", label: "Loading", status: "running" }],
    });

    expect(document.querySelector("vscode-progress-bar")).not.toBeInTheDocument();
  });
});
