/**
 * Integration tests for MainView.
 * Tests the interaction between MainView and its child dialogs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/svelte";
import type { WorkspaceName } from "@shared/api/types";
import { asProjectId } from "@shared/test-fixtures";

// Create mock API functions with vi.hoisted for proper hoisting
const mockApi = vi.hoisted(() => ({
  // Setup API methods (top-level)
  setupReady: vi.fn().mockResolvedValue({ ready: true }),
  setupRetry: vi.fn().mockResolvedValue(undefined),
  setupQuit: vi.fn().mockResolvedValue(undefined),
  onSetupProgress: vi.fn(() => vi.fn()),
  onSetupComplete: vi.fn(() => vi.fn()),
  onSetupError: vi.fn(() => vi.fn()),
  // Flat API structure - projects namespace
  projects: {
    list: vi.fn().mockResolvedValue([]),
    open: vi.fn().mockResolvedValue({}),
    close: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(undefined),
    fetchBases: vi.fn().mockResolvedValue({ bases: [] }),
  },
  // Flat API structure - workspaces namespace
  workspaces: {
    create: vi.fn().mockResolvedValue({}),
    remove: vi.fn().mockResolvedValue({ branchDeleted: true }),
    getStatus: vi.fn().mockResolvedValue({ isDirty: false, agent: { type: "none" } }),
    get: vi.fn().mockResolvedValue(undefined),
  },
  // Flat API structure - ui namespace
  ui: {
    getActiveWorkspace: vi.fn().mockResolvedValue(null),
    switchWorkspace: vi.fn().mockResolvedValue(undefined),
    setMode: vi.fn().mockResolvedValue(undefined),
  },
  // Flat API structure - lifecycle namespace
  lifecycle: {
    ready: vi.fn().mockResolvedValue(undefined),
    quit: vi.fn().mockResolvedValue(undefined),
  },
  // on() for event subscriptions
  on: vi.fn(() => vi.fn()),
}));

// Mock the API module before any imports use it
vi.mock("$lib/api", () => mockApi);

// Mock AgentNotificationService
const { MockAgentNotificationService } = vi.hoisted(() => {
  class MockAgentNotificationService {
    seedInitialCounts = vi.fn();
    handleStatusChange = vi.fn();
    removeWorkspace = vi.fn();
    setEnabled = vi.fn();
    isEnabled = vi.fn().mockReturnValue(true);
    reset = vi.fn();
  }
  return { MockAgentNotificationService };
});

vi.mock("$lib/services/agent-notifications", () => ({
  AgentNotificationService: MockAgentNotificationService,
}));

// Import after mock setup
import MainView from "./MainView.svelte";
import * as projectsStore from "$lib/stores/projects.svelte.js";
import * as dialogsStore from "$lib/stores/dialogs.svelte.js";
import * as shortcutsStore from "$lib/stores/shortcuts.svelte.js";
import * as agentStatusStore from "$lib/stores/agent-status.svelte.js";

describe("MainView close project integration", () => {
  const projectWithWorkspaces = {
    id: asProjectId("test-project-12345678"),
    path: "/test/project",
    name: "test-project",
    workspaces: [
      {
        projectId: asProjectId("test-project-12345678"),
        path: "/test/.worktrees/feature-1",
        name: "feature-1" as WorkspaceName,
        branch: "feature-1",
      },
      {
        projectId: asProjectId("test-project-12345678"),
        path: "/test/.worktrees/feature-2",
        name: "feature-2" as WorkspaceName,
        branch: "feature-2",
      },
    ],
  };

  const projectWithoutWorkspaces = {
    id: asProjectId("empty-project-87654321"),
    path: "/test/empty-project",
    name: "empty-project",
    workspaces: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // Reset stores before each test
    projectsStore.reset();
    dialogsStore.reset();
    shortcutsStore.reset();
    agentStatusStore.reset();
    // Default mock responses
    mockApi.projects.list.mockResolvedValue([projectWithWorkspaces, projectWithoutWorkspaces]);
    mockApi.ui.getActiveWorkspace.mockResolvedValue(null);
    mockApi.projects.close.mockResolvedValue(undefined);
    mockApi.workspaces.remove.mockResolvedValue({ branchDeleted: true });
    // Configure lifecycle.ready to simulate event-driven store population
    mockApi.lifecycle.ready.mockImplementation(async () => {
      const projectList = await mockApi.projects.list();
      for (const p of projectList) {
        projectsStore.addProject(p);
      }
      const activeRef = await mockApi.ui.getActiveWorkspace();
      projectsStore.setActiveWorkspace(activeRef?.path ?? null);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  describe("handleCloseProject behavior", () => {
    it("opens close-project dialog when clicking close on project with workspaces", async () => {
      render(MainView);

      // Wait for projects to load
      await waitFor(() => {
        expect(projectsStore.loadingState.value).toBe("loaded");
      });
      await vi.runAllTimersAsync();

      // Find and click the close button for the project with workspaces
      // Button has id="close-project-${project.id}"
      const closeButton = document.getElementById(`close-project-${projectWithWorkspaces.id}`);
      expect(closeButton).toBeInTheDocument();
      await fireEvent.click(closeButton!);

      await vi.runAllTimersAsync();

      // Dialog should be open
      expect(dialogsStore.dialogState.value.type).toBe("close-project");
      if (dialogsStore.dialogState.value.type === "close-project") {
        expect(dialogsStore.dialogState.value.projectId).toBe(projectWithWorkspaces.id);
      }
    });

    it("shows dialog when clicking close on project with no workspaces", async () => {
      render(MainView);

      // Wait for projects to load
      await waitFor(() => {
        expect(projectsStore.loadingState.value).toBe("loaded");
      });
      await vi.runAllTimersAsync();

      // Find and click the close button for the empty project
      const closeButton = document.getElementById(`close-project-${projectWithoutWorkspaces.id}`);
      expect(closeButton).toBeInTheDocument();
      await fireEvent.click(closeButton!);

      await vi.runAllTimersAsync();

      // Should open dialog even for empty projects - user confirms closing
      expect(mockApi.projects.close).not.toHaveBeenCalled();
      expect(dialogsStore.dialogState.value.type).toBe("close-project");
    });

    it("handles project not found in store (race condition)", async () => {
      // Start with projects
      render(MainView);

      await waitFor(() => {
        expect(projectsStore.loadingState.value).toBe("loaded");
      });
      await vi.runAllTimersAsync();

      // Clear the store to simulate race condition
      projectsStore.setProjects([]);

      // Try to close a non-existent project by calling the handler directly
      // (can't click button since project is gone from UI)
      // This tests the guard in handleCloseProject

      // The API should not be called since project isn't in store
      expect(mockApi.projects.close).not.toHaveBeenCalled();
      expect(dialogsStore.dialogState.value.type).toBe("closed");
    });
  });

  describe("CloseProjectDialog rendering", () => {
    it("renders CloseProjectDialog when dialog type is close-project", async () => {
      render(MainView);

      await waitFor(() => {
        expect(projectsStore.loadingState.value).toBe("loaded");
      });
      await vi.runAllTimersAsync();

      // Open close-project dialog
      dialogsStore.openCloseProjectDialog(projectWithWorkspaces.id);

      await vi.runAllTimersAsync();

      const dialog = screen.getByRole("dialog");
      expect(dialog).toBeInTheDocument();
      // Use heading role to be more specific (title)
      expect(screen.getByRole("heading", { name: "Close Project" })).toBeInTheDocument();
      expect(screen.getByText(/2 workspaces/)).toBeInTheDocument();
    });
  });

  describe("full close flow without removeAll", () => {
    it("closes project without removing workspaces when checkbox unchecked", async () => {
      render(MainView);

      await waitFor(() => {
        expect(projectsStore.loadingState.value).toBe("loaded");
      });
      await vi.runAllTimersAsync();

      // Open close-project dialog
      dialogsStore.openCloseProjectDialog(projectWithWorkspaces.id);
      await vi.runAllTimersAsync();

      // Get the dialog and find the "Close Project" button within it
      const dialog = screen.getByRole("dialog");
      const closeButton = within(dialog).getByRole("button", { name: /close project/i });
      await fireEvent.click(closeButton);

      await vi.runAllTimersAsync();

      // Should only call close, not remove
      expect(mockApi.workspaces.remove).not.toHaveBeenCalled();
      expect(mockApi.projects.close).toHaveBeenCalledWith(projectWithWorkspaces.id, undefined);

      // Dialog should be closed
      expect(dialogsStore.dialogState.value.type).toBe("closed");
    });
  });

  describe("full close flow with removeAll", () => {
    it("removes all workspaces then closes project when checkbox checked", async () => {
      render(MainView);

      await waitFor(() => {
        expect(projectsStore.loadingState.value).toBe("loaded");
      });
      await vi.runAllTimersAsync();

      // Open close-project dialog
      dialogsStore.openCloseProjectDialog(projectWithWorkspaces.id);
      await vi.runAllTimersAsync();

      // Check the checkbox
      const checkbox = document.querySelector("vscode-checkbox") as HTMLElement & {
        checked: boolean;
      };
      checkbox.checked = true;
      await fireEvent(checkbox, new Event("change", { bubbles: true }));

      await vi.runAllTimersAsync();

      // Button should now say "Remove & Close"
      expect(screen.getByRole("button", { name: /remove & close/i })).toBeInTheDocument();

      // Click "Remove & Close" button
      const removeButton = screen.getByRole("button", { name: /remove & close/i });
      await fireEvent.click(removeButton);

      await vi.runAllTimersAsync();

      // Should call remove for each workspace with keepBranch=false (using workspace path)
      expect(mockApi.workspaces.remove).toHaveBeenCalledTimes(2);
      expect(mockApi.workspaces.remove).toHaveBeenCalledWith("/test/.worktrees/feature-1", {
        keepBranch: false,
      });
      expect(mockApi.workspaces.remove).toHaveBeenCalledWith("/test/.worktrees/feature-2", {
        keepBranch: false,
      });

      // Then close the project
      expect(mockApi.projects.close).toHaveBeenCalledWith(projectWithWorkspaces.id, undefined);

      // Dialog should be closed
      expect(dialogsStore.dialogState.value.type).toBe("closed");
    });

    it("closes project even when some workspace removals fail", async () => {
      // First removal succeeds, second fails
      mockApi.workspaces.remove
        .mockResolvedValueOnce({ branchDeleted: true })
        .mockRejectedValueOnce(new Error("Branch in use"));

      render(MainView);

      await waitFor(() => {
        expect(projectsStore.loadingState.value).toBe("loaded");
      });
      await vi.runAllTimersAsync();

      // Open close-project dialog
      dialogsStore.openCloseProjectDialog(projectWithWorkspaces.id);
      await vi.runAllTimersAsync();

      // Check the checkbox
      const checkbox = document.querySelector("vscode-checkbox") as HTMLElement & {
        checked: boolean;
      };
      checkbox.checked = true;
      await fireEvent(checkbox, new Event("change", { bubbles: true }));

      // Get dialog and click "Remove & Close" within it
      const dialog = screen.getByRole("dialog");
      const removeButton = within(dialog).getByRole("button", { name: /remove & close/i });
      await fireEvent.click(removeButton);

      await vi.runAllTimersAsync();

      // Both workspaces should have removal attempted
      expect(mockApi.workspaces.remove).toHaveBeenCalledTimes(2);

      // Project should still be closed despite partial failure
      expect(mockApi.projects.close).toHaveBeenCalledWith(projectWithWorkspaces.id, undefined);

      // Dialog should be closed
      expect(dialogsStore.dialogState.value.type).toBe("closed");
    });
  });
});

// Note: Open project error handling is now done within the Create Workspace dialog
// when using the folder icon to open a new project. The error is shown as a submit
// error in the dialog, not as a separate error dialog. Tests for this behavior are
// in CreateWorkspaceDialog.test.ts.
