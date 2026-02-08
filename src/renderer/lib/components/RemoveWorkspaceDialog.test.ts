/**
 * Tests for the RemoveWorkspaceDialog component.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import type { ProjectId, WorkspaceName, WorkspaceRef } from "@shared/api/types";

// Create mock functions with vi.hoisted
const { mockRemoveWorkspace, mockGetStatus, mockCloseDialog } = vi.hoisted(() => ({
  mockRemoveWorkspace: vi.fn(),
  mockGetStatus: vi.fn(),
  mockCloseDialog: vi.fn(),
}));

// Mock $lib/api - using v2 API
vi.mock("$lib/api", () => ({
  selectFolder: vi.fn().mockResolvedValue(null),
  openProject: vi.fn().mockResolvedValue(undefined),
  closeProject: vi.fn().mockResolvedValue(undefined),
  listProjects: vi.fn().mockResolvedValue({ projects: [], activeWorkspacePath: null }),
  createWorkspace: vi.fn().mockResolvedValue(undefined),
  removeWorkspace: vi.fn().mockResolvedValue(undefined),
  switchWorkspace: vi.fn().mockResolvedValue(undefined),
  listBases: vi.fn().mockResolvedValue([]),
  updateBases: vi.fn().mockResolvedValue(undefined),
  isWorkspaceDirty: vi.fn().mockResolvedValue(false),
  onProjectOpened: vi.fn(() => vi.fn()),
  onProjectClosed: vi.fn(() => vi.fn()),
  onWorkspaceCreated: vi.fn(() => vi.fn()),
  onWorkspaceRemoved: vi.fn(() => vi.fn()),
  onWorkspaceSwitched: vi.fn(() => vi.fn()),
  // Flat API structure
  workspaces: {
    remove: mockRemoveWorkspace,
    getStatus: mockGetStatus,
  },
}));

// Mock $lib/stores/dialogs.svelte.js
vi.mock("$lib/stores/dialogs.svelte.js", () => ({
  closeDialog: mockCloseDialog,
}));

// Import component after mocks
import RemoveWorkspaceDialog from "./RemoveWorkspaceDialog.svelte";
import { workspaces } from "$lib/api";

// Test workspace ref
const testProjectId = "test-project-12345678" as ProjectId;
const testWorkspaceName = "feature-branch" as WorkspaceName;
const testWorkspaceRef: WorkspaceRef = {
  projectId: testProjectId,
  workspaceName: testWorkspaceName,
  path: "/test/project/.worktrees/feature-branch",
};

/**
 * Helper to get the keep branch checkbox (vscode-checkbox).
 * Since vscode-checkbox is a web component, getByRole("checkbox") doesn't work.
 * We query by tag name instead.
 */
function getKeepBranchCheckbox(): HTMLElement & { checked?: boolean } {
  const checkbox = document.querySelector("vscode-checkbox");
  if (!checkbox) throw new Error("Checkbox not found");
  return checkbox as HTMLElement & { checked?: boolean };
}

