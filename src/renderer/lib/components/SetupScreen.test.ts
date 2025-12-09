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
    it("has progressbar role", () => {
      render(SetupScreen, { props: { currentStep: "Loading..." } });

      expect(screen.getByRole("progressbar")).toBeInTheDocument();
    });

    it("has aria-busy attribute on progressbar", () => {
      render(SetupScreen, { props: { currentStep: "Loading..." } });

      const progressbar = screen.getByRole("progressbar");
      expect(progressbar).toHaveAttribute("aria-busy", "true");
    });

    it("has aria-label for screen readers", () => {
      render(SetupScreen, { props: { currentStep: "Loading..." } });

      const progressbar = screen.getByRole("progressbar");
      expect(progressbar).toHaveAttribute("aria-label", "Setting up VSCode");
    });

    it("has aria-live on step message for progress announcements", () => {
      render(SetupScreen, { props: { currentStep: "Installing extensions..." } });

      const stepMessage = screen.getByText("Installing extensions...");
      expect(stepMessage).toHaveAttribute("aria-live", "polite");
    });
  });
});
