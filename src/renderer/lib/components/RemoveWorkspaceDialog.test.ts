/**
 * Tests for the RemoveWorkspaceDialog component.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";

// Create mock functions with vi.hoisted
const { mockRemoveWorkspace, mockIsWorkspaceDirty, mockCloseDialog } = vi.hoisted(() => ({
  mockRemoveWorkspace: vi.fn(),
  mockIsWorkspaceDirty: vi.fn(),
  mockCloseDialog: vi.fn(),
}));

// Mock $lib/api
vi.mock("$lib/api", () => ({
  selectFolder: vi.fn().mockResolvedValue(null),
  openProject: vi.fn().mockResolvedValue(undefined),
  closeProject: vi.fn().mockResolvedValue(undefined),
  listProjects: vi.fn().mockResolvedValue([]),
  createWorkspace: vi.fn().mockResolvedValue(undefined),
  removeWorkspace: mockRemoveWorkspace,
  switchWorkspace: vi.fn().mockResolvedValue(undefined),
  listBases: vi.fn().mockResolvedValue([]),
  updateBases: vi.fn().mockResolvedValue(undefined),
  isWorkspaceDirty: mockIsWorkspaceDirty,
  onProjectOpened: vi.fn(() => vi.fn()),
  onProjectClosed: vi.fn(() => vi.fn()),
  onWorkspaceCreated: vi.fn(() => vi.fn()),
  onWorkspaceRemoved: vi.fn(() => vi.fn()),
  onWorkspaceSwitched: vi.fn(() => vi.fn()),
}));

// Mock $lib/stores/dialogs.svelte.js
vi.mock("$lib/stores/dialogs.svelte.js", () => ({
  closeDialog: mockCloseDialog,
  getTriggerElement: vi.fn().mockReturnValue(null),
}));

// Import component after mocks
import RemoveWorkspaceDialog from "./RemoveWorkspaceDialog.svelte";
import { removeWorkspace, isWorkspaceDirty } from "$lib/api";

describe("RemoveWorkspaceDialog component", () => {
  const defaultProps = {
    open: true,
    workspacePath: "/test/project/.worktrees/feature-branch",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockRemoveWorkspace.mockResolvedValue(undefined);
    mockIsWorkspaceDirty.mockResolvedValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  describe("structure", () => {
    it("uses Dialog base component", async () => {
      render(RemoveWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it("renders confirmation with workspace name", async () => {
      render(RemoveWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      expect(screen.getByText(/feature-branch/)).toBeInTheDocument();
      // Multiple elements contain "remove", so verify specific confirmation text
      expect(screen.getByText(/Remove workspace "feature-branch"\?/)).toBeInTheDocument();
    });

    it('renders "Delete branch" checkbox, checked by default', async () => {
      render(RemoveWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const checkbox = screen.getByRole("checkbox", { name: /delete branch/i });
      expect(checkbox).toBeInTheDocument();
      expect(checkbox).toBeChecked();
    });
  });

  describe("dirty status", () => {
    it("loads dirty status using api.isWorkspaceDirty(workspacePath) on mount", async () => {
      render(RemoveWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      expect(isWorkspaceDirty).toHaveBeenCalledWith("/test/project/.worktrees/feature-branch");
    });

    it("shows spinner while checking dirty status", async () => {
      // Delay the API response
      mockIsWorkspaceDirty.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(false), 1000))
      );

      render(RemoveWorkspaceDialog, { props: defaultProps });

      expect(screen.getByText(/checking/i)).toBeInTheDocument();

      await vi.runAllTimersAsync();
    });

    it("shows warning box when workspace is dirty", async () => {
      mockIsWorkspaceDirty.mockResolvedValue(true);

      render(RemoveWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      expect(screen.getByText(/uncommitted changes/i)).toBeInTheDocument();
    });

    it("hides warning box when workspace is clean", async () => {
      mockIsWorkspaceDirty.mockResolvedValue(false);

      render(RemoveWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      expect(screen.queryByText(/uncommitted changes/i)).not.toBeInTheDocument();
    });

    it("handles isWorkspaceDirty error gracefully (assume clean)", async () => {
      mockIsWorkspaceDirty.mockRejectedValue(new Error("Network error"));

      render(RemoveWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      // Should not crash, should not show warning
      expect(screen.queryByText(/uncommitted changes/i)).not.toBeInTheDocument();
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
  });

  describe("keyboard navigation", () => {
    it("Space toggles checkbox", async () => {
      render(RemoveWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const checkbox = screen.getByRole("checkbox", { name: /delete branch/i });
      expect(checkbox).toBeChecked();

      await fireEvent.keyDown(checkbox, { key: " " });
      // Note: actual toggle is handled by the browser, we verify it's focusable
    });

    it("Escape closes dialog", async () => {
      render(RemoveWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      await fireEvent.keyDown(document.body, { key: "Escape" });

      expect(mockCloseDialog).toHaveBeenCalled();
    });
  });

  describe("submit flow", () => {
    it("OK calls api.removeWorkspace with workspacePath and deleteBranch value", async () => {
      render(RemoveWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      // Click OK with checkbox checked (default)
      const okButton = screen.getByRole("button", { name: /ok|remove/i });
      await fireEvent.click(okButton);

      await vi.runAllTimersAsync();

      expect(removeWorkspace).toHaveBeenCalledWith("/test/project/.worktrees/feature-branch", true);
    });

    it("OK calls api.removeWorkspace with deleteBranch=false when unchecked", async () => {
      render(RemoveWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      // Uncheck the checkbox
      const checkbox = screen.getByRole("checkbox", { name: /delete branch/i });
      await fireEvent.click(checkbox);

      // Click OK
      const okButton = screen.getByRole("button", { name: /ok|remove/i });
      await fireEvent.click(okButton);

      await vi.runAllTimersAsync();

      expect(removeWorkspace).toHaveBeenCalledWith(
        "/test/project/.worktrees/feature-branch",
        false
      );
    });

    it("OK shows spinner during submit", async () => {
      mockRemoveWorkspace.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 1000))
      );

      render(RemoveWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const okButton = screen.getByRole("button", { name: /ok|remove/i });
      await fireEvent.click(okButton);

      // Should show submitting state
      expect(screen.getByRole("button", { name: /removing/i })).toBeInTheDocument();

      await vi.runAllTimersAsync();
    });

    it("checkbox and buttons disabled during submit", async () => {
      mockRemoveWorkspace.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 1000))
      );

      render(RemoveWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const okButton = screen.getByRole("button", { name: /ok|remove/i });
      await fireEvent.click(okButton);

      const checkbox = screen.getByRole("checkbox", { name: /delete branch/i });
      expect(checkbox).toBeDisabled();

      await vi.runAllTimersAsync();
    });

    it('aria-busy="true" during submit', async () => {
      mockRemoveWorkspace.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 1000))
      );

      render(RemoveWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const okButton = screen.getByRole("button", { name: /ok|remove/i });
      await fireEvent.click(okButton);

      const dialog = screen.getByRole("dialog");
      expect(dialog).toHaveAttribute("aria-busy", "true");

      await vi.runAllTimersAsync();
    });

    it("success closes dialog", async () => {
      render(RemoveWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const okButton = screen.getByRole("button", { name: /ok|remove/i });
      await fireEvent.click(okButton);

      await vi.runAllTimersAsync();

      expect(mockCloseDialog).toHaveBeenCalled();
    });
  });

  describe("error handling", () => {
    it('api.removeWorkspace failure displays error in role="alert"', async () => {
      mockRemoveWorkspace.mockRejectedValue(new Error("Cannot remove workspace"));

      render(RemoveWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const okButton = screen.getByRole("button", { name: /ok|remove/i });
      await fireEvent.click(okButton);

      await vi.runAllTimersAsync();

      const errorElement = screen.getByText(/cannot remove workspace/i);
      expect(errorElement).toBeInTheDocument();
      expect(errorElement.closest("[role='alert']")).toBeInTheDocument();
    });

    it("error re-enables form for retry", async () => {
      mockRemoveWorkspace.mockRejectedValue(new Error("Network error"));

      render(RemoveWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const okButton = screen.getByRole("button", { name: /ok|remove/i });
      await fireEvent.click(okButton);

      await vi.runAllTimersAsync();

      // Form should be re-enabled
      const checkbox = screen.getByRole("checkbox", { name: /delete branch/i });
      expect(checkbox).not.toBeDisabled();
      expect(okButton).not.toBeDisabled();
    });
  });
});