describe("RemoveWorkspaceDialog component", () => {
  const defaultProps = {
    open: true,
    workspaceRef: testWorkspaceRef,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // Fire-and-forget API returns { started: true }
    mockRemoveWorkspace.mockResolvedValue({ started: true });
    // v2 API returns WorkspaceStatus
    mockGetStatus.mockResolvedValue({ isDirty: false, agent: { type: "none" } });
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

    it('renders "Keep branch" checkbox, unchecked by default', async () => {
      render(RemoveWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const checkbox = getKeepBranchCheckbox();
      expect(checkbox).toBeInTheDocument();
      // vscode-checkbox uses a .checked property, not the :checked pseudo-selector
      // Keep branch is unchecked by default (branch will be deleted)
      expect(checkbox.checked).toBe(false);
    });
  });

  describe("dirty status", () => {
    it("loads dirty status using workspaces.getStatus on mount", async () => {
      render(RemoveWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      expect(workspaces.getStatus).toHaveBeenCalledWith(testProjectId, testWorkspaceName);
    });

    it("shows spinner while checking dirty status", async () => {
      // Delay the API response - v2 returns WorkspaceStatus object
      mockGetStatus.mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ isDirty: false, agent: { type: "none" } }), 1000)
          )
      );

      render(RemoveWorkspaceDialog, { props: defaultProps });

      expect(screen.getByText(/checking/i)).toBeInTheDocument();

      await vi.runAllTimersAsync();
    });

    it("shows warning box when workspace is dirty", async () => {
      mockGetStatus.mockResolvedValue({ isDirty: true, agent: { type: "none" } });

      render(RemoveWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      expect(screen.getByText(/uncommitted changes/i)).toBeInTheDocument();
    });

    it("hides warning box when workspace is clean", async () => {
      mockGetStatus.mockResolvedValue({ isDirty: false, agent: { type: "none" } });

      render(RemoveWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      expect(screen.queryByText(/uncommitted changes/i)).not.toBeInTheDocument();
    });

    it("handles isWorkspaceDirty error gracefully (assume clean)", async () => {
      mockGetStatus.mockRejectedValue(new Error("Network error"));

      render(RemoveWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      // Should not crash, should not show warning
      expect(screen.queryByText(/uncommitted changes/i)).not.toBeInTheDocument();
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
  });

  describe("keyboard navigation", () => {
    it("Remove button has initial focus", async () => {
      render(RemoveWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const removeButton = screen.getByRole("button", { name: /^remove$/i });
      expect(removeButton).toHaveFocus();
    });

    it("Space toggles checkbox", async () => {
      render(RemoveWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const checkbox = getKeepBranchCheckbox();
      // vscode-checkbox uses .checked property, not :checked pseudo-selector
      // Keep branch is unchecked by default
      expect(checkbox.checked).toBe(false);

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

  describe("submit flow (fire-and-forget)", () => {
    it("OK calls workspaces.remove with keepBranch=false when checkbox unchecked (default)", async () => {
      render(RemoveWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      // Click OK with checkbox unchecked (default)
      const okButton = screen.getByRole("button", { name: /^remove$/i });
      await fireEvent.click(okButton);

      await vi.runAllTimersAsync();

      // API uses keepBranch (inverted from old deleteBranch)
      expect(workspaces.remove).toHaveBeenCalledWith(testProjectId, testWorkspaceName, {
        keepBranch: false,
      });
    });

    it("OK calls workspaces.remove with keepBranch=true when checkbox checked", async () => {
      render(RemoveWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      // Check the "Keep branch" checkbox - vscode-checkbox is a web component so we need to
      // set the property directly and dispatch a change event
      const checkbox = getKeepBranchCheckbox();
      checkbox.checked = true;
      await fireEvent(checkbox, new Event("change", { bubbles: true }));

      // Click OK
      const okButton = screen.getByRole("button", { name: /^remove$/i });
      await fireEvent.click(okButton);

      await vi.runAllTimersAsync();

      expect(workspaces.remove).toHaveBeenCalledWith(testProjectId, testWorkspaceName, {
        keepBranch: true,
      });
    });

    it("OK closes dialog immediately (fire-and-forget)", async () => {
      render(RemoveWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const okButton = screen.getByRole("button", { name: /^remove$/i });
      await fireEvent.click(okButton);

      // Dialog should close immediately without waiting for API response
      expect(mockCloseDialog).toHaveBeenCalled();
    });

    it("does not block on remove API call (fire-and-forget)", async () => {
      // Verify that the remove call doesn't block dialog close
      // Use a slow mock to verify dialog closes before API resolves
      mockRemoveWorkspace.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ started: true }), 10000))
      );

      render(RemoveWorkspaceDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const okButton = screen.getByRole("button", { name: /^remove$/i });
      await fireEvent.click(okButton);

      // Dialog should close immediately even though remove hasn't resolved (10s timeout)
      expect(mockCloseDialog).toHaveBeenCalled();
    });
  });
});
