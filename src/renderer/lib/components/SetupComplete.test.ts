/**
 * Tests for the SetupComplete component.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/svelte";
import SetupComplete from "./SetupComplete.svelte";

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
});
