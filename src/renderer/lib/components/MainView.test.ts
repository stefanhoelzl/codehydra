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
  emitEvent: vi.fn(),
  // Flat API structure - projects namespace
  projects: {
    list: vi.fn().mockResolvedValue([]),
    open: vi.fn().mockResolvedValue({}),
    close: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(undefined),
  },
  // Flat API structure - workspaces namespace
  workspaces: {
    remove: vi.fn().mockResolvedValue({ started: true }),
    getStatus: vi
      .fn()
      .mockResolvedValue({ isDirty: false, unmergedCommits: 0, agent: { type: "none" } }),
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
  // on() captures callbacks by event name for tests to fire events
  on: vi.fn((event: string, callback: EventCallback) => {
    eventCallbacks.set(event, callback);
    return vi.fn(); // unsubscribe
  }),
  // Dialog event channel (panel dismiss-on-show)
  sendDialogEvent: vi.fn(),
}));

// Helper to get an event callback for firing events in tests
function getEventCallback(event: string): EventCallback | undefined {
  return eventCallbacks.get(event);
}

// Helper to clear event callbacks between tests
function clearEventCallbacks(): void {
  eventCallbacks.clear();
}

// Simulate the backend creation module's always-alive panel session: the
// "New workspace" panel renders only while a panel-surface dialog session
// exists AND the renderer's isOpen flag is set.
function openCreationPanelSession(dialogId = "dlg-creation-1"): void {
  dialogFrameworkStore.processCommand({
    action: "open",
    dialogId,
    config: {
      layout: "form",
      sections: [{ type: "text", content: "New workspace", style: "heading" }],
    },
    surface: "panel",
  });
}

// Mock the API module before any imports use it
vi.mock("$lib/api", () => mockApi);

// Mock AgentNotificationService for testing chime behavior
const { mockHandleStatusChange, MockAgentNotificationService } = vi.hoisted(() => {
  const mockHandleStatusChange = vi.fn();

  class MockAgentNotificationService {
    handleStatusChange = mockHandleStatusChange;
    removeWorkspace = vi.fn();
    reset = vi.fn();
  }

  return { mockHandleStatusChange, MockAgentNotificationService };
});

vi.mock("$lib/services/agent-notifications", () => ({
  AgentNotificationService: MockAgentNotificationService,
}));

// Import after mock setup
import MainView from "./MainView.svelte";
import * as projectsStore from "$lib/stores/projects.svelte.js";
import * as bootstrapStore from "$lib/stores/bootstrap.svelte.js";
import * as dialogsStore from "$lib/stores/dialogs.svelte.js";
import * as newWorkspaceViewStore from "$lib/stores/new-workspace-view.svelte.js";
import * as shortcutsStore from "$lib/stores/shortcuts.svelte.js";
import * as agentStatusStore from "$lib/stores/agent-status.svelte.js";
import * as lifecycleStore from "$lib/stores/workspace-lifecycle.svelte.js";
import * as dialogFrameworkStore from "$lib/stores/dialog-framework.svelte.js";
import type { DeletionProgress } from "@shared/api/types";

