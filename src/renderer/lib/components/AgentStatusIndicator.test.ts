/**
 * Tests for the AgentStatusIndicator component.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/svelte";
import type { Api } from "@shared/electron-api";

// Create mock API
const mockApi: Api = {
  selectFolder: vi.fn().mockResolvedValue(null),
  openProject: vi.fn().mockResolvedValue(undefined),
  closeProject: vi.fn().mockResolvedValue(undefined),
  listProjects: vi.fn().mockResolvedValue([]),
  createWorkspace: vi.fn().mockResolvedValue(undefined),
  removeWorkspace: vi.fn().mockResolvedValue(undefined),
  switchWorkspace: vi.fn().mockResolvedValue(undefined),
  listBases: vi.fn().mockResolvedValue([]),
  updateBases: vi.fn().mockResolvedValue(undefined),
  isWorkspaceDirty: vi.fn().mockResolvedValue(false),
  setDialogMode: vi.fn().mockResolvedValue(undefined),
  focusActiveWorkspace: vi.fn().mockResolvedValue(undefined),
  getAgentStatus: vi.fn().mockResolvedValue({ status: "none", counts: { idle: 0, busy: 0 } }),
  getAllAgentStatuses: vi.fn().mockResolvedValue({}),
  refreshAgentStatus: vi.fn().mockResolvedValue(undefined),
  setupReady: vi.fn().mockResolvedValue(undefined),
  setupRetry: vi.fn().mockResolvedValue(undefined),
  setupQuit: vi.fn().mockResolvedValue(undefined),
  onProjectOpened: vi.fn(() => vi.fn()),
  onProjectClosed: vi.fn(() => vi.fn()),
  onWorkspaceCreated: vi.fn(() => vi.fn()),
  onWorkspaceRemoved: vi.fn(() => vi.fn()),
  onWorkspaceSwitched: vi.fn(() => vi.fn()),
  onShortcutEnable: vi.fn(() => vi.fn()),
  onShortcutDisable: vi.fn(() => vi.fn()),
  onAgentStatusChanged: vi.fn(() => vi.fn()),
  onSetupProgress: vi.fn(() => vi.fn()),
  onSetupComplete: vi.fn(() => vi.fn()),
  onSetupError: vi.fn(() => vi.fn()),
};

// Set up window.api
window.api = mockApi;

// Import after mock setup
import AgentStatusIndicator from "./AgentStatusIndicator.svelte";

describe("AgentStatusIndicator component", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  describe("accessibility", () => {
    it("has role='status' for accessibility", () => {
      render(AgentStatusIndicator, { props: { idleCount: 0, busyCount: 0 } });

      const indicator = screen.getByRole("status");
      expect(indicator).toBeInTheDocument();
    });

    it("has aria-live='polite' for live region updates", () => {
      render(AgentStatusIndicator, { props: { idleCount: 0, busyCount: 0 } });

      const indicator = screen.getByRole("status");
      expect(indicator).toHaveAttribute("aria-live", "polite");
    });

    it("has aria-label with 'No agents running' for none state", () => {
      render(AgentStatusIndicator, { props: { idleCount: 0, busyCount: 0 } });

      const indicator = screen.getByRole("status");
      expect(indicator).toHaveAttribute("aria-label", expect.stringMatching(/no agents running/i));
    });

    it("has aria-label with idle count for idle state", () => {
      render(AgentStatusIndicator, { props: { idleCount: 2, busyCount: 0 } });

      const indicator = screen.getByRole("status");
      expect(indicator).toHaveAttribute("aria-label", expect.stringMatching(/2 agents? idle/i));
    });

    it("has aria-label with busy count for busy state", () => {
      render(AgentStatusIndicator, { props: { idleCount: 0, busyCount: 3 } });

      const indicator = screen.getByRole("status");
      expect(indicator).toHaveAttribute("aria-label", expect.stringMatching(/3 agents? busy/i));
    });

    it("has aria-label with both counts for mixed state", () => {
      render(AgentStatusIndicator, { props: { idleCount: 1, busyCount: 2 } });

      const indicator = screen.getByRole("status");
      expect(indicator).toHaveAttribute("aria-label", expect.stringMatching(/1 idle.+2 busy/i));
    });

    it("singular 'agent' for count of 1", () => {
      render(AgentStatusIndicator, { props: { idleCount: 1, busyCount: 0 } });

      const indicator = screen.getByRole("status");
      expect(indicator).toHaveAttribute("aria-label", expect.stringMatching(/1 agent idle/i));
    });
  });

  describe("color states", () => {
    it("renders grey (dimmed) when no agents (idle=0, busy=0)", () => {
      render(AgentStatusIndicator, { props: { idleCount: 0, busyCount: 0 } });

      const indicator = screen.getByRole("status");
      expect(indicator).toHaveClass("indicator--none");
    });

    it("renders green when all idle (idle>0, busy=0)", () => {
      render(AgentStatusIndicator, { props: { idleCount: 2, busyCount: 0 } });

      const indicator = screen.getByRole("status");
      expect(indicator).toHaveClass("indicator--idle");
    });

    it("renders red when all busy (idle=0, busy>0)", () => {
      render(AgentStatusIndicator, { props: { idleCount: 0, busyCount: 1 } });

      const indicator = screen.getByRole("status");
      expect(indicator).toHaveClass("indicator--busy");
    });

    it("renders mixed (gradient) when both idle and busy", () => {
      render(AgentStatusIndicator, { props: { idleCount: 1, busyCount: 1 } });

      const indicator = screen.getByRole("status");
      expect(indicator).toHaveClass("indicator--mixed");
    });
  });

  describe("animation", () => {
    it("applies pulse animation when busy (idle=0, busy>0)", () => {
      render(AgentStatusIndicator, { props: { idleCount: 0, busyCount: 1 } });

      const indicator = screen.getByRole("status");
      expect(indicator).toHaveClass("indicator--pulsing");
    });

    it("applies pulse animation when mixed", () => {
      render(AgentStatusIndicator, { props: { idleCount: 1, busyCount: 1 } });

      const indicator = screen.getByRole("status");
      expect(indicator).toHaveClass("indicator--pulsing");
    });

    it("does not apply pulse animation when idle", () => {
      render(AgentStatusIndicator, { props: { idleCount: 2, busyCount: 0 } });

      const indicator = screen.getByRole("status");
      expect(indicator).not.toHaveClass("indicator--pulsing");
    });

    it("does not apply pulse animation when no agents", () => {
      render(AgentStatusIndicator, { props: { idleCount: 0, busyCount: 0 } });

      const indicator = screen.getByRole("status");
      expect(indicator).not.toHaveClass("indicator--pulsing");
    });

    it("respects prefers-reduced-motion media query", () => {
      // The component uses CSS @media (prefers-reduced-motion: reduce)
      // We verify the class is applied (CSS handles the actual animation disable)
      render(AgentStatusIndicator, { props: { idleCount: 0, busyCount: 1 } });

      const indicator = screen.getByRole("status");
      // The component should have the pulsing class - CSS media query handles disabling
      expect(indicator).toHaveClass("indicator--pulsing");
      // Verify the indicator exists so CSS can apply the @media rule
      expect(indicator).toHaveClass("indicator");
    });
  });

  describe("tooltip", () => {
    it("shows tooltip with 'No agents running' for none state", async () => {
      render(AgentStatusIndicator, { props: { idleCount: 0, busyCount: 0 } });

      const indicator = screen.getByRole("status");
      await fireEvent.mouseEnter(indicator);

      // Advance timers for tooltip delay (500ms)
      vi.advanceTimersByTime(500);

      await waitFor(() => {
        const tooltip = screen.getByRole("tooltip");
        expect(tooltip).toHaveTextContent(/no agents running/i);
      });
    });

    it("shows tooltip with idle count for idle state", async () => {
      render(AgentStatusIndicator, { props: { idleCount: 2, busyCount: 0 } });

      const indicator = screen.getByRole("status");
      await fireEvent.mouseEnter(indicator);

      vi.advanceTimersByTime(500);

      await waitFor(() => {
        const tooltip = screen.getByRole("tooltip");
        expect(tooltip).toHaveTextContent(/2 agents? idle/i);
      });
    });

    it("shows tooltip with busy count for busy state", async () => {
      render(AgentStatusIndicator, { props: { idleCount: 0, busyCount: 1 } });

      const indicator = screen.getByRole("status");
      await fireEvent.mouseEnter(indicator);

      vi.advanceTimersByTime(500);

      await waitFor(() => {
        const tooltip = screen.getByRole("tooltip");
        expect(tooltip).toHaveTextContent(/1 agent busy/i);
      });
    });

    it("shows tooltip with both counts for mixed state", async () => {
      render(AgentStatusIndicator, { props: { idleCount: 1, busyCount: 2 } });

      const indicator = screen.getByRole("status");
      await fireEvent.mouseEnter(indicator);

      vi.advanceTimersByTime(500);

      await waitFor(() => {
        const tooltip = screen.getByRole("tooltip");
        expect(tooltip).toHaveTextContent(/1 idle.+2 busy/i);
      });
    });

    it("does not show tooltip before 500ms delay", async () => {
      render(AgentStatusIndicator, { props: { idleCount: 1, busyCount: 0 } });

      const indicator = screen.getByRole("status");
      await fireEvent.mouseEnter(indicator);

      // Only advance 400ms
      vi.advanceTimersByTime(400);

      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    });

    it("hides tooltip on mouse leave", async () => {
      render(AgentStatusIndicator, { props: { idleCount: 1, busyCount: 0 } });

      const indicator = screen.getByRole("status");
      await fireEvent.mouseEnter(indicator);
      vi.advanceTimersByTime(500);

      await waitFor(() => {
        expect(screen.getByRole("tooltip")).toBeInTheDocument();
      });

      await fireEvent.mouseLeave(indicator);

      await waitFor(() => {
        expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
      });
    });
  });

  describe("keyboard accessibility", () => {
    it("is focusable (tabindex=0)", () => {
      render(AgentStatusIndicator, { props: { idleCount: 0, busyCount: 0 } });

      const indicator = screen.getByRole("status");
      expect(indicator).toHaveAttribute("tabindex", "0");
    });

    it("shows tooltip on focus after delay", async () => {
      render(AgentStatusIndicator, { props: { idleCount: 1, busyCount: 0 } });

      const indicator = screen.getByRole("status");
      await fireEvent.focus(indicator);

      vi.advanceTimersByTime(500);

      await waitFor(() => {
        expect(screen.getByRole("tooltip")).toBeInTheDocument();
      });
    });

    it("hides tooltip on blur", async () => {
      render(AgentStatusIndicator, { props: { idleCount: 1, busyCount: 0 } });

      const indicator = screen.getByRole("status");
      await fireEvent.focus(indicator);
      vi.advanceTimersByTime(500);

      await waitFor(() => {
        expect(screen.getByRole("tooltip")).toBeInTheDocument();
      });

      await fireEvent.blur(indicator);

      await waitFor(() => {
        expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
      });
    });

    it("hides tooltip when Escape key is pressed", async () => {
      render(AgentStatusIndicator, { props: { idleCount: 1, busyCount: 0 } });

      const indicator = screen.getByRole("status");
      await fireEvent.focus(indicator);
      vi.advanceTimersByTime(500);

      await waitFor(() => {
        expect(screen.getByRole("tooltip")).toBeInTheDocument();
      });

      await fireEvent.keyDown(indicator, { key: "Escape" });

      await waitFor(() => {
        expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
      });
    });

    it("cancels pending tooltip on Escape key before it appears", async () => {
      render(AgentStatusIndicator, { props: { idleCount: 1, busyCount: 0 } });

      const indicator = screen.getByRole("status");
      await fireEvent.focus(indicator);

      // Wait only 200ms (less than 500ms delay)
      vi.advanceTimersByTime(200);
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

      // Press Escape to cancel the pending tooltip
      await fireEvent.keyDown(indicator, { key: "Escape" });

      // Advance past the original delay time
      vi.advanceTimersByTime(500);

      // Tooltip should never appear
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    });
  });

  describe("size", () => {
    it("has indicator class for styling", () => {
      render(AgentStatusIndicator, { props: { idleCount: 0, busyCount: 0 } });

      const indicator = screen.getByRole("status");
      expect(indicator).toHaveClass("indicator");
    });
  });
});
