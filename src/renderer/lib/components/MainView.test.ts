/**
 * Tests for MainView component.
 * Tests IPC initialization, event subscriptions, and rendering.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/svelte";
import type { Unsubscribe } from "@shared/electron-api";
import type {
  Project,
  ProjectPath,
  ProjectOpenedEvent,
  WorkspacePath,
  AgentStatusChangedEvent,
  AggregatedAgentStatus,
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
  focusActiveWorkspace: vi.fn().mockResolvedValue(undefined),
  getAgentStatus: vi.fn().mockResolvedValue({ status: "none", counts: { idle: 0, busy: 0 } }),
  getAllAgentStatuses: vi.fn().mockResolvedValue({}),
  refreshAgentStatus: vi.fn().mockResolvedValue(undefined),
  onProjectOpened: vi.fn(() => vi.fn()),
  onProjectClosed: vi.fn(() => vi.fn()),
  onWorkspaceCreated: vi.fn(() => vi.fn()),
  onWorkspaceRemoved: vi.fn(() => vi.fn()),
  onWorkspaceSwitched: vi.fn(() => vi.fn()),
  onShortcutEnable: vi.fn(() => vi.fn()),
  onShortcutDisable: vi.fn(() => vi.fn()),
  onAgentStatusChanged: vi.fn(() => vi.fn()),
  // Setup API methods
  setupReady: vi.fn().mockResolvedValue({ ready: true }),
  setupRetry: vi.fn().mockResolvedValue(undefined),
  setupQuit: vi.fn().mockResolvedValue(undefined),
  onSetupProgress: vi.fn(() => vi.fn()),
  onSetupComplete: vi.fn(() => vi.fn()),
  onSetupError: vi.fn(() => vi.fn()),
}));

// Mock the API module before any imports use it
vi.mock("$lib/api", () => mockApi);

// Import after mock setup
import MainView from "./MainView.svelte";
import * as projectsStore from "$lib/stores/projects.svelte.js";
import * as dialogsStore from "$lib/stores/dialogs.svelte.js";
import * as shortcutsStore from "$lib/stores/shortcuts.svelte.js";
import * as agentStatusStore from "$lib/stores/agent-status.svelte.js";

describe("MainView component", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset stores before each test
    projectsStore.reset();
    dialogsStore.reset();
    shortcutsStore.reset();
    agentStatusStore.reset();
    // Default to returning empty projects
    mockApi.listProjects.mockResolvedValue([]);
    // Default to returning empty agent statuses
    mockApi.getAllAgentStatuses.mockResolvedValue({});
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  describe("rendering", () => {
    it("renders main-view container element", async () => {
      render(MainView);

      await waitFor(() => {
        // MainView renders a div container (App.svelte owns the <main> landmark)
        const container = document.querySelector(".main-view");
        expect(container).toBeInTheDocument();
      });
    });

    it("renders Sidebar component", async () => {
      render(MainView);

      // Sidebar has a nav with aria-label="Projects"
      const nav = await screen.findByRole("navigation", { name: "Projects" });
      expect(nav).toBeInTheDocument();
    });

    it("renders ShortcutOverlay component", async () => {
      render(MainView);

      await waitFor(() => {
        const overlay = document.querySelector(".shortcut-overlay");
        expect(overlay).toBeInTheDocument();
      });
    });
  });

  describe("IPC initialization", () => {
    it("calls listProjects on mount", async () => {
      render(MainView);

      await waitFor(() => {
        expect(mockApi.listProjects).toHaveBeenCalledTimes(1);
      });
    });

    it("calls getAllAgentStatuses on mount", async () => {
      render(MainView);

      await waitFor(() => {
        expect(mockApi.getAllAgentStatuses).toHaveBeenCalledTimes(1);
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

      render(MainView);

      await waitFor(() => {
        expect(projectsStore.loadingState.value).toBe("loaded");
      });
    });

    it("sets loadingState to 'error' on listProjects failure", async () => {
      mockApi.listProjects.mockRejectedValue(new Error("Network error"));

      render(MainView);

      await waitFor(() => {
        expect(projectsStore.loadingState.value).toBe("error");
        expect(projectsStore.loadingError.value).toBe("Network error");
      });
    });
  });

  describe("event subscriptions", () => {
    it("subscribes to all IPC events on mount", async () => {
      render(MainView);

      await waitFor(() => {
        expect(mockApi.onProjectOpened).toHaveBeenCalledTimes(1);
        expect(mockApi.onProjectClosed).toHaveBeenCalledTimes(1);
        expect(mockApi.onWorkspaceCreated).toHaveBeenCalledTimes(1);
        expect(mockApi.onWorkspaceRemoved).toHaveBeenCalledTimes(1);
        expect(mockApi.onWorkspaceSwitched).toHaveBeenCalledTimes(1);
        expect(mockApi.onAgentStatusChanged).toHaveBeenCalledTimes(1);
      });
    });

    it("unsubscribes from all IPC events on unmount", async () => {
      const unsubProjectOpened = vi.fn();
      const unsubProjectClosed = vi.fn();
      const unsubWorkspaceCreated = vi.fn();
      const unsubWorkspaceRemoved = vi.fn();
      const unsubWorkspaceSwitched = vi.fn();
      const unsubAgentStatusChanged = vi.fn();

      mockApi.onProjectOpened.mockReturnValue(unsubProjectOpened);
      mockApi.onProjectClosed.mockReturnValue(unsubProjectClosed);
      mockApi.onWorkspaceCreated.mockReturnValue(unsubWorkspaceCreated);
      mockApi.onWorkspaceRemoved.mockReturnValue(unsubWorkspaceRemoved);
      mockApi.onWorkspaceSwitched.mockReturnValue(unsubWorkspaceSwitched);
      mockApi.onAgentStatusChanged.mockReturnValue(unsubAgentStatusChanged);

      const { unmount } = render(MainView);

      await waitFor(() => {
        expect(mockApi.onProjectOpened).toHaveBeenCalled();
      });

      unmount();

      expect(unsubProjectOpened).toHaveBeenCalledTimes(1);
      expect(unsubProjectClosed).toHaveBeenCalledTimes(1);
      expect(unsubWorkspaceCreated).toHaveBeenCalledTimes(1);
      expect(unsubWorkspaceRemoved).toHaveBeenCalledTimes(1);
      expect(unsubWorkspaceSwitched).toHaveBeenCalledTimes(1);
      expect(unsubAgentStatusChanged).toHaveBeenCalledTimes(1);
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

      render(MainView);

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

      expect(projectsStore.projects.value).toContainEqual(newProject);
    });

    it("handles agent:status-changed event by updating store", async () => {
      let agentStatusCallback: ((event: AgentStatusChangedEvent) => void) | null = null;
      (
        mockApi.onAgentStatusChanged as unknown as {
          mockImplementation: (
            fn: (cb: (event: AgentStatusChangedEvent) => void) => Unsubscribe
          ) => void;
        }
      ).mockImplementation((cb) => {
        agentStatusCallback = cb;
        return vi.fn();
      });

      render(MainView);

      await waitFor(() => {
        expect(agentStatusCallback).not.toBeNull();
      });

      // Simulate agent status changed event
      const newStatus: AggregatedAgentStatus = {
        status: "busy",
        counts: { idle: 0, busy: 3 },
      };
      agentStatusCallback!({
        workspacePath: asWorkspacePath("/test/.worktrees/feature"),
        status: newStatus,
      });

      expect(agentStatusStore.getStatus("/test/.worktrees/feature")).toEqual(newStatus);
    });
  });

  describe("dialog state sync", () => {
    it("calls setDialogMode(true) when dialog opens", async () => {
      render(MainView);

      // Wait for mount to complete
      await waitFor(() => {
        expect(mockApi.listProjects).toHaveBeenCalled();
      });

      // Clear initial calls
      mockApi.setDialogMode.mockClear();

      // Open a dialog
      dialogsStore.openCreateDialog("/test/project", null);

      await waitFor(() => {
        expect(mockApi.setDialogMode).toHaveBeenCalledWith(true);
      });
    });

    it("calls setDialogMode(false) when dialog closes", async () => {
      // Start with dialog open
      dialogsStore.openCreateDialog("/test/project", null);

      render(MainView);

      // Wait for mount
      await waitFor(() => {
        expect(mockApi.listProjects).toHaveBeenCalled();
      });

      // Clear calls
      mockApi.setDialogMode.mockClear();

      // Close dialog
      dialogsStore.closeDialog();

      await waitFor(() => {
        expect(mockApi.setDialogMode).toHaveBeenCalledWith(false);
      });
    });
  });

  describe("dialogs", () => {
    it("renders CreateWorkspaceDialog when dialog type is 'create'", async () => {
      render(MainView);

      // Wait for mount
      await waitFor(() => {
        expect(mockApi.listProjects).toHaveBeenCalled();
      });

      // Open create dialog
      dialogsStore.openCreateDialog("/test/project", null);

      await waitFor(() => {
        const dialog = screen.getByRole("dialog");
        expect(dialog).toBeInTheDocument();
        expect(screen.getByText("Create Workspace")).toBeInTheDocument();
      });
    });

    it("renders RemoveWorkspaceDialog when dialog type is 'remove'", async () => {
      render(MainView);

      // Wait for mount
      await waitFor(() => {
        expect(mockApi.listProjects).toHaveBeenCalled();
      });

      // Open remove dialog
      dialogsStore.openRemoveDialog("/test/.worktrees/feature", null);

      await waitFor(() => {
        const dialog = screen.getByRole("dialog");
        expect(dialog).toBeInTheDocument();
        expect(screen.getByText("Remove Workspace")).toBeInTheDocument();
      });
    });
  });

  describe("focus management", () => {
    it("focuses first focusable element on mount", async () => {
      render(MainView);

      // Wait for mount to complete
      await waitFor(() => {
        expect(mockApi.listProjects).toHaveBeenCalled();
      });

      // The "Open Project" button should be focused (it's the first focusable element in Sidebar)
      await waitFor(() => {
        const openProjectButton = screen.getByRole("button", { name: /open project/i });
        expect(openProjectButton).toHaveFocus();
      });
    });
  });
});
