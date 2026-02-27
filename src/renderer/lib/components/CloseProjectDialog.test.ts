/**
 * Tests for the CloseProjectDialog component.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/svelte";
import type { Project, ProjectId, WorkspaceName, Workspace } from "@shared/api/types";

// Create mock functions with vi.hoisted
const { mockCloseProject, mockRemoveWorkspace, mockCloseDialog, mockProjects } = vi.hoisted(() => ({
  mockCloseProject: vi.fn(),
  mockRemoveWorkspace: vi.fn(),
  mockCloseDialog: vi.fn(),
  mockProjects: vi.fn(),
}));

// Mock $lib/api
vi.mock("$lib/api", () => ({
  projects: {
    close: mockCloseProject,
  },
  workspaces: {
    remove: mockRemoveWorkspace,
  },
}));

// Mock $lib/stores/dialogs.svelte.js
vi.mock("$lib/stores/dialogs.svelte.js", () => ({
  closeDialog: mockCloseDialog,
}));

// Mock $lib/stores/projects.svelte.js
vi.mock("$lib/stores/projects.svelte.js", () => ({
  projects: {
    get value() {
      return mockProjects();
    },
  },
}));

// Import component after mocks
import CloseProjectDialog from "./CloseProjectDialog.svelte";

// Test data
const testProjectId = "test-project-12345678" as ProjectId;

function createWorkspace(name: string, projectId: ProjectId): Workspace {
  return {
    projectId,
    name: name as WorkspaceName,
    branch: name,
    path: `/test/project/.worktrees/${name}`,
    metadata: { base: "main" },
  };
}

function createProject(
  id: ProjectId,
  name: string,
  workspaces: Workspace[] = [],
  remoteUrl?: string
): Project {
  return {
    id,
    name,
    path: `/test/projects/${name}`,
    workspaces,
    ...(remoteUrl !== undefined && { remoteUrl }),
  };
}

/**
 * Helper to get checkboxes (vscode-checkbox).
 * Since vscode-checkbox is a web component, getByRole("checkbox") doesn't work.
 * We query by tag name instead.
 */
function getAllCheckboxes(): NodeListOf<HTMLElement & { checked?: boolean; label?: string }> {
  return document.querySelectorAll("vscode-checkbox") as NodeListOf<
    HTMLElement & { checked?: boolean; label?: string }
  >;
}

function getCheckboxLabel(cb: HTMLElement): string | null {
  // Try attribute first, then property
  return cb.getAttribute("label") ?? (cb as unknown as { label?: string }).label ?? null;
}

function getRemoveAllCheckbox(): HTMLElement & { checked?: boolean } {
  const checkboxes = getAllCheckboxes();
  const checkbox = Array.from(checkboxes).find(
    (cb) => getCheckboxLabel(cb)?.includes("workspaces") ?? false
  );
  if (!checkbox) throw new Error("Remove all checkbox not found");
  return checkbox;
}

function getKeepRepoCheckbox(): HTMLElement & { checked?: boolean } {
  const checkboxes = getAllCheckboxes();
  const checkbox = Array.from(checkboxes).find(
    (cb) => getCheckboxLabel(cb)?.includes("Keep cloned") ?? false
  );
  if (!checkbox) throw new Error("Keep repo checkbox not found");
  return checkbox;
}

