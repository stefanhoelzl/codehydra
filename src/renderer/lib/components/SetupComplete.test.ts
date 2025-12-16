/**
 * Tests for the SetupComplete component.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/svelte";
import SetupComplete from "./SetupComplete.svelte";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// Get the current directory for reading component files
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("SetupComplete component", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("renders success message", () => {
    render(SetupComplete, { props: {} });

    expect(screen.getByText(/setup complete/i)).toBeInTheDocument();
  });

  it("renders checkmark symbol", () => {
    render(SetupComplete, { props: {} });

    // Check for a checkmark - could be text or icon
    const checkElement = screen.getByRole("status");
    expect(checkElement).toBeInTheDocument();
  });

  it("renders Logo without animation", () => {
    const { container } = render(SetupComplete, { props: {} });

    const logo = container.querySelector("img");
    expect(logo).toBeInTheDocument();
    expect(logo).not.toHaveClass("animated");
  });

  describe("accessibility", () => {
    it("has role='status' for announcements", () => {
      render(SetupComplete, { props: {} });

      expect(screen.getByRole("status")).toBeInTheDocument();
    });

    it("has aria-live='polite' for screen reader updates", () => {
      render(SetupComplete, { props: {} });

      const status = screen.getByRole("status");
      expect(status).toHaveAttribute("aria-live", "polite");
    });
  });

  describe("auto-transition", () => {
    it("emits complete event after 1.5 seconds", async () => {
      const oncomplete = vi.fn();
      render(SetupComplete, { props: { oncomplete } });

      expect(oncomplete).not.toHaveBeenCalled();

      // Advance timer by 1.5 seconds
      vi.advanceTimersByTime(1500);

      await waitFor(() => {
        expect(oncomplete).toHaveBeenCalledTimes(1);
      });
    });

    it("does not emit complete event before 1.5 seconds", () => {
      const oncomplete = vi.fn();
      render(SetupComplete, { props: { oncomplete } });

      // Advance only 1.4 seconds
      vi.advanceTimersByTime(1400);

      expect(oncomplete).not.toHaveBeenCalled();
    });
  });

  describe("theme variables (Step 6)", () => {
    // Read CSS from component file to verify variable usage
    const componentCss = readFileSync(join(__dirname, "SetupComplete.svelte"), "utf-8");

    it("checkmark uses var(--ch-success) for green color", () => {
      expect(componentCss).toMatch(/\.checkmark[^{]*\{[^}]*var\(--ch-success/);
    });
  });
});
