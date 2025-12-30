/**
 * Tests for the SetupError component.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/svelte";
import SetupError from "./SetupError.svelte";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// Get the current directory for reading component files
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

  it("renders Logo without animation", () => {
    const { container } = render(SetupError, { props: { errorMessage: "Test error" } });

    const logo = container.querySelector("img");
    expect(logo).toBeInTheDocument();
    expect(logo).not.toHaveClass("animated");
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
      const { container } = render(SetupError, { props: { errorMessage: "Test error" } });

      // vscode-button is a web component; query by tag name and text content
      const retryButton = container.querySelector("vscode-button");
      expect(retryButton).toBeInTheDocument();
      expect(retryButton?.textContent).toMatch(/retry/i);
    });

    it("renders Quit button", () => {
      const { container } = render(SetupError, { props: { errorMessage: "Test error" } });

      // vscode-button is a web component; query by tag name
      const buttons = container.querySelectorAll("vscode-button");
      expect(buttons).toHaveLength(2);
      expect(buttons[1]?.textContent).toMatch(/quit/i);
    });

    it("auto-focuses the Retry button", async () => {
      const { container } = render(SetupError, { props: { errorMessage: "Test error" } });

      // Wait for the auto-focus to apply (on mount)
      await waitFor(() => {
        const retryButton = container.querySelector("vscode-button");
        expect(retryButton).toHaveFocus();
      });
    });
  });

  describe("events", () => {
    it("emits retry event when Retry button is clicked", async () => {
      const onRetry = vi.fn();
      const { container } = render(SetupError, {
        props: { errorMessage: "Test error", onretry: onRetry },
      });

      // vscode-button is a web component; query by tag name
      const retryButton = container.querySelector("vscode-button");
      await fireEvent.click(retryButton!);

      expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it("emits quit event when Quit button is clicked", async () => {
      const onQuit = vi.fn();
      const { container } = render(SetupError, {
        props: { errorMessage: "Test error", onquit: onQuit },
      });

      // vscode-button is a web component; second button is Quit
      const buttons = container.querySelectorAll("vscode-button");
      await fireEvent.click(buttons[1]!);

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

  describe("theme variables", () => {
    // Read CSS from component file to verify variable usage
    const componentCss = readFileSync(join(__dirname, "SetupError.svelte"), "utf-8");

    it("heading uses var(--ch-danger) for red color", () => {
      expect(componentCss).toMatch(/h1[^{]*\{[^}]*var\(--ch-danger/);
    });

    it("uses vscode-button for button styling", () => {
      // Verify we're using vscode-button web component (styling is handled by the component)
      expect(componentCss).toContain("vscode-button");
    });
  });
});