describe("CloseProjectDialog component", () => {
  const testProject = createProject(testProjectId, "test-project", [
    createWorkspace("ws1", testProjectId),
    createWorkspace("ws2", testProjectId),
    createWorkspace("ws3", testProjectId),
  ]);

  const defaultProps = {
    open: true,
    projectId: testProjectId,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockCloseProject.mockResolvedValue(undefined);
    mockRemoveWorkspace.mockResolvedValue({ started: true });
    mockProjects.mockReturnValue([testProject]);
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  describe("structure", () => {
    it("uses Dialog base component", async () => {
      render(CloseProjectDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it("renders workspace count derived from store", async () => {
      render(CloseProjectDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      expect(screen.getByText(/3 workspaces/)).toBeInTheDocument();
    });

    it("renders correct pluralization for single workspace", async () => {
      const singleWsProject = createProject(testProjectId, "test-project", [
        createWorkspace("ws1", testProjectId),
      ]);
      mockProjects.mockReturnValue([singleWsProject]);

      render(CloseProjectDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      expect(screen.getByText(/1 workspace/)).toBeInTheDocument();
      expect(screen.queryByText(/1 workspaces/)).not.toBeInTheDocument();
    });

    it('renders "Remove all workspaces" checkbox unchecked by default', async () => {
      render(CloseProjectDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const checkbox = getRemoveAllCheckbox();
      expect(checkbox).toBeInTheDocument();
      expect(checkbox.checked).toBe(false);
    });

    it("hides workspace info and checkbox when project has no workspaces", async () => {
      const emptyProject = createProject(testProjectId, "test-project", []);
      mockProjects.mockReturnValue([emptyProject]);

      render(CloseProjectDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      // Dialog should still be present
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: /close project/i })).toBeInTheDocument();

      // Workspace info and checkbox should not be present
      expect(screen.queryByText(/workspace/i)).not.toBeInTheDocument();
      expect(document.querySelector("vscode-checkbox")).not.toBeInTheDocument();

      // Close and Cancel buttons should still be present
      expect(screen.getByRole("button", { name: /close project/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
    });

    it("closes empty project directly without removal calls", async () => {
      const emptyProject = createProject(testProjectId, "test-project", []);
      mockProjects.mockReturnValue([emptyProject]);

      render(CloseProjectDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const submitButton = screen.getByRole("button", { name: /close project/i });
      await fireEvent.click(submitButton);

      await vi.runAllTimersAsync();

      // Should only call close, not remove
      expect(mockCloseProject).toHaveBeenCalledWith("/test/projects/test-project", undefined);
      expect(mockRemoveWorkspace).not.toHaveBeenCalled();
      expect(mockCloseDialog).toHaveBeenCalled();
    });
  });

  describe("checkbox behavior", () => {
    it("toggles removeAll state via onchange handler", async () => {
      render(CloseProjectDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const checkbox = getRemoveAllCheckbox();
      expect(checkbox.checked).toBe(false);

      // Toggle the checkbox
      checkbox.checked = true;
      await fireEvent(checkbox, new Event("change", { bubbles: true }));

      // Use waitFor to ensure Svelte reactivity is reflected
      await waitFor(() => {
        expect(checkbox.checked).toBe(true);
      });
    });

    it("checkbox is disabled during submission", async () => {
      mockCloseProject.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 1000))
      );

      render(CloseProjectDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      // Click submit
      const submitButton = screen.getByRole("button", { name: /close project/i });
      await fireEvent.click(submitButton);

      const checkbox = getRemoveAllCheckbox();
      expect(checkbox).toBeDisabled();

      await vi.runAllTimersAsync();
    });
  });

  describe("button labels", () => {
    it('shows "Close Project" when checkbox unchecked', async () => {
      render(CloseProjectDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      expect(screen.getByRole("button", { name: /close project/i })).toBeInTheDocument();
    });

    it('shows "Remove & Close" when checkbox checked', async () => {
      render(CloseProjectDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const checkbox = getRemoveAllCheckbox();
      checkbox.checked = true;
      await fireEvent(checkbox, new Event("change", { bubbles: true }));

      expect(screen.getByRole("button", { name: /remove & close/i })).toBeInTheDocument();
    });

    it('shows "Closing..." during submission', async () => {
      mockCloseProject.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 1000))
      );

      render(CloseProjectDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const submitButton = screen.getByRole("button", { name: /close project/i });
      await fireEvent.click(submitButton);

      expect(screen.getByRole("button", { name: /closing\.\.\./i })).toBeInTheDocument();

      await vi.runAllTimersAsync();
    });
  });

  describe("cancel flow", () => {
    it("cancel button calls closeDialog()", async () => {
      render(CloseProjectDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const cancelButton = screen.getByRole("button", { name: /cancel/i });
      await fireEvent.click(cancelButton);

      expect(mockCloseDialog).toHaveBeenCalled();
    });

    it("Escape key closes dialog", async () => {
      render(CloseProjectDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      await fireEvent.keyDown(document.body, { key: "Escape" });

      expect(mockCloseDialog).toHaveBeenCalled();
    });
  });

  describe("submit flow without removeAll", () => {
    it("only calls api.projects.close() when checkbox unchecked", async () => {
      render(CloseProjectDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const submitButton = screen.getByRole("button", { name: /close project/i });
      await fireEvent.click(submitButton);

      await vi.runAllTimersAsync();

      expect(mockCloseProject).toHaveBeenCalledWith("/test/projects/test-project", undefined);
      expect(mockRemoveWorkspace).not.toHaveBeenCalled();
    });

    it("closes dialog after successful close", async () => {
      render(CloseProjectDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const submitButton = screen.getByRole("button", { name: /close project/i });
      await fireEvent.click(submitButton);

      await vi.runAllTimersAsync();

      expect(mockCloseDialog).toHaveBeenCalled();
    });
  });

  describe("submit flow with removeAll", () => {
    it("calls api.workspaces.remove() for each workspace with keepBranch=false", async () => {
      render(CloseProjectDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      // Check the checkbox
      const checkbox = getRemoveAllCheckbox();
      checkbox.checked = true;
      await fireEvent(checkbox, new Event("change", { bubbles: true }));

      const submitButton = screen.getByRole("button", { name: /remove & close/i });
      await fireEvent.click(submitButton);

      await vi.runAllTimersAsync();

      // Should call remove for each workspace with keepBranch=false (using workspace path)
      expect(mockRemoveWorkspace).toHaveBeenCalledTimes(3);
      expect(mockRemoveWorkspace).toHaveBeenCalledWith("/test/project/.worktrees/ws1", {
        keepBranch: false,
      });
      expect(mockRemoveWorkspace).toHaveBeenCalledWith("/test/project/.worktrees/ws2", {
        keepBranch: false,
      });
      expect(mockRemoveWorkspace).toHaveBeenCalledWith("/test/project/.worktrees/ws3", {
        keepBranch: false,
      });
    });

    it("calls api.projects.close() after all removals", async () => {
      render(CloseProjectDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const checkbox = getRemoveAllCheckbox();
      checkbox.checked = true;
      await fireEvent(checkbox, new Event("change", { bubbles: true }));

      const submitButton = screen.getByRole("button", { name: /remove & close/i });
      await fireEvent.click(submitButton);

      await vi.runAllTimersAsync();

      expect(mockCloseProject).toHaveBeenCalledWith("/test/projects/test-project", undefined);
    });
  });

  describe("partial failure handling", () => {
    it("shows aggregate error message for partial failures", async () => {
      // First two succeed, third fails
      mockRemoveWorkspace
        .mockResolvedValueOnce({ started: true })
        .mockResolvedValueOnce({ started: true })
        .mockRejectedValueOnce(new Error("Branch in use"));

      render(CloseProjectDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const checkbox = getRemoveAllCheckbox();
      checkbox.checked = true;
      await fireEvent(checkbox, new Event("change", { bubbles: true }));

      const submitButton = screen.getByRole("button", { name: /remove & close/i });
      await fireEvent.click(submitButton);

      await vi.runAllTimersAsync();

      // Should show error about partial failure
      expect(screen.getByText(/removed 2 of 3 workspaces/i)).toBeInTheDocument();
      expect(screen.getByText(/ws3.*branch in use/i)).toBeInTheDocument();
    });

    it("still closes project even after removal failures", async () => {
      mockRemoveWorkspace.mockRejectedValue(new Error("Failed"));

      render(CloseProjectDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const checkbox = getRemoveAllCheckbox();
      checkbox.checked = true;
      await fireEvent(checkbox, new Event("change", { bubbles: true }));

      const submitButton = screen.getByRole("button", { name: /remove & close/i });
      await fireEvent.click(submitButton);

      await vi.runAllTimersAsync();

      // Should still close the project
      expect(mockCloseProject).toHaveBeenCalledWith("/test/projects/test-project", undefined);
    });

    it("error display uses role='alert'", async () => {
      mockRemoveWorkspace.mockRejectedValue(new Error("Failed"));

      render(CloseProjectDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const checkbox = getRemoveAllCheckbox();
      checkbox.checked = true;
      await fireEvent(checkbox, new Event("change", { bubbles: true }));

      const submitButton = screen.getByRole("button", { name: /remove & close/i });
      await fireEvent.click(submitButton);

      await vi.runAllTimersAsync();

      const errorElement = screen.getByRole("alert");
      expect(errorElement).toBeInTheDocument();
    });
  });

  describe("button disabled state", () => {
    it("submit button disabled during submission prevents double-click", async () => {
      mockCloseProject.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 1000))
      );

      render(CloseProjectDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const submitButton = screen.getByRole("button", { name: /close project/i });
      await fireEvent.click(submitButton);

      // Try clicking again - should be disabled
      expect(submitButton).toBeDisabled();

      await vi.runAllTimersAsync();
    });
  });

  describe("accessibility", () => {
    it("primary button has initial focus", async () => {
      render(CloseProjectDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const submitButton = screen.getByRole("button", { name: /close project/i });
      expect(submitButton).toHaveFocus();
    });

  });

  describe("edge cases", () => {
    it("handles project not found gracefully", async () => {
      mockProjects.mockReturnValue([]); // Empty projects list

      render(CloseProjectDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      // Should render without crashing, showing 0 workspaces
      const dialog = screen.getByRole("dialog");
      expect(dialog).toBeInTheDocument();
    });

    it("handles project becoming undefined during operation", async () => {
      mockCloseProject.mockImplementation(async () => {
        // Simulate project being removed during close
        mockProjects.mockReturnValue([]);
        return undefined;
      });

      render(CloseProjectDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const submitButton = screen.getByRole("button", { name: /close project/i });
      await fireEvent.click(submitButton);

      await vi.runAllTimersAsync();

      // Should close dialog without errors
      expect(mockCloseDialog).toHaveBeenCalled();
    });
  });

  describe("remote project (cloned from URL)", () => {
    const remoteProject: Project = {
      id: testProjectId,
      name: "test-project",
      path: "/test/projects/test-project",
      workspaces: [createWorkspace("ws1", testProjectId)],
      remoteUrl: "https://github.com/org/test-repo.git",
    };

    beforeEach(() => {
      // Override the global beforeEach mock setup (global beforeEach runs first, then this)
      mockProjects.mockReturnValue([remoteProject]);
    });

    it("shows keep repo checkbox for remote projects", async () => {
      render(CloseProjectDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const keepCheckbox = getKeepRepoCheckbox();
      expect(keepCheckbox).toBeInTheDocument();
    });

    it("hides keep repo checkbox for local projects", async () => {
      const localProject = createProject(testProjectId, "test-project", [
        createWorkspace("ws1", testProjectId),
      ]);
      mockProjects.mockReturnValue([localProject]);

      render(CloseProjectDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const checkboxes = getAllCheckboxes();
      const keepCheckbox = Array.from(checkboxes).find(
        (cb) => cb.getAttribute("label")?.includes("Keep cloned") ?? false
      );
      expect(keepCheckbox).toBeUndefined();
    });

    it("shows warning by default, hides when keep is checked", async () => {
      render(CloseProjectDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      // Warning visible by default for remote projects
      expect(screen.getByText(/permanently delete/i)).toBeInTheDocument();
      expect(screen.getByText(/https:\/\/github.com\/org\/test-repo.git/)).toBeInTheDocument();

      // Check "Keep" to hide warning
      const keepCheckbox = getKeepRepoCheckbox();
      keepCheckbox.checked = true;
      await fireEvent(keepCheckbox, new Event("change", { bubbles: true }));

      await waitFor(() => {
        expect(screen.queryByText(/permanently delete/i)).not.toBeInTheDocument();
      });
    });

    it("removeAll is auto-checked by default, unchecked when keep is checked", async () => {
      render(CloseProjectDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const removeAllCheckbox = getRemoveAllCheckbox();

      // Auto-checked by default for remote projects (shouldDeleteRepo = true)
      expect(removeAllCheckbox.checked).toBe(true);

      // Check "Keep" to uncheck removeAll
      const keepCheckbox = getKeepRepoCheckbox();
      keepCheckbox.checked = true;
      await fireEvent(keepCheckbox, new Event("change", { bubbles: true }));

      await waitFor(() => {
        expect(removeAllCheckbox.checked).toBe(false);
      });
    });

    it("disables removeAll checkbox by default, enables when keep is checked", async () => {
      render(CloseProjectDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const removeAllCheckbox = getRemoveAllCheckbox();
      // Disabled by default (shouldDeleteRepo = true)
      expect(removeAllCheckbox).toBeDisabled();

      // Check "Keep" to enable removeAll
      const keepCheckbox = getKeepRepoCheckbox();
      keepCheckbox.checked = true;
      await fireEvent(keepCheckbox, new Event("change", { bubbles: true }));

      await waitFor(() => {
        expect(removeAllCheckbox).not.toBeDisabled();
      });
    });

    it('shows "Delete & Close" button by default, "Close Project" when keep is checked', async () => {
      render(CloseProjectDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      // Default: Delete & Close
      expect(screen.getByRole("button", { name: /delete & close/i })).toBeInTheDocument();

      // Check "Keep"
      const keepCheckbox = getKeepRepoCheckbox();
      keepCheckbox.checked = true;
      await fireEvent(keepCheckbox, new Event("change", { bubbles: true }));

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /close project/i })).toBeInTheDocument();
      });
    });

    it("calls close with removeLocalRepo by default", async () => {
      render(CloseProjectDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const submitButton = screen.getByRole("button", { name: /delete & close/i });
      await fireEvent.click(submitButton);

      await vi.runAllTimersAsync();

      expect(mockCloseProject).toHaveBeenCalledWith("/test/projects/test-project", {
        removeLocalRepo: true,
      });
    });

    it("does not pass removeLocalRepo when keep is checked", async () => {
      render(CloseProjectDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      // Check "Keep"
      const keepCheckbox = getKeepRepoCheckbox();
      keepCheckbox.checked = true;
      await fireEvent(keepCheckbox, new Event("change", { bubbles: true }));

      const submitButton = screen.getByRole("button", { name: /close project/i });
      await fireEvent.click(submitButton);

      await vi.runAllTimersAsync();

      expect(mockCloseProject).toHaveBeenCalledWith("/test/projects/test-project", undefined);
    });
  });
});
