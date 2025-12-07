/**
 * Tests for the App component.
 * Tests initialization, store integration, and dialog rendering.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/svelte";
import type { Unsubscribe } from "@shared/electron-api";
import type {
  Project,
  ProjectPath,
  ProjectOpenedEvent,
  ProjectClosedEvent,
  WorkspaceSwitchedEvent,
  WorkspacePath,
} from "@shared/ipc";

// Helper to create typed ProjectPath
function asProjectPath(path: string): ProjectPath {
  return path as ProjectPath;
}

// Helper to create typed WorkspacePath
function asWorkspacePath(path: string): WorkspacePath {
  return path as WorkspacePath;
}

// Create mock API functions with vi.hoisted for proper hoisting
const mockApi = vi.hoisted(() => ({
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
  onProjectOpened: vi.fn(() => vi.fn()),
  onProjectClosed: vi.fn(() => vi.fn()),
  onWorkspaceCreated: vi.fn(() => vi.fn()),
  onWorkspaceRemoved: vi.fn(() => vi.fn()),
  onWorkspaceSwitched: vi.fn(() => vi.fn()),
}));

// Mock the API module before any imports use it
vi.mock("$lib/api", () => mockApi);

// Import after mock setup
import App from "./App.svelte";
import * as projectsStore from "$lib/stores/projects.svelte.js";
import * as dialogsStore from "$lib/stores/dialogs.svelte.js";

describe("App component", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset stores before each test
    projectsStore.reset();
    dialogsStore.reset();
    // Default to returning empty projects
    mockApi.listProjects.mockResolvedValue([]);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  describe("rendering", () => {
    it("renders Sidebar component", async () => {
      render(App);

      // Sidebar has a nav with aria-label="Projects"
      const nav = await screen.findByRole("navigation", { name: "Projects" });
      expect(nav).toBeInTheDocument();
    });

    it("renders CreateWorkspaceDialog when dialog type is 'create'", async () => {
      render(App);

      // Open create dialog
      dialogsStore.openCreateDialog("/test/project", null);

      // Wait for dialog to appear
      await waitFor(() => {
        const dialog = screen.getByRole("dialog");
        expect(dialog).toBeInTheDocument();
      });

      // Verify it's the create dialog
      expect(screen.getByText("Create Workspace")).toBeInTheDocument();
    });

    it("renders RemoveWorkspaceDialog when dialog type is 'remove'", async () => {
      render(App);

      // Open remove dialog
      dialogsStore.openRemoveDialog("/test/.worktrees/feature", null);

      // Wait for dialog to appear
      await waitFor(() => {
        const dialog = screen.getByRole("dialog");
        expect(dialog).toBeInTheDocument();
      });

      // Verify it's the remove dialog
      expect(screen.getByText("Remove Workspace")).toBeInTheDocument();
    });

    it("does not render dialogs when dialog type is 'closed'", async () => {
      render(App);

      // Dialog state is closed by default after reset
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  describe("initialization", () => {
    it("calls listProjects on mount to initialize", async () => {
      render(App);

      await waitFor(() => {
        expect(mockApi.listProjects).toHaveBeenCalledTimes(1);
      });
    });

    it("sets loadingState to 'loaded' after successful listProjects", async () => {
      const mockProjects: Project[] = [
        {
          path: asProjectPath("/test/project"),
          name: "test-project",
          workspaces: [],
        },
      ];
      mockApi.listProjects.mockResolvedValue(mockProjects);

      render(App);

      // Wait for loading to complete
      await waitFor(() => {
        expect(projectsStore.loadingState.value).toBe("loaded");
      });
    });

    it("sets loadingState to 'error' with message on listProjects failure", async () => {
      mockApi.listProjects.mockRejectedValue(new Error("Network error"));

      render(App);

      await waitFor(() => {
        expect(projectsStore.loadingState.value).toBe("error");
        expect(projectsStore.loadingError.value).toBe("Network error");
      });
    });
  });

  describe("event subscriptions", () => {
    it("subscribes to all IPC events on mount", async () => {
      render(App);

      await waitFor(() => {
        expect(mockApi.onProjectOpened).toHaveBeenCalledTimes(1);
        expect(mockApi.onProjectClosed).toHaveBeenCalledTimes(1);
        expect(mockApi.onWorkspaceCreated).toHaveBeenCalledTimes(1);
        expect(mockApi.onWorkspaceRemoved).toHaveBeenCalledTimes(1);
        expect(mockApi.onWorkspaceSwitched).toHaveBeenCalledTimes(1);
      });
    });

    it("unsubscribes from all IPC events on unmount", async () => {
      const unsubProjectOpened = vi.fn();
      const unsubProjectClosed = vi.fn();
      const unsubWorkspaceCreated = vi.fn();
      const unsubWorkspaceRemoved = vi.fn();
      const unsubWorkspaceSwitched = vi.fn();

      mockApi.onProjectOpened.mockReturnValue(unsubProjectOpened);
      mockApi.onProjectClosed.mockReturnValue(unsubProjectClosed);
      mockApi.onWorkspaceCreated.mockReturnValue(unsubWorkspaceCreated);
      mockApi.onWorkspaceRemoved.mockReturnValue(unsubWorkspaceRemoved);
      mockApi.onWorkspaceSwitched.mockReturnValue(unsubWorkspaceSwitched);

      const { unmount } = render(App);

      // Wait for subscriptions to be set up
      await waitFor(() => {
        expect(mockApi.onProjectOpened).toHaveBeenCalled();
      });

      // Unmount the component
      unmount();

      // Verify all unsubscribe functions were called
      expect(unsubProjectOpened).toHaveBeenCalledTimes(1);
      expect(unsubProjectClosed).toHaveBeenCalledTimes(1);
      expect(unsubWorkspaceCreated).toHaveBeenCalledTimes(1);
      expect(unsubWorkspaceRemoved).toHaveBeenCalledTimes(1);
      expect(unsubWorkspaceSwitched).toHaveBeenCalledTimes(1);
    });

    it("handles project:opened event by adding project to store", async () => {
      let projectOpenedCallback: ((event: ProjectOpenedEvent) => void) | null = null;
      (
        mockApi.onProjectOpened as unknown as {
          mockImplementation: (
            fn: (cb: (event: ProjectOpenedEvent) => void) => Unsubscribe
          ) => void;
        }
      ).mockImplementation((cb) => {
        projectOpenedCallback = cb;
        return vi.fn();
      });

      render(App);

      // Wait for subscriptions
      await waitFor(() => {
        expect(projectOpenedCallback).not.toBeNull();
      });

      // Simulate project opened event
      const newProject: Project = {
        path: asProjectPath("/test/new-project"),
        name: "new-project",
        workspaces: [],
      };
      projectOpenedCallback!({ project: newProject });

      // Verify project was added
      expect(projectsStore.projects.value).toContainEqual(newProject);
    });

    it("handles project:closed event by removing project from store", async () => {
      // Pre-populate store with a project
      const existingProject: Project = {
        path: asProjectPath("/test/existing"),
        name: "existing",
        workspaces: [],
      };
      mockApi.listProjects.mockResolvedValue([existingProject]);

      let projectClosedCallback: ((event: ProjectClosedEvent) => void) | null = null;
      (
        mockApi.onProjectClosed as unknown as {
          mockImplementation: (
            fn: (cb: (event: ProjectClosedEvent) => void) => Unsubscribe
          ) => void;
        }
      ).mockImplementation((cb) => {
        projectClosedCallback = cb;
        return vi.fn();
      });

      render(App);

      // Wait for initial load and subscriptions
      await waitFor(() => {
        expect(projectsStore.projects.value).toHaveLength(1);
        expect(projectClosedCallback).not.toBeNull();
      });

      // Simulate project closed event
      projectClosedCallback!({ path: asProjectPath("/test/existing") });

      // Verify project was removed
      expect(projectsStore.projects.value).toHaveLength(0);
    });

    it("handles workspace:switched event by updating active workspace", async () => {
      let workspaceSwitchedCallback: ((event: WorkspaceSwitchedEvent) => void) | null = null;
      (
        mockApi.onWorkspaceSwitched as unknown as {
          mockImplementation: (
            fn: (cb: (event: WorkspaceSwitchedEvent) => void) => Unsubscribe
          ) => void;
        }
      ).mockImplementation((cb) => {
        workspaceSwitchedCallback = cb;
        return vi.fn();
      });

      render(App);

      await waitFor(() => {
        expect(workspaceSwitchedCallback).not.toBeNull();
      });

      // Simulate workspace switched event
      workspaceSwitchedCallback!({
        workspacePath: asWorkspacePath("/test/.worktrees/feature"),
      });

      expect(projectsStore.activeWorkspacePath.value).toBe("/test/.worktrees/feature");
    });
  });
});