describe("MainView component", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset stores before each test
    projectsStore.reset();
    bootstrapStore.resetBootstrap();
    dialogsStore.reset();
    newWorkspaceViewStore.reset();
    shortcutsStore.reset();
    agentStatusStore.reset();
    lifecycleStore.reset();
    dialogFrameworkStore.reset();
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
      return { defaultAgent: null, availableAgents: [] };
    });
    // Agent statuses are fetched per-workspace via workspaces.getStatus (already mocked in mockApi)
    // Reset notification service mocks
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

    it("auto-opens the New workspace view (empty state) when no workspaces exist", async () => {
      openCreationPanelSession();
      render(MainView);

      // The New workspace view is the empty state: it auto-opens and replaces
      // the old logo backdrop.
      await waitFor(() => {
        expect(screen.getByRole("heading", { name: "New workspace" })).toBeInTheDocument();
      });

      // The show transition requests a fresh form from the backend session.
      expect(mockApi.sendDialogEvent).toHaveBeenCalledWith({
        kind: "dismiss",
        dialogId: "dlg-creation-1",
      });

      // The logo backdrop is superseded by the panel.
      expect(document.querySelector(".empty-backdrop")).not.toBeInTheDocument();
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
        expect(bootstrapStore.bootstrap.initialized).toBe(true);
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

    it("marks bootstrap initialized after successful projects.list", async () => {
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
        expect(bootstrapStore.bootstrap.initialized).toBe(true);
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
      dialogsStore.openCloseProjectDialog(asProjectId("test-project-12345678"));

      await waitFor(() => {
        expect(mockApi.ui.setMode).toHaveBeenCalledWith("dialog");
      });
    });

    it("calls setMode('workspace') when dialog closes", async () => {
      // Start with dialog open
      dialogsStore.openCloseProjectDialog(asProjectId("test-project-12345678"));

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
      dialogsStore.openCloseProjectDialog(asProjectId("test-project-12345678"));

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

    it("calls setMode('hover') when the New workspace view opens", async () => {
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

      await waitFor(() => {
        expect(projectsStore.activeWorkspacePath.value).toBe("/test/.worktrees/feature");
      });

      mockApi.ui.setMode.mockClear();

      // Opening the New workspace view keeps the UI on top at hover level
      // (so Alt+X still works), not at dialog level. It also clears the
      // active workspace — the panel IS the current tab, no workspace is
      // selected behind it.
      newWorkspaceViewStore.openNewWorkspaceView();

      expect(projectsStore.activeWorkspacePath.value).toBeNull();

      await waitFor(() => {
        expect(mockApi.ui.setMode).toHaveBeenCalledWith("hover");
      });
      expect(mockApi.ui.setMode).not.toHaveBeenCalledWith("dialog");
    });

    it("does not call setMode('dialog') for non-modal framework dialog", async () => {
      render(MainView);

      await waitFor(() => {
        expect(mockApi.projects.list).toHaveBeenCalled();
      });

      mockApi.ui.setMode.mockClear();

      // Open a non-modal framework dialog (e.g., loading workspace spinner)
      dialogFrameworkStore.processCommand({
        action: "open",
        dialogId: "dlg-loading",
        config: {
          sections: [
            {
              type: "progress",
              items: [{ id: "loading", label: "Loading workspace...", status: "running" as const }],
              style: "spinner",
            },
          ],
        },
      });

      // Give effects time to run
      await waitFor(() => {
        expect(mockApi.ui.setMode).not.toHaveBeenCalledWith("dialog");
      });
    });

    it("calls setMode('dialog') for modal framework dialog", async () => {
      render(MainView);

      await waitFor(() => {
        expect(mockApi.projects.list).toHaveBeenCalled();
      });

      mockApi.ui.setMode.mockClear();

      // Open a modal framework dialog (e.g., agent selection)
      dialogFrameworkStore.processCommand({
        action: "open",
        dialogId: "dlg-modal",
        config: {
          sections: [
            { type: "text", content: "Choose Agent", style: "heading" },
            {
              type: "group",
              items: [{ type: "button", id: "select", label: "Continue", variant: "primary" }],
            },
          ],
          modal: true,
        },
      });

      await waitFor(() => {
        expect(mockApi.ui.setMode).toHaveBeenCalledWith("dialog");
      });
    });
  });

  describe("dialogs", () => {
    it("renders the creation panel (PanelView) when the New workspace view is open", async () => {
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
      openCreationPanelSession();

      render(MainView);

      // Wait for mount
      await waitFor(() => {
        expect(mockApi.projects.list).toHaveBeenCalled();
      });

      // Open the New workspace view (panel, not a modal dialog)
      newWorkspaceViewStore.openNewWorkspaceView();

      await waitFor(() => {
        expect(screen.getByRole("heading", { name: "New workspace" })).toBeInTheDocument();
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

  describe("auto-open New workspace view (empty state)", () => {
    it("auto-opens the New workspace view on mount when projects array is empty", async () => {
      mockApi.projects.list.mockResolvedValue([]);
      openCreationPanelSession();

      render(MainView);

      // Wait for the New workspace view to auto-open
      await waitFor(() => {
        expect(screen.getByRole("heading", { name: "New workspace" })).toBeInTheDocument();
      });

      // Verify projects.open was NOT automatically called (no folder picker)
      expect(mockApi.projects.open).not.toHaveBeenCalled();
    });

    it("auto-opens the New workspace view when projects exist but no workspaces", async () => {
      const existingProject = {
        id: asProjectId("test-project-12345678"),
        path: "/test/project",
        name: "test-project",
        workspaces: [],
      };
      mockApi.projects.list.mockResolvedValue([existingProject]);
      openCreationPanelSession();

      render(MainView);

      // Wait for the New workspace view to auto-open
      await waitFor(() => {
        expect(screen.getByRole("heading", { name: "New workspace" })).toBeInTheDocument();
      });

      // Verify projects.open was NOT automatically called (no folder picker)
      expect(mockApi.projects.open).not.toHaveBeenCalled();
    });
  });

  describe("auto-open New workspace view on project:opened", () => {
    it("does NOT auto-open the view when a project without workspaces opens (e.g. background clone)", async () => {
      // Start with one project so the empty-state auto-open doesn't trigger
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

      // Simulate a background clone completing: a project with no workspaces
      // appears — it must land silently, not hijack the screen.
      const emptyProject = {
        id: asProjectId("empty-project-12345678"),
        path: "/test/empty-project",
        name: "empty-project",
        workspaces: [],
      };
      const callback = getEventCallback("project:opened");
      callback!({ project: emptyProject });

      // Give any (unwanted) auto-open time to trigger.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(newWorkspaceViewStore.newWorkspaceView.isOpen).toBe(false);
    });

    it("does NOT auto-open the view when project has workspaces", async () => {
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

      // Give time for any auto-open to trigger (under the 100ms empty-state debounce)
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(newWorkspaceViewStore.newWorkspaceView.isOpen).toBe(false);
    });

    it("does NOT auto-open the view when another dialog is already open", async () => {
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

    it("handles rapid project:opened events (no view opens, projects appear)", async () => {
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
      // Fire both events rapidly — both land silently, projects just appear.
      callback!({ project: emptyProject1 });
      callback!({ project: emptyProject2 });

      await waitFor(() => {
        expect(projectsStore.projects.value).toHaveLength(3);
      });
      expect(newWorkspaceViewStore.newWorkspaceView.isOpen).toBe(false);
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

    // NOTE: "shows DeletionProgressView when active workspace is deleting" test removed —
    // DeletionProgressView rendering is now handled by DialogHost via the dialog framework

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
      expect(lifecycleStore.getLifecycle("/test/.worktrees/feature")).not.toBe("none");

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
      expect(lifecycleStore.getLifecycle("/test/.worktrees/feature")).toBe("none");
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
      expect(lifecycleStore.getLifecycle("/test/.worktrees/feature")).toBe("delete-failed");
    });

    // NOTE: "calls workspaces.remove on retry" and "calls remove with force and clears state
    // on dismiss" tests removed — retry/dismiss handling is now in deletion-dialog-module
    // on the main process side, not in MainView
  });

  describe("auto-open New workspace view during last workspace deletion", () => {
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

    it("auto-opens the New workspace view when last workspace deletion is in progress", async () => {
      // Start with one workspace
      const project = createMockProject({
        id: asProjectId("test-project-12345678"),
        workspaces: [
          {
            projectId: asProjectId("test-project-12345678"),
            path: "/test/.worktrees/feature",
            name: "feature" as WorkspaceName,
            branch: "feature",
          },
        ],
      });
      mockApi.projects.list.mockResolvedValue([project]);
      mockApi.ui.getActiveWorkspace.mockResolvedValue(null);

      render(MainView);

      await waitFor(() => {
        expect(getEventCallback("workspace:deletion-progress")).toBeDefined();
      });

      // View should NOT be open yet (workspace exists)
      expect(newWorkspaceViewStore.newWorkspaceView.isOpen).toBe(false);

      // Simulate deletion-progress event (not completed — deletion just started)
      const callback = getEventCallback("workspace:deletion-progress");
      callback!(createDeletionProgress("/test/.worktrees/feature"));

      // New workspace view should auto-open (effective count drops to 0)
      await waitFor(() => {
        expect(newWorkspaceViewStore.newWorkspaceView.isOpen).toBe(true);
      });
    });

    it("does NOT auto-open when non-last workspace is being deleted", async () => {
      // Start with two workspaces
      const project = createMockProject({
        id: asProjectId("test-project-12345678"),
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
      });
      mockApi.projects.list.mockResolvedValue([project]);
      mockApi.ui.getActiveWorkspace.mockResolvedValue(null);

      render(MainView);

      await waitFor(() => {
        expect(getEventCallback("workspace:deletion-progress")).toBeDefined();
      });

      // Simulate deletion of one workspace (effective count goes to 1, not 0)
      const callback = getEventCallback("workspace:deletion-progress");
      callback!(createDeletionProgress("/test/.worktrees/feature"));

      // Give time for any auto-open to trigger
      await new Promise((resolve) => setTimeout(resolve, 150));

      // View should NOT open (one effective workspace remains)
      expect(newWorkspaceViewStore.newWorkspaceView.isOpen).toBe(false);
    });

    it("does NOT auto-close the New workspace view when deletion fails", async () => {
      // Start with one workspace
      const project = createMockProject({
        id: asProjectId("test-project-12345678"),
        workspaces: [
          {
            projectId: asProjectId("test-project-12345678"),
            path: "/test/.worktrees/feature",
            name: "feature" as WorkspaceName,
            branch: "feature",
          },
        ],
      });
      mockApi.projects.list.mockResolvedValue([project]);
      mockApi.ui.getActiveWorkspace.mockResolvedValue(null);

      render(MainView);

      await waitFor(() => {
        expect(getEventCallback("workspace:deletion-progress")).toBeDefined();
      });

      // Simulate deletion starting (effective count drops to 0 → dialog opens)
      const callback = getEventCallback("workspace:deletion-progress");
      callback!(createDeletionProgress("/test/.worktrees/feature"));

      await waitFor(() => {
        expect(newWorkspaceViewStore.newWorkspaceView.isOpen).toBe(true);
      });

      // Simulate deletion failure (completed with errors)
      callback!(
        createDeletionProgress("/test/.worktrees/feature", {
          completed: true,
          hasErrors: true,
          operations: [
            {
              id: "cleanup-workspace",
              label: "Removing workspace",
              status: "error",
              error: "Failed",
            },
          ],
        })
      );

      // Give time for any close to trigger
      await new Promise((resolve) => setTimeout(resolve, 150));

      // View should remain open — deletion failure should not close it
      expect(newWorkspaceViewStore.newWorkspaceView.isOpen).toBe(true);
    });
  });

  describe("New workspace view stays open when a workspace appears", () => {
    it("does NOT close the New workspace view when a workspace appears (create stays open)", async () => {
      // Start with no workspaces — the New workspace view auto-opens (empty state)
      const project = createMockProject({
        id: asProjectId("test-project-12345678"),
        workspaces: [],
      });
      mockApi.projects.list.mockResolvedValue([project]);

      render(MainView);

      // Wait for the New workspace view to auto-open
      await waitFor(() => {
        expect(newWorkspaceViewStore.newWorkspaceView.isOpen).toBe(true);
      });

      // Simulate a workspace appearing (background create — does NOT switch).
      projectsStore.addWorkspace("/test/project", {
        projectId: asProjectId("test-project-12345678"),
        path: "/test/.worktrees/new-ws",
        name: "new-ws" as WorkspaceName,
        branch: "new-ws",
        metadata: {},
      });

      // Give time for any close to (not) trigger
      await new Promise((resolve) => setTimeout(resolve, 50));

      // The view stays open so the user can fire off another workspace.
      expect(newWorkspaceViewStore.newWorkspaceView.isOpen).toBe(true);
    });

    it("closes the New workspace view when navigating to a workspace (sidebar click)", async () => {
      const project = createMockProject({
        id: asProjectId("test-project-12345678"),
        workspaces: [
          {
            projectId: asProjectId("test-project-12345678"),
            path: "/test/.worktrees/existing",
            name: "existing" as WorkspaceName,
            branch: "existing",
          },
        ],
      });
      mockApi.projects.list.mockResolvedValue([project]);

      render(MainView);

      await waitFor(() => {
        expect(screen.getByText("existing")).toBeInTheDocument();
      });

      // Open the New workspace view over the workspace.
      newWorkspaceViewStore.openNewWorkspaceView();
      await waitFor(() => {
        expect(newWorkspaceViewStore.newWorkspaceView.isOpen).toBe(true);
      });

      // Clicking a workspace navigates to it and closes the view.
      await fireEvent.click(screen.getByText("existing"));

      await waitFor(() => {
        expect(newWorkspaceViewStore.newWorkspaceView.isOpen).toBe(false);
      });
    });

    it("does NOT close other dialogs when a workspace appears", async () => {
      const project = createMockProject({
        id: asProjectId("test-project-12345678"),
        workspaces: [],
      });
      mockApi.projects.list.mockResolvedValue([project]);

      render(MainView);

      // Wait for loading to complete
      await waitFor(() => {
        expect(bootstrapStore.bootstrap.initialized).toBe(true);
      });

      // Open a remove dialog
      dialogsStore.openRemoveDialog(
        asWorkspaceRef("test-project-12345678", "feature", "/test/.worktrees/feature")
      );

      expect(dialogsStore.dialogState.value.type).toBe("remove");

      // Simulate a workspace appearing
      projectsStore.addWorkspace("/test/project", {
        projectId: asProjectId("test-project-12345678"),
        path: "/test/.worktrees/new-ws",
        name: "new-ws" as WorkspaceName,
        branch: "new-ws",
        metadata: {},
      });

      // Give time for any close to trigger
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Remove dialog should still be open
      expect(dialogsStore.dialogState.value.type).toBe("remove");
    });
  });
});
