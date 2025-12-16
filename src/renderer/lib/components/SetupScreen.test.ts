/**
 * Tests for the SetupScreen component.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/svelte";
import SetupScreen from "./SetupScreen.svelte";

describe("SetupScreen component", () => {
  it("renders heading with correct text", () => {
    render(SetupScreen, { props: { currentStep: "Installing extensions..." } });

    expect(screen.getByRole("heading", { name: /setting up vscode/i })).toBeInTheDocument();
  });

  it("renders Logo with animation", () => {
    const { container } = render(SetupScreen, {
      props: { currentStep: "Installing extensions..." },
    });

    const logo = container.querySelector("img");
    expect(logo).toBeInTheDocument();
    expect(logo).toHaveClass("animated");
  });

  it("displays current step message", () => {
    render(SetupScreen, { props: { currentStep: "Installing extensions..." } });

    expect(screen.getByText("Installing extensions...")).toBeInTheDocument();
  });

  it("updates step message when prop changes", async () => {
    const { rerender } = render(SetupScreen, { props: { currentStep: "Step 1" } });

    expect(screen.getByText("Step 1")).toBeInTheDocument();

    await rerender({ currentStep: "Step 2" });

    expect(screen.getByText("Step 2")).toBeInTheDocument();
  });

  describe("accessibility", () => {
    it("renders vscode-progress-bar component", () => {
      const { container } = render(SetupScreen, { props: { currentStep: "Loading..." } });

      // Web components are queried by tag name since shadow DOM isn't accessible in JSDOM
      const progressBar = container.querySelector("vscode-progress-bar");
      expect(progressBar).toBeInTheDocument();
    });

    it("has indeterminate property set on progress bar", () => {
      const { container } = render(SetupScreen, { props: { currentStep: "Loading..." } });

      const progressBar = container.querySelector("vscode-progress-bar") as HTMLElement & {
        indeterminate?: boolean;
      };
      // Svelte sets boolean props as JavaScript properties on web components
      expect(progressBar?.indeterminate).toBe(true);
    });

    it("has aria-label for screen readers", () => {
      const { container } = render(SetupScreen, { props: { currentStep: "Loading..." } });

      const progressBar = container.querySelector("vscode-progress-bar");
      expect(progressBar).toHaveAttribute("aria-label", "Setting up VSCode");
    });

    it("has aria-live on step message for progress announcements", () => {
      render(SetupScreen, { props: { currentStep: "Installing extensions..." } });

      const stepMessage = screen.getByText("Installing extensions...");
      expect(stepMessage).toHaveAttribute("aria-live", "polite");
    });
  });
});
