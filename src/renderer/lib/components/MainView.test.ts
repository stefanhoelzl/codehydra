/**
 * Tests for MainView component.
 *
 * These are component integration tests that verify the behavior through the rendered
 * component. They test that setup functions are wired correctly and work together.
 *
 * For focused tests of individual setup functions, see:
 * - setup-deletion-progress.test.ts
 * - setup-domain-event-bindings.test.ts
 * - initialize-app.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/svelte";
import type { WorkspaceName } from "@shared/api/types";
import type { WorkspacePath } from "@shared/ipc";
import { createMockProject } from "$lib/test-fixtures";
import { asProjectId, asWorkspaceRef } from "@shared/test-fixtures";

// Storage for API event callbacks - allows tests to fire events
type EventCallback = (...args: unknown[]) => void;
const eventCallbacks = new Map<string, EventCallback>();

// Create mock API functions with vi.hoisted for proper hoisting
const mockApi = vi.hoisted(() => ({
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
    remove: vi.fn().mockResolvedValue({ started: true }),
    getStatus: vi.fn().mockResolvedValue({ isDirty: false, agent: { type: "none" } }),
    get: vi.fn().mockResolvedValue(undefined),
  },
  // Flat API structure - ui namespace
  ui: {
    selectFolder: vi.fn().mockResolvedValue(null),
    getActiveWorkspace: vi.fn().mockResolvedValue(null),
    switchWorkspace: vi.fn().mockResolvedValue(undefined),
    setMode: vi.fn().mockResolvedValue(undefined),
  },
  // Flat API structure - lifecycle namespace
  lifecycle: {
    ready: vi.fn().mockResolvedValue(undefined),
    quit: vi.fn().mockResolvedValue(undefined),
  },
  // on() captures callbacks by event name for tests to fire events
  on: vi.fn((event: string, callback: EventCallback) => {
    eventCallbacks.set(event, callback);
    return vi.fn(); // unsubscribe
  }),
}));

// Helper to get an event callback for firing events in tests
function getEventCallback(event: string): EventCallback | undefined {
  return eventCallbacks.get(event);
}

// Helper to clear event callbacks between tests
function clearEventCallbacks(): void {
  eventCallbacks.clear();
}

// Mock the API module before any imports use it
vi.mock("$lib/api", () => mockApi);

// Mock AgentNotificationService for testing chime behavior
const { mockSeedInitialCounts, mockHandleStatusChange, MockAgentNotificationService } = vi.hoisted(
  () => {
    const mockSeedInitialCounts = vi.fn();
    const mockHandleStatusChange = vi.fn();

    class MockAgentNotificationService {
      seedInitialCounts = mockSeedInitialCounts;
      handleStatusChange = mockHandleStatusChange;
      removeWorkspace = vi.fn();
      setEnabled = vi.fn();
      isEnabled = vi.fn().mockReturnValue(true);
      reset = vi.fn();
    }

    return { mockSeedInitialCounts, mockHandleStatusChange, MockAgentNotificationService };
  }
);

vi.mock("$lib/services/agent-notifications", () => ({
  AgentNotificationService: MockAgentNotificationService,
}));

// Import after mock setup
import MainView from "./MainView.svelte";
import * as projectsStore from "$lib/stores/projects.svelte.js";
import * as dialogsStore from "$lib/stores/dialogs.svelte.js";
import * as shortcutsStore from "$lib/stores/shortcuts.svelte.js";
import * as agentStatusStore from "$lib/stores/agent-status.svelte.js";
import * as deletionStore from "$lib/stores/deletion.svelte.js";
import type { DeletionProgress } from "@shared/api/types";

describe("MainView component", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset stores before each test
    projectsStore.reset();
    dialogsStore.reset();
    shortcutsStore.reset();
    agentStatusStore.reset();
    deletionStore.reset();
    // Clear event callbacks between tests
    clearEventCallbacks();
    // Default to returning empty projects
    mockApi.projects.list.mockResolvedValue([]);
    mockApi.ui.getActiveWorkspace.mockResolvedValue(null);
    // Configure lifecycle.ready to simulate event-driven store population:
    // reads from projects.list and ui.getActiveWorkspace mocks (set per-test)
    mockApi.lifecycle.ready.mockImplementation(async () => {
      const projectList = await mockApi.projects.list();
      for (const p of projectList) {
        projectsStore.addProject(p);
      }
      const activeRef = await mockApi.ui.getActiveWorkspace();
      projectsStore.setActiveWorkspace(activeRef?.path ?? null);
    });
    // Agent statuses are fetched per-workspace via workspaces.getStatus (already mocked in mockApi)
    // Reset notification service mocks
    mockSeedInitialCounts.mockReset();
    mockHandleStatusChange.mockReset();
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

    it("renders empty-backdrop when no workspace is active", async () => {
      render(MainView);

      await waitFor(() => {
        expect(projectsStore.loadingState.value).toBe("loaded");
      });

      // No active workspace = backdrop should be visible
      const backdrop = document.querySelector(".empty-backdrop");
      expect(backdrop).toBeInTheDocument();
    });

    it("renders Logo in empty-backdrop when no workspace is active", async () => {
      render(MainView);

      await waitFor(() => {
        expect(projectsStore.loadingState.value).toBe("loaded");
      });

      // Logo should be inside the backdrop
      const backdrop = document.querySelector(".empty-backdrop");
      const logo = backdrop?.querySelector("img");
      expect(logo).toBeInTheDocument();
      // Logo should not be animated in backdrop
      expect(logo).not.toHaveClass("animated");
    });

    it("hides empty-backdrop and Logo when a workspace is active", async () => {
      const projectWithWorkspace = [
        {
          id: asProjectId("test-project-12345678"),
          path: "/test/project",
          name: "test-project",
          workspaces: [
            {
              projectId: asProjectId("test-project-12345678"),
              path: "/test/.worktrees/feature",
              name: "feature",
              branch: "feature",
            },
          ],
        },
      ];
      mockApi.projects.list.mockResolvedValue(projectWithWorkspace);
      mockApi.ui.getActiveWorkspace.mockResolvedValue(null);

      render(MainView);

      await waitFor(() => {
        expect(projectsStore.loadingState.value).toBe("loaded");
      });

      // Simulate workspace switch to activate a workspace
      projectsStore.setActiveWorkspace("/test/.worktrees/feature");

      await waitFor(() => {
        const backdrop = document.querySelector(".empty-backdrop");
        expect(backdrop).not.toBeInTheDocument();
        // Logo should also be hidden (it's inside the backdrop)
        const backdropLogo = document.querySelector(".backdrop-logo");
        expect(backdropLogo).not.toBeInTheDocument();
      });
    });
  });

  describe("IPC initialization", () => {
    it("calls projects.list on mount", async () => {
      render(MainView);

      await waitFor(() => {
        expect(mockApi.projects.list).toHaveBeenCalledTimes(1);
      });
    });

    it("calls ui.getActiveWorkspace on mount", async () => {
      render(MainView);

      await waitFor(() => {
        expect(mockApi.ui.getActiveWorkspace).toHaveBeenCalledTimes(1);
      });
    });

    it("calls workspaces.getStatus for each workspace on mount", async () => {
      const mockProjects = [
        {
          id: asProjectId("test-project-12345678"),
          path: "/test/project",
          name: "test-project",
          workspaces: [
            {
              projectId: asProjectId("test-project-12345678"),
              path: "/test/.worktrees/feature",
              name: "feature",
              branch: "feature",
            },
            {
              projectId: asProjectId("test-project-12345678"),
              path: "/test/.worktrees/bugfix",
              name: "bugfix",
              branch: "bugfix",
            },
          ],
        },
      ];
      mockApi.projects.list.mockResolvedValue(mockProjects);

      render(MainView);

      await waitFor(() => {
        // Should call getStatus for each workspace
        expect(mockApi.workspaces.getStatus).toHaveBeenCalledWith(
          "test-project-12345678",
          "feature"
        );
        expect(mockApi.workspaces.getStatus).toHaveBeenCalledWith(
          "test-project-12345678",
          "bugfix"
        );
      });
    });

    it("sets loadingState to 'loaded' after successful projects.list", async () => {
      const mockProjects = [
        {
          id: asProjectId("test-project-12345678"),
          path: "/test/project",
          name: "test-project",
          workspaces: [],
        },
      ];
      mockApi.projects.list.mockResolvedValue(mockProjects);

      render(MainView);

      await waitFor(() => {
        expect(projectsStore.loadingState.value).toBe("loaded");
      });
    });

    it("sets loadingState to 'error' on projects.list failure", async () => {
      mockApi.projects.list.mockRejectedValue(new Error("Network error"));

      render(MainView);

      await waitFor(() => {
        expect(projectsStore.loadingState.value).toBe("error");
        expect(projectsStore.loadingError.value).toBe("Network error");
      });
    });
  });

  describe("event subscriptions", () => {
    it("subscribes to all API events on mount", async () => {
      render(MainView);

      // API uses on() with event name strings
      await waitFor(() => {
        // Check that on() was called for each event type
        const onCalls = mockApi.on.mock.calls;
        const eventNames = onCalls.map((call: unknown[]) => call[0]);
        expect(eventNames).toContain("project:opened");
        expect(eventNames).toContain("project:closed");
        expect(eventNames).toContain("workspace:created");
        expect(eventNames).toContain("workspace:removed");
        expect(eventNames).toContain("workspace:switched");
        expect(eventNames).toContain("workspace:status-changed");
      });
    });

    it("unsubscribes from all API events on unmount", async () => {
      const unsubscribers: ReturnType<typeof vi.fn>[] = [];
      mockApi.on.mockImplementation((event: string, callback: EventCallback) => {
        eventCallbacks.set(event, callback);
        const unsub = vi.fn();
        unsubscribers.push(unsub);
        return unsub;
      });

      const { unmount } = render(MainView);

      await waitFor(() => {
        // Wait for all event subscriptions to be set up
        expect(eventCallbacks.size).toBeGreaterThanOrEqual(6);
      });

      unmount();

      // All unsubscribers should have been called
      for (const unsub of unsubscribers) {
        expect(unsub).toHaveBeenCalledTimes(1);
      }
    });

    it("handles project:opened event by adding project to store", async () => {
      render(MainView);

      await waitFor(() => {
        expect(getEventCallback("project:opened")).toBeDefined();
      });

      // Simulate project opened event (includes 'id')
      const newProject = {
        id: asProjectId("new-project-12345678"),
        path: "/test/new-project",
        name: "new-project",
        workspaces: [],
      };
      const callback = getEventCallback("project:opened");
      callback!({ project: newProject });

      // Check path since projects now have generated id
      const addedProject = projectsStore.projects.value.find((p) => p.path === newProject.path);
      expect(addedProject).toBeDefined();
      expect(addedProject?.name).toBe(newProject.name);
    });

    it("handles workspace:status-changed event by updating store", async () => {
      render(MainView);

      await waitFor(() => {
        expect(getEventCallback("workspace:status-changed")).toBeDefined();
      });

      // Simulate workspace:status-changed event (uses WorkspaceRef + WorkspaceStatus)
      const workspaceRef = asWorkspaceRef(
        "test-project-12345678",
        "feature",
        "/test/.worktrees/feature"
      );
      const callback = getEventCallback("workspace:status-changed");
      callback!({
        ...workspaceRef,
        status: {
          isDirty: false,
          agent: { type: "busy", counts: { idle: 0, busy: 3, total: 3 } },
        },
      });

      // Status is stored directly as AgentStatus (v2 format)
      const storedStatus = agentStatusStore.getStatus("/test/.worktrees/feature");
      expect(storedStatus.type).toBe("busy");
      // Use type narrowing to access counts
      if (storedStatus.type !== "none") {
        expect(storedStatus.counts).toEqual({ idle: 0, busy: 3, total: 3 });
      }
    });

    it("seeds notification service with initial counts from workspaces.getStatus", async () => {
      // Setup projects with workspaces
      const mockProjects = [
        {
          id: asProjectId("test-project-12345678"),
          path: "/test/project",
          name: "test-project",
          workspaces: [
            {
              projectId: asProjectId("test-project-12345678"),
              path: "/test/.worktrees/feature",
              name: "feature",
              branch: "feature",
            },
            {
              projectId: asProjectId("test-project-12345678"),
              path: "/test/.worktrees/bugfix",
              name: "bugfix",
              branch: "bugfix",
            },
          ],
        },
      ];
      mockApi.projects.list.mockResolvedValue(mockProjects);

      // Mock getStatus to return different statuses per workspace
      mockApi.workspaces.getStatus.mockImplementation(
        async (_projectId: string, workspaceName: string) => {
          if (workspaceName === "feature") {
            return {
              isDirty: false,
              agent: { type: "busy", counts: { idle: 0, busy: 2, total: 2 } },
            };
          }
          return {
            isDirty: false,
            agent: { type: "idle", counts: { idle: 1, busy: 0, total: 1 } },
          };
        }
      );

      render(MainView);

      await waitFor(() => {
        expect(mockSeedInitialCounts).toHaveBeenCalledWith({
          "/test/.worktrees/feature": { idle: 0, busy: 2 },
          "/test/.worktrees/bugfix": { idle: 1, busy: 0 },
        });
      });
    });

    it("notification service receives status changes for chime detection", async () => {
      render(MainView);

      await waitFor(() => {
        expect(getEventCallback("workspace:status-changed")).toBeDefined();
      });

      // Simulate workspace:status-changed event (agent finished work)
      const workspaceRef = asWorkspaceRef(
        "test-project-12345678",
        "feature",
        "/test/.worktrees/feature"
      );
      const callback = getEventCallback("workspace:status-changed");
      callback!({
        ...workspaceRef,
        status: {
          isDirty: false,
          agent: { type: "idle", counts: { idle: 1, busy: 0, total: 1 } },
        },
      });

      // Notification service should have been called to detect chime condition
      expect(mockHandleStatusChange).toHaveBeenCalledWith("/test/.worktrees/feature", {
        idle: 1,
        busy: 0,
        total: 1,
      });
    });
  });

  describe("dialog state sync", () => {
    it("calls setMode('dialog') when dialog opens", async () => {
      render(MainView);

      // Wait for mount to complete
      await waitFor(() => {
        expect(mockApi.projects.list).toHaveBeenCalled();
      });

      // Clear initial calls
      mockApi.ui.setMode.mockClear();

      // Open a dialog
      dialogsStore.openCreateDialog(asProjectId("test-project-12345678"));

      await waitFor(() => {
        expect(mockApi.ui.setMode).toHaveBeenCalledWith("dialog");
      });
    });

    it("calls setMode('workspace') when dialog closes", async () => {
      // Start with dialog open
      dialogsStore.openCreateDialog(asProjectId("test-project-12345678"));

      render(MainView);

      // Wait for mount
      await waitFor(() => {
        expect(mockApi.projects.list).toHaveBeenCalled();
      });

      // Clear calls
      mockApi.ui.setMode.mockClear();

      // Close dialog
      dialogsStore.closeDialog();

      await waitFor(() => {
        expect(mockApi.ui.setMode).toHaveBeenCalledWith("workspace");
      });
    });

    it("calls setMode('workspace') when dialog closes with active workspace", async () => {
      const projectWithWorkspace = [
        {
          id: asProjectId("test-project-12345678"),
          path: "/test/project",
          name: "test-project",
          workspaces: [
            {
              projectId: asProjectId("test-project-12345678"),
              path: "/test/.worktrees/feature",
              name: "feature",
              branch: "feature",
            },
          ],
        },
      ];
      mockApi.projects.list.mockResolvedValue(projectWithWorkspace);
      mockApi.ui.getActiveWorkspace.mockResolvedValue({
        projectId: asProjectId("test-project-12345678"),
        workspaceName: "feature",
        path: "/test/.worktrees/feature",
      });

      render(MainView);

      // Wait for mount and active workspace to be set
      await waitFor(() => {
        expect(projectsStore.activeWorkspacePath.value).toBe("/test/.worktrees/feature");
      });

      // Open a dialog
      dialogsStore.openCreateDialog(asProjectId("test-project-12345678"));

      await waitFor(() => {
        expect(mockApi.ui.setMode).toHaveBeenCalledWith("dialog");
      });

      // Clear calls
      mockApi.ui.setMode.mockClear();

      // Close dialog
      dialogsStore.closeDialog();

      // setMode("workspace") handles both z-order and focus
      await waitFor(() => {
        expect(mockApi.ui.setMode).toHaveBeenCalledWith("workspace");
      });
    });

    it("calls setMode('workspace') when dialog closes with no active workspace", async () => {
      // Start with a project that has no workspaces
      const project = createMockProject({
        id: asProjectId("test-project-12345678"),
        workspaces: [],
      });
      mockApi.projects.list.mockResolvedValue([project]);
      mockApi.ui.getActiveWorkspace.mockResolvedValue(null);

      render(MainView);

      // Wait for mount and auto-open create dialog to complete
      await waitFor(() => {
        expect(mockApi.projects.list).toHaveBeenCalled();
        expect(screen.getByRole("dialog")).toBeInTheDocument();
      });

      await waitFor(() => {
        expect(mockApi.ui.setMode).toHaveBeenCalledWith("dialog");
      });

      // Clear calls
      mockApi.ui.setMode.mockClear();

      // Close dialog
      dialogsStore.closeDialog();

      // setMode("workspace") is still called even without active workspace
      // ViewManager's setMode("workspace") gracefully handles null activeWorkspacePath
      await waitFor(() => {
        expect(mockApi.ui.setMode).toHaveBeenCalledWith("workspace");
      });
    });
  });

  describe("dialogs", () => {
    it("renders CreateWorkspaceDialog when dialog type is 'create'", async () => {
      render(MainView);

      // Wait for mount
      await waitFor(() => {
        expect(mockApi.projects.list).toHaveBeenCalled();
      });

      // Open create dialog
      dialogsStore.openCreateDialog(asProjectId("test-project-12345678"));

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
        expect(mockApi.projects.list).toHaveBeenCalled();
      });

      // Open remove dialog
      dialogsStore.openRemoveDialog(
        asWorkspaceRef("test-project-12345678", "feature", "/test/.worktrees/feature")
      );

      await waitFor(() => {
        const dialog = screen.getByRole("dialog");
        expect(dialog).toBeInTheDocument();
        expect(screen.getByText("Remove Workspace")).toBeInTheDocument();
      });
    });
  });

  // Note: Focus management is not tested at the MainView level since focus behavior
  // depends on the specific UI state (projects loaded, dialogs open, etc.). Focus
  // is managed by individual components like Sidebar and dialogs.

  describe("auto-open create workspace dialog", () => {
    it("auto-opens create dialog on mount when projects array is empty", async () => {
      mockApi.projects.list.mockResolvedValue([]);

      render(MainView);

      // Wait for create dialog to auto-open
      await waitFor(() => {
        expect(screen.getByRole("dialog")).toBeInTheDocument();
        expect(screen.getByText("Create Workspace")).toBeInTheDocument();
      });

      // Verify folder picker was NOT automatically called
      expect(mockApi.ui.selectFolder).not.toHaveBeenCalled();
    });

    it("auto-opens create dialog when projects exist but no workspaces", async () => {
      const existingProject = {
        id: asProjectId("test-project-12345678"),
        path: "/test/project",
        name: "test-project",
        workspaces: [],
      };
      mockApi.projects.list.mockResolvedValue([existingProject]);

      render(MainView);

      // Wait for create dialog to auto-open
      await waitFor(() => {
        expect(screen.getByRole("dialog")).toBeInTheDocument();
        expect(screen.getByText("Create Workspace")).toBeInTheDocument();
      });

      // Verify folder picker was NOT automatically called
      expect(mockApi.ui.selectFolder).not.toHaveBeenCalled();
    });
  });

  describe("auto-open create dialog", () => {
    it("auto-opens create dialog when project:opened event has no workspaces", async () => {
      // Start with one project so auto-open picker doesn't trigger
      const existingProject = {
        id: asProjectId("test-project-12345678"),
        path: "/test/project",
        name: "test-project",
        workspaces: [
          {
            projectId: asProjectId("test-project-12345678"),
            path: "/test/.worktrees/feature",
            name: "feature",
            branch: "feature",
          },
        ],
      };
      mockApi.projects.list.mockResolvedValue([existingProject]);

      render(MainView);

      await waitFor(() => {
        expect(getEventCallback("project:opened")).toBeDefined();
      });

      // Simulate opening a project with no workspaces (includes 'id')
      const emptyProject = {
        id: asProjectId("empty-project-12345678"),
        path: "/test/empty-project",
        name: "empty-project",
        workspaces: [],
      };
      const callback = getEventCallback("project:opened");
      callback!({ project: emptyProject });

      await waitFor(() => {
        expect(dialogsStore.dialogState.value.type).toBe("create");
        if (dialogsStore.dialogState.value.type === "create") {
          // API provides the project ID directly
          expect(dialogsStore.dialogState.value.projectId).toBe(emptyProject.id);
        }
      });
    });

    it("does NOT auto-open dialog when project has workspaces", async () => {
      // Start with one project
      const existingProject = {
        id: asProjectId("test-project-12345678"),
        path: "/test/project",
        name: "test-project",
        workspaces: [],
      };
      mockApi.projects.list.mockResolvedValue([existingProject]);

      render(MainView);

      await waitFor(() => {
        expect(getEventCallback("project:opened")).toBeDefined();
      });

      // Simulate opening a project WITH workspaces
      const projectWithWorkspaces = {
        id: asProjectId("full-project-12345678"),
        path: "/test/full-project",
        name: "full-project",
        workspaces: [
          {
            projectId: asProjectId("full-project-12345678"),
            path: "/test/.worktrees/main",
            name: "main",
            branch: "main",
          },
        ],
      };
      const callback = getEventCallback("project:opened");
      callback!({ project: projectWithWorkspaces });

      // Give time for any auto-open to trigger
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(dialogsStore.dialogState.value.type).toBe("closed");
    });

    it("does NOT auto-open dialog when another dialog is already open", async () => {
      // Start with one project
      const existingProject = {
        id: asProjectId("test-project-12345678"),
        path: "/test/project",
        name: "test-project",
        workspaces: [
          {
            projectId: asProjectId("test-project-12345678"),
            path: "/test/.worktrees/feature",
            name: "feature",
            branch: "feature",
          },
        ],
      };
      mockApi.projects.list.mockResolvedValue([existingProject]);

      render(MainView);

      await waitFor(() => {
        expect(getEventCallback("project:opened")).toBeDefined();
      });

      // Open a remove dialog first
      dialogsStore.openRemoveDialog(
        asWorkspaceRef("test-project-12345678", "feature", "/test/.worktrees/feature")
      );

      expect(dialogsStore.dialogState.value.type).toBe("remove");

      // Simulate opening a project with no workspaces
      const emptyProject = {
        id: asProjectId("empty-project-12345678"),
        path: "/test/empty-project",
        name: "empty-project",
        workspaces: [],
      };
      const callback = getEventCallback("project:opened");
      callback!({ project: emptyProject });

      // Give time for any auto-open to trigger
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should still be remove dialog, not auto-opened create
      expect(dialogsStore.dialogState.value.type).toBe("remove");
    });

    it("handles rapid project:opened events (only one dialog opens)", async () => {
      // Start with one project so auto-open picker doesn't trigger
      const existingProject = {
        id: asProjectId("test-project-12345678"),
        path: "/test/project",
        name: "test-project",
        workspaces: [
          {
            projectId: asProjectId("test-project-12345678"),
            path: "/test/.worktrees/feature",
            name: "feature",
            branch: "feature",
          },
        ],
      };
      mockApi.projects.list.mockResolvedValue([existingProject]);

      render(MainView);

      await waitFor(() => {
        expect(getEventCallback("project:opened")).toBeDefined();
      });

      // Simulate rapid project:opened events for empty projects
      const emptyProject1 = {
        id: asProjectId("empty-project-1-12345678"),
        path: "/test/empty-project-1",
        name: "empty-project-1",
        workspaces: [],
      };
      const emptyProject2 = {
        id: asProjectId("empty-project-2-12345678"),
        path: "/test/empty-project-2",
        name: "empty-project-2",
        workspaces: [],
      };

      const callback = getEventCallback("project:opened");
      // Fire both events rapidly
      callback!({ project: emptyProject1 });
      callback!({ project: emptyProject2 });

      await waitFor(() => {
        expect(dialogsStore.dialogState.value.type).toBe("create");
      });

      // Only the first project's dialog should be open (guard prevents second)
      if (dialogsStore.dialogState.value.type === "create") {
        // API provides the project ID directly - should be first project
        expect(dialogsStore.dialogState.value.projectId).toBe(emptyProject1.id);
      }
    });
  });

  describe("deletion progress", () => {
    // Helper to create deletion progress payload
    function createDeletionProgress(
      workspacePath: string,
      overrides: Partial<DeletionProgress> = {}
    ): DeletionProgress {
      return {
        workspacePath: workspacePath as WorkspacePath,
        workspaceName: "feature" as WorkspaceName,
        projectId: asProjectId("test-project-12345678"),
        keepBranch: false,
        operations: [
          { id: "kill-terminals", label: "Terminating processes", status: "pending" },
          { id: "cleanup-vscode", label: "Closing VS Code view", status: "pending" },
          { id: "cleanup-workspace", label: "Removing workspace", status: "pending" },
        ],
        completed: false,
        hasErrors: false,
        ...overrides,
      };
    }

    it("subscribes to workspace:deletion-progress on mount", async () => {
      render(MainView);

      await waitFor(() => {
        const onCalls = mockApi.on.mock.calls;
        const eventNames = onCalls.map((call: unknown[]) => call[0]);
        expect(eventNames).toContain("workspace:deletion-progress");
      });
    });

    it("unsubscribes from workspace:deletion-progress on unmount", async () => {
      const unsubscribers: ReturnType<typeof vi.fn>[] = [];
      mockApi.on.mockImplementation((event: string, callback: EventCallback) => {
        eventCallbacks.set(event, callback);
        const unsub = vi.fn();
        unsubscribers.push(unsub);
        return unsub;
      });

      const { unmount } = render(MainView);

      await waitFor(() => {
        expect(getEventCallback("workspace:deletion-progress")).toBeDefined();
      });

      unmount();

      // All unsubscribers should have been called (including deletion-progress)
      expect(unsubscribers.length).toBeGreaterThan(0);
      for (const unsub of unsubscribers) {
        expect(unsub).toHaveBeenCalledTimes(1);
      }
    });

    it("shows DeletionProgressView when active workspace is deleting", async () => {
      const projectWithWorkspace = {
        id: asProjectId("test-project-12345678"),
        path: "/test/project",
        name: "test-project",
        workspaces: [
          {
            projectId: asProjectId("test-project-12345678"),
            path: "/test/.worktrees/feature",
            name: "feature" as WorkspaceName,
            branch: "feature",
          },
        ],
      };
      mockApi.projects.list.mockResolvedValue([projectWithWorkspace]);

      render(MainView);

      await waitFor(() => {
        expect(getEventCallback("workspace:deletion-progress")).toBeDefined();
      });

      // Set active workspace
      projectsStore.setActiveWorkspace("/test/.worktrees/feature");

      // Simulate deletion progress event
      const callback = getEventCallback("workspace:deletion-progress");
      callback!(createDeletionProgress("/test/.worktrees/feature"));

      await waitFor(() => {
        // Use heading role to distinguish from operation label with same text
        expect(screen.getByRole("heading", { name: "Removing workspace" })).toBeInTheDocument();
        expect(screen.getByText(/"feature"/)).toBeInTheDocument();
      });
    });

    it("does not show DeletionProgressView for non-active deleting workspace", async () => {
      const projectWithWorkspaces = {
        id: asProjectId("test-project-12345678"),
        path: "/test/project",
        name: "test-project",
        workspaces: [
          {
            projectId: asProjectId("test-project-12345678"),
            path: "/test/.worktrees/feature",
            name: "feature" as WorkspaceName,
            branch: "feature",
          },
          {
            projectId: asProjectId("test-project-12345678"),
            path: "/test/.worktrees/bugfix",
            name: "bugfix" as WorkspaceName,
            branch: "bugfix",
          },
        ],
      };
      mockApi.projects.list.mockResolvedValue([projectWithWorkspaces]);

      render(MainView);

      await waitFor(() => {
        expect(getEventCallback("workspace:deletion-progress")).toBeDefined();
      });

      // Set active workspace to feature
      projectsStore.setActiveWorkspace("/test/.worktrees/feature");

      // Simulate deletion of bugfix (not active)
      const callback = getEventCallback("workspace:deletion-progress");
      callback!(
        createDeletionProgress("/test/.worktrees/bugfix", {
          workspaceName: "bugfix" as WorkspaceName,
        })
      );

      // Should NOT show deletion view (bugfix is not active)
      await waitFor(() => {
        expect(screen.queryByText("Removing workspace")).not.toBeInTheDocument();
      });
    });

    it("auto-clears deletion state on successful completion", async () => {
      render(MainView);

      await waitFor(() => {
        expect(getEventCallback("workspace:deletion-progress")).toBeDefined();
      });

      // Set active workspace
      projectsStore.setActiveWorkspace("/test/.worktrees/feature");

      // Simulate deletion progress event
      const callback = getEventCallback("workspace:deletion-progress");
      callback!(createDeletionProgress("/test/.worktrees/feature"));

      // Verify deletion state is set
      expect(deletionStore.getDeletionStatus("/test/.worktrees/feature")).not.toBe("none");

      // Simulate successful completion
      callback!(
        createDeletionProgress("/test/.worktrees/feature", {
          operations: [
            { id: "cleanup-vscode", label: "Cleanup VS Code", status: "done" },
            { id: "cleanup-workspace", label: "Cleanup workspace", status: "done" },
          ],
          completed: true,
          hasErrors: false,
        })
      );

      // Deletion state should be cleared
      expect(deletionStore.getDeletionStatus("/test/.worktrees/feature")).toBe("none");
    });

    it("does not clear deletion state on completion with errors", async () => {
      render(MainView);

      await waitFor(() => {
        expect(getEventCallback("workspace:deletion-progress")).toBeDefined();
      });

      // Simulate deletion progress with error completion
      const callback = getEventCallback("workspace:deletion-progress");
      callback!(
        createDeletionProgress("/test/.worktrees/feature", {
          operations: [
            { id: "cleanup-vscode", label: "Cleanup VS Code", status: "done" },
            {
              id: "cleanup-workspace",
              label: "Cleanup workspace",
              status: "error",
              error: "Failed",
            },
          ],
          completed: true,
          hasErrors: true,
        })
      );

      // Deletion state should NOT be cleared (user needs to see error and retry/close anyway)
      expect(deletionStore.getDeletionStatus("/test/.worktrees/feature")).toBe("error");
    });

    it("calls workspaces.remove on retry", async () => {
      const projectWithWorkspace = {
        id: asProjectId("test-project-12345678"),
        path: "/test/project",
        name: "test-project",
        workspaces: [
          {
            projectId: asProjectId("test-project-12345678"),
            path: "/test/.worktrees/feature",
            name: "feature" as WorkspaceName,
            branch: "feature",
          },
        ],
      };
      mockApi.projects.list.mockResolvedValue([projectWithWorkspace]);

      render(MainView);

      await waitFor(() => {
        expect(getEventCallback("workspace:deletion-progress")).toBeDefined();
      });

      // Set active workspace
      projectsStore.setActiveWorkspace("/test/.worktrees/feature");

      // Simulate deletion with error
      const callback = getEventCallback("workspace:deletion-progress");
      callback!(
        createDeletionProgress("/test/.worktrees/feature", {
          operations: [
            { id: "cleanup-vscode", label: "Cleanup VS Code", status: "done" },
            {
              id: "cleanup-workspace",
              label: "Cleanup workspace",
              status: "error",
              error: "Failed",
            },
          ],
          completed: true,
          hasErrors: true,
        })
      );

      // Find and click Retry button
      await waitFor(() => {
        expect(screen.getByText("Retry")).toBeInTheDocument();
      });

      const retryButton = screen.getByText("Retry").closest("vscode-button");
      expect(retryButton).not.toBeNull();
      await fireEvent.click(retryButton!);

      // Should have called workspaces.remove with stored values
      await waitFor(() => {
        expect(mockApi.workspaces.remove).toHaveBeenCalledWith("test-project-12345678", "feature", {
          keepBranch: false, // from the stored progress
          skipSwitch: true, // retry keeps user on this workspace
          workspacePath: "/test/.worktrees/feature", // for retry/dismiss signaling
        });
      });
    });

    it("calls remove with force and clears state on dismiss", async () => {
      const projectWithWorkspace = {
        id: asProjectId("test-project-12345678"),
        path: "/test/project",
        name: "test-project",
        workspaces: [
          {
            projectId: asProjectId("test-project-12345678"),
            path: "/test/.worktrees/feature",
            name: "feature" as WorkspaceName,
            branch: "feature",
          },
        ],
      };
      mockApi.projects.list.mockResolvedValue([projectWithWorkspace]);

      render(MainView);

      await waitFor(() => {
        expect(getEventCallback("workspace:deletion-progress")).toBeDefined();
      });

      // Set active workspace
      projectsStore.setActiveWorkspace("/test/.worktrees/feature");

      // Simulate deletion with error
      const callback = getEventCallback("workspace:deletion-progress");
      callback!(
        createDeletionProgress("/test/.worktrees/feature", {
          operations: [
            { id: "cleanup-vscode", label: "Cleanup VS Code", status: "done" },
            {
              id: "cleanup-workspace",
              label: "Cleanup workspace",
              status: "error",
              error: "Failed",
            },
          ],
          completed: true,
          hasErrors: true,
        })
      );

      // Find and click Dismiss button
      await waitFor(() => {
        expect(screen.getByText("Dismiss")).toBeInTheDocument();
      });

      const dismissButton = screen.getByText("Dismiss").closest("vscode-button");
      expect(dismissButton).not.toBeNull();
      await fireEvent.click(dismissButton!);

      // remove with force should be called to close the workspace
      await waitFor(() => {
        expect(mockApi.workspaces.remove).toHaveBeenCalledWith("test-project-12345678", "feature", {
          force: true,
          workspacePath: "/test/.worktrees/feature", // for retry/dismiss signaling
        });
      });

      // State should be cleared
      await waitFor(() => {
        expect(deletionStore.getDeletionStatus("/test/.worktrees/feature")).toBe("none");
      });
    });
  });
});
