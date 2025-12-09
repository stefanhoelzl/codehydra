/**
 * Tests for the SetupError component.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/svelte";
import SetupError from "./SetupError.svelte";

describe("SetupError component", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders heading with 'Setup Failed' text", () => {
    render(SetupError, { props: { errorMessage: "Test error" } });

    expect(screen.getByRole("heading", { name: /setup failed/i })).toBeInTheDocument();
  });

  it("displays the error message", () => {
    render(SetupError, { props: { errorMessage: "Failed to install extensions" } });

    expect(screen.getByText(/failed to install extensions/i)).toBeInTheDocument();
  });

  describe("accessibility", () => {
    it("has role='alert' on error container", () => {
      render(SetupError, { props: { errorMessage: "Test error" } });

      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    it("contains the error message in the alert region", () => {
      render(SetupError, { props: { errorMessage: "Network failure" } });

      const alert = screen.getByRole("alert");
      expect(alert).toHaveTextContent(/network failure/i);
    });
  });

  describe("buttons", () => {
    it("renders Retry button", () => {
      render(SetupError, { props: { errorMessage: "Test error" } });

      expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    });

    it("renders Quit button", () => {
      render(SetupError, { props: { errorMessage: "Test error" } });

      expect(screen.getByRole("button", { name: /quit/i })).toBeInTheDocument();
    });

    it("auto-focuses the Retry button", async () => {
      render(SetupError, { props: { errorMessage: "Test error" } });

      // Wait for the auto-focus to apply (on mount)
      await waitFor(() => {
        expect(screen.getByRole("button", { name: /retry/i })).toHaveFocus();
      });
    });
  });

  describe("events", () => {
    it("emits retry event when Retry button is clicked", async () => {
      const onRetry = vi.fn();
      render(SetupError, { props: { errorMessage: "Test error", onretry: onRetry } });

      const retryButton = screen.getByRole("button", { name: /retry/i });
      await fireEvent.click(retryButton);

      expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it("emits quit event when Quit button is clicked", async () => {
      const onQuit = vi.fn();
      render(SetupError, { props: { errorMessage: "Test error", onquit: onQuit } });

      const quitButton = screen.getByRole("button", { name: /quit/i });
      await fireEvent.click(quitButton);

      expect(onQuit).toHaveBeenCalledTimes(1);
    });

    it("emits quit event when Escape key is pressed", async () => {
      const onQuit = vi.fn();
      render(SetupError, { props: { errorMessage: "Test error", onquit: onQuit } });

      // Focus on the component area and press Escape
      await fireEvent.keyDown(document, { key: "Escape" });

      expect(onQuit).toHaveBeenCalledTimes(1);
    });
  });

  describe("user-friendly messages", () => {
    it("shows connection hint for network errors", () => {
      render(SetupError, { props: { errorMessage: "Test error" } });

      expect(screen.getByText(/check your internet connection/i)).toBeInTheDocument();
    });
  });
});
