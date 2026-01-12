/**
 * Tests for the SetupScreen component.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import SetupScreen from "./SetupScreen.svelte";

describe("SetupScreen component", () => {
  it("renders heading with 'Setting up CodeHydra' text", () => {
    render(SetupScreen);

    expect(screen.getByRole("heading", { name: /setting up codehydra/i })).toBeInTheDocument();
  });

  it("renders Logo with animation", () => {
    const { container } = render(SetupScreen);

    const logo = container.querySelector("img");
    expect(logo).toBeInTheDocument();
    expect(logo).toHaveClass("animated");
  });

  it("displays static first-startup message", () => {
    render(SetupScreen);

    expect(screen.getByText("This is only required on first startup.")).toBeInTheDocument();
  });

  it("renders without props (no props required)", () => {
    // Should render successfully without any props
    const { container } = render(SetupScreen);
    expect(container.querySelector(".setup-screen")).toBeInTheDocument();
  });

  describe("3-row layout", () => {
    it("renders 3 progress rows (VSCode, Agent, Setup)", () => {
      const { container } = render(SetupScreen);

      const rows = container.querySelectorAll(".row");
      expect(rows.length).toBe(3);

      // Check labels
      expect(screen.getByText("VSCode")).toBeInTheDocument();
      expect(screen.getByText("Agent")).toBeInTheDocument();
      expect(screen.getByText("Setup")).toBeInTheDocument();
    });

    it("renders vscode-progress-bar components for each row", () => {
      const { container } = render(SetupScreen);

      // Should have 3 progress bars (one per row)
      const progressBars = container.querySelectorAll("vscode-progress-bar");
      expect(progressBars.length).toBe(3);
    });

    it("shows agent name when agent prop is provided", () => {
      render(SetupScreen, { props: { agent: "claude" } });

      // Should show "Claude" instead of "Agent"
      expect(screen.getByText("Claude")).toBeInTheDocument();
      expect(screen.queryByText("Agent")).not.toBeInTheDocument();
    });

    it("shows OpenCode when agent prop is opencode", () => {
      render(SetupScreen, { props: { agent: "opencode" } });

      // Should show "OpenCode" instead of "Agent"
      expect(screen.getByText("OpenCode")).toBeInTheDocument();
      expect(screen.queryByText("Agent")).not.toBeInTheDocument();
    });
  });

  describe("accessibility", () => {
    it("has aria-label on progress bars for screen readers", () => {
      const { container } = render(SetupScreen);

      const progressBars = container.querySelectorAll("vscode-progress-bar");
      expect(progressBars[0]).toHaveAttribute("aria-label", "VSCode progress");
      expect(progressBars[1]).toHaveAttribute("aria-label", "Agent progress");
      expect(progressBars[2]).toHaveAttribute("aria-label", "Setup progress");
    });

    it("has aria-live on progress container for screen reader announcements", () => {
      const { container } = render(SetupScreen);

      // The progress container has aria-live for announcing status changes
      const progressContainer = container.querySelector(".progress-container");
      expect(progressContainer).toHaveAttribute("role", "status");
      expect(progressContainer).toHaveAttribute("aria-live", "polite");
    });
  });

  describe("progress updates", () => {
    it("progress updates correct row", () => {
      const progress = [
        { id: "vscode" as const, status: "done" as const },
        { id: "agent" as const, status: "running" as const, progress: 50 },
        { id: "setup" as const, status: "pending" as const },
      ];

      const { container } = render(SetupScreen, { props: { progress } });

      const rows = container.querySelectorAll(".row");
      expect(rows.length).toBe(3);

      // Verify rows render correctly based on progress prop
      // VSCode row should show "Complete" message for done status
      const vscodeRow = rows[0];
      expect(vscodeRow?.querySelector(".row-status.status-done")).toBeInTheDocument();

      // Agent row should show running status (has message with percentage)
      const agentRow = rows[1];
      expect(agentRow?.textContent).toContain("Downloading 50%");

      // Setup row should show pending status (empty message)
      const setupRow = rows[2];
      const setupMessage = setupRow?.querySelector(".row-message");
      expect(setupMessage?.textContent?.trim()).toBe("");
    });

    it("progress bar shows correct percentage", () => {
      const progress = [
        { id: "vscode" as const, status: "running" as const, progress: 42 },
        { id: "agent" as const, status: "pending" as const },
        { id: "setup" as const, status: "pending" as const },
      ];

      const { container } = render(SetupScreen, { props: { progress } });

      const progressBars = container.querySelectorAll("vscode-progress-bar");
      // VSCode row progress bar should show 42%
      expect(progressBars[0]).toHaveAttribute("aria-valuenow", "42");
    });
  });

  describe("error state", () => {
    it("error state shows retry controls", async () => {
      const onretry = vi.fn();
      const onquit = vi.fn();
      const progress = [
        { id: "vscode" as const, status: "done" as const },
        { id: "agent" as const, status: "failed" as const, error: "Download failed" },
        { id: "setup" as const, status: "pending" as const },
      ];

      render(SetupScreen, { props: { progress, onretry, onquit } });

      // Retry and Quit buttons should be visible (vscode-button found by text)
      expect(screen.getByText("Retry")).toBeInTheDocument();
      expect(screen.getByText("Quit")).toBeInTheDocument();
    });

    it("failed row shows error styling", () => {
      const progress = [
        { id: "vscode" as const, status: "done" as const },
        { id: "agent" as const, status: "failed" as const, error: "Download failed" },
        { id: "setup" as const, status: "pending" as const },
      ];

      const { container } = render(SetupScreen, { props: { progress } });

      // Agent row should have row-failed class
      const rows = container.querySelectorAll(".row");
      expect(rows[1]).toHaveClass("row-failed");

      // Error styling should be shown via status-failed class
      const agentStatus = rows[1]?.querySelector(".row-status.status-failed");
      expect(agentStatus).toBeInTheDocument();
    });

    it("shows error message in failed row", () => {
      const progress = [
        { id: "vscode" as const, status: "done" as const },
        { id: "agent" as const, status: "failed" as const, error: "Network timeout" },
        { id: "setup" as const, status: "pending" as const },
      ];

      render(SetupScreen, { props: { progress } });

      // Error message should be visible
      expect(screen.getByText("Network timeout")).toBeInTheDocument();
    });

    it("retry button calls onretry callback", async () => {
      const onretry = vi.fn();
      const onquit = vi.fn();
      const progress = [
        { id: "vscode" as const, status: "failed" as const, error: "Failed" },
        { id: "agent" as const, status: "pending" as const },
        { id: "setup" as const, status: "pending" as const },
      ];

      const { container } = render(SetupScreen, { props: { progress, onretry, onquit } });

      // Use querySelector for vscode-button since it may not have button role in happy-dom
      const retryButton = container.querySelector("vscode-button");
      expect(retryButton).toBeInTheDocument();
      await fireEvent.click(retryButton!);

      expect(onretry).toHaveBeenCalledTimes(1);
    });

    it("quit button calls onquit callback", async () => {
      const onretry = vi.fn();
      const onquit = vi.fn();
      const progress = [
        { id: "vscode" as const, status: "failed" as const, error: "Failed" },
        { id: "agent" as const, status: "pending" as const },
        { id: "setup" as const, status: "pending" as const },
      ];

      const { container } = render(SetupScreen, { props: { progress, onretry, onquit } });

      // Get second vscode-button (Quit is after Retry)
      const buttons = container.querySelectorAll("vscode-button");
      const quitButton = buttons[1];
      expect(quitButton).toBeInTheDocument();
      await fireEvent.click(quitButton!);

      expect(onquit).toHaveBeenCalledTimes(1);
    });

    it("does not show buttons when no callbacks provided", () => {
      const progress = [
        { id: "vscode" as const, status: "failed" as const, error: "Failed" },
        { id: "agent" as const, status: "pending" as const },
        { id: "setup" as const, status: "pending" as const },
      ];

      const { container } = render(SetupScreen, { props: { progress } });

      // Buttons should not be present
      const buttons = container.querySelectorAll("vscode-button");
      expect(buttons.length).toBe(0);
    });
  });
});
