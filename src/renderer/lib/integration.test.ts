/**
 * Integration tests for the UI layer.
 * Tests complete user flows from interaction through IPC events to UI updates.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/svelte";
import type { Project, Workspace, ProjectId, WorkspaceName } from "@shared/api/types";

// API event callbacks - MainView uses api.on() which stores callbacks here
type EventCallback = (...args: unknown[]) => void;
const eventCallbacks = new Map<string, EventCallback>();

// Helper to fire an API event
function fireApiEvent(event: string, payload?: unknown): void {
  const callback = eventCallbacks.get(event);
  if (callback) {
    callback(payload);
  }
}

// Helper to clear event callbacks between tests
function clearEventCallbacks(): void {
  eventCallbacks.clear();
}

/**
 * Trigger the main view to show.
 * With the new passive renderer flow, App starts in "initializing" mode and waits
 * for the main process to send "lifecycle:show-main-view" event before rendering MainView.
 * Call this after render() to simulate the main process completing startup.
 */
function showMainView(): void {
  fireApiEvent("lifecycle:show-main-view");
}

const mockApi = vi.hoisted(() => ({
  // Normal API (flat structure)
  workspaces: {
    create: vi.fn().mockResolvedValue({}),
    remove: vi.fn().mockResolvedValue({ branchDeleted: true }),
    getStatus: vi
      .fn()
      .mockResolvedValue({ isDirty: false, unmergedCommits: 0, agent: { type: "none" } }),
    get: vi.fn().mockResolvedValue(undefined),
  },
  projects: {
    list: vi.fn().mockResolvedValue([]),
    open: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(undefined),
  },
  ui: {
    getActiveWorkspace: vi.fn().mockResolvedValue(null),
    switchWorkspace: vi.fn().mockResolvedValue(undefined),
    setMode: vi.fn().mockResolvedValue(undefined),
  },
  // Note: lifecycle.getState, lifecycle.setup, lifecycle.startServices, lifecycle.setAgent
  // have been removed - setup is now handled via app:setup intent in main process.
  // Renderer is passive and waits for lifecycle:show-main-view IPC event.
  lifecycle: {
    ready: vi.fn().mockResolvedValue(undefined),
    quit: vi.fn().mockResolvedValue(undefined),
  },
  sendAgentSelected: vi.fn(),
  // Dialog event channel (panel form actions + dismiss-on-show)
  sendDialogEvent: vi.fn(),
  // on() captures callbacks by event name for tests to fire events
  on: vi.fn((event: string, callback: EventCallback) => {
    eventCallbacks.set(event, callback);
    return vi.fn(); // unsubscribe
  }),
  // onModeChange captures callback for ui:mode-changed events
  onModeChange: vi.fn((callback: EventCallback) => {
    eventCallbacks.set("ui:mode-changed", callback);
    return vi.fn(); // unsubscribe
  }),
  // onShortcut captures callback for shortcut key events from main process
  onShortcut: vi.fn((callback: EventCallback) => {
    eventCallbacks.set("shortcut:key", callback);
    return vi.fn(); // unsubscribe
  }),
  // Legacy APIs (kept for backwards compatibility with some old tests)
  listBases: vi.fn().mockResolvedValue([]),
}));

// Mock the API module
vi.mock("$lib/api", () => mockApi);

// Mock ui-mode store with mutable state for tests
// State starts with "dialog" mode to keep sidebar expanded for UI interactions
// Note: This means desiredMode starts as "dialog", but dialog tests verify setDialogOpen calls
const mockUiModeState = vi.hoisted(() => ({
  _modeFromMain: "dialog" as "workspace" | "shortcut" | "dialog",
  _dialogOpen: false,
  _sidebarExpanded: false,
  _lastEmittedMode: null as "workspace" | "shortcut" | "dialog" | null,
}));

// Helper to compute desired mode (used by both getter and syncMode)
function computeDesiredModeFromState(): "workspace" | "shortcut" | "dialog" {
  if (mockUiModeState._modeFromMain === "shortcut") return "shortcut";
  if (
    mockUiModeState._modeFromMain === "dialog" ||
    mockUiModeState._dialogOpen ||
    mockUiModeState._sidebarExpanded
  )
    return "dialog";
  return "workspace";
}

const mockUiModeStore = vi.hoisted(() => ({
  uiMode: {
    get value() {
      return mockUiModeState._modeFromMain;
    },
  },
  shortcutModeActive: {
    get value() {
      return mockUiModeState._modeFromMain === "shortcut";
    },
  },
  desiredMode: {
    get value() {
      return computeDesiredModeFromState();
    },
  },
  setModeFromMain: vi.fn((mode: "workspace" | "shortcut" | "dialog") => {
    mockUiModeState._modeFromMain = mode;
  }),
  setDialogOpen: vi.fn((open: boolean) => {
    mockUiModeState._dialogOpen = open;
  }),
  setSidebarExpanded: vi.fn((expanded: boolean) => {
    mockUiModeState._sidebarExpanded = expanded;
  }),
  setNewWorkspaceViewOpen: vi.fn((open: boolean) => {
    mockUiModeState._sidebarExpanded = open || mockUiModeState._sidebarExpanded;
  }),
  // syncMode calls api.ui.setMode with deduplication (mimics real store behavior)
  syncMode: vi.fn(() => {
    const desired = computeDesiredModeFromState();
    if (desired !== mockUiModeState._lastEmittedMode) {
      mockUiModeState._lastEmittedMode = desired;
      void mockApi.ui.setMode(desired);
    }
  }),
  computeDesiredMode: vi.fn(
    (modeFromMain: string, dialogOpen: boolean, sidebarExpanded: boolean) => {
      if (modeFromMain === "shortcut") return "shortcut";
      if (dialogOpen || sidebarExpanded) return "dialog";
      return "workspace";
    }
  ),
  reset: vi.fn(() => {
    mockUiModeState._modeFromMain = "dialog"; // Keep sidebar expanded for most tests
    mockUiModeState._dialogOpen = false;
    mockUiModeState._sidebarExpanded = false;
    mockUiModeState._lastEmittedMode = null;
  }),
}));

vi.mock("$lib/stores/ui-mode.svelte", () => mockUiModeStore);

// Import after mock setup
import App from "../App.svelte";
import * as projectsStore from "$lib/stores/projects.svelte.js";
import * as bootstrapStore from "$lib/stores/bootstrap.svelte.js";
import * as dialogsStore from "$lib/stores/dialogs.svelte.js";
import * as shortcutsStore from "$lib/stores/shortcuts.svelte.js";
import * as newWorkspaceViewStore from "$lib/stores/new-workspace-view.svelte.js";
import * as uiModeStore from "$lib/stores/ui-mode.svelte.js";
import * as agentStatusStore from "$lib/stores/agent-status.svelte.js";
import * as dialogFrameworkStore from "$lib/stores/dialog-framework.svelte.js";

// Simulate the backend creation module's always-alive panel session with a
// representative creation-form config: heading, project row (with the
// folder-open / clone side-flow buttons), name and base dropdowns. The "New
// workspace" panel renders only while this session exists AND the renderer's
// isOpen flag is set; form actions go to the backend via sendDialogEvent.
function openCreationPanelSession(dialogId = "dlg-creation-1"): void {
  dialogFrameworkStore.processCommand({
    action: "open",
    dialogId,
    surface: "panel",
    config: {
      layout: "form",
      sections: [
        { type: "text", content: "New workspace", style: "heading" },
        {
          type: "group",
          label: "Project",
          items: [
            { type: "dropdown", id: "project", suggestions: [] },
            {
              type: "button",
              id: "open-folder",
              icon: "folder-opened",
              title: "Open project folder",
            },
            { type: "button", id: "clone", icon: "source-control", title: "Clone from Git" },
          ],
        },
        { type: "dropdown", id: "name", label: "Name", freeText: true, suggestions: [] },
        { type: "dropdown", id: "base", label: "Base Branch", suggestions: [] },
      ],
    },
  });
}

// Helper to create mock workspace (v2 API format)
function createWorkspace(name: string, projectPath: string, projectId?: string): Workspace {
  return {
    projectId: (projectId ?? "test-12345678") as ProjectId,
    name: name as WorkspaceName,
    path: `${projectPath}/.worktrees/${name}`,
    branch: name,
    metadata: { base: "main" },
  };
}

// Helper to generate consistent project ID from name
function projectIdFromName(name: string): ProjectId {
  // Simple hash for deterministic IDs in tests
  return `${name}-12345678` as ProjectId;
}

// Helper to create mock project (v2 API format with ID)
function createProject(name: string, workspaces: Workspace[] = []): Project {
  const id = projectIdFromName(name);
  return {
    id,
    path: `/test/${name}`,
    name,
    // Add projectId to each workspace for v2 format
    workspaces: workspaces.map((ws) => ({ ...ws, projectId: id })),
  };
}

describe("Integration tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projectsStore.reset();
    dialogFrameworkStore.reset();
    bootstrapStore.resetBootstrap();
    dialogsStore.reset();
    shortcutsStore.reset();
    newWorkspaceViewStore.reset();
    agentStatusStore.reset();
    // Reset ui-mode store state (the mock's reset function updates the mutable state)
    mockUiModeStore.reset();

    // Reset v2 event callbacks
    clearEventCallbacks();

    // Default mocks for v2 API
    mockApi.projects.list.mockResolvedValue([]);
    mockApi.ui.getActiveWorkspace.mockResolvedValue(null);
    mockApi.workspaces.getStatus.mockResolvedValue({
      isDirty: false,
      agent: { type: "none" },
    });
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
    // Legacy mocks that may still be used in some places
    mockApi.listBases.mockResolvedValue([
      { name: "main", isRemote: false },
      { name: "develop", isRemote: false },
    ]);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  describe("happy paths", () => {
    it("open project: folder icon in Create Workspace dialog → projects.open() → project:opened event → UI shows project in sidebar", async () => {
      // Start with an existing project to avoid auto-open picker
      const existingProject = createProject("existing", [
        createWorkspace("main", "/test/existing"),
      ]);
      mockApi.projects.list.mockResolvedValue([existingProject]);

      const projectPath = "/test/my-project";
      const newProject = createProject("my-project", [createWorkspace("main", projectPath)]);
      openCreationPanelSession();

      render(App);
      showMainView();

      // Wait for initial load
      await waitFor(() => {
        expect(screen.getByText("existing")).toBeInTheDocument();
      });

      // Open Create Workspace dialog via the + button
      const addButton = screen.getByRole("button", { name: /new workspace/i });
      await fireEvent.click(addButton);

      await waitFor(() => {
        expect(screen.getByRole("heading", { name: "New workspace" })).toBeInTheDocument();
      });

      // Click the folder icon: the form sends the action to the backend
      // creation module, which drives the native picker (project:open intent).
      const folderButton = screen.getByRole("button", { name: /open project folder/i });
      await fireEvent.click(folderButton);

      await waitFor(() => {
        expect(mockApi.sendDialogEvent).toHaveBeenCalledWith(
          expect.objectContaining({ actionId: "open-folder", dialogId: "dlg-creation-1" })
        );
      });

      // Simulate the backend completing the open: project:opened event
      fireApiEvent("project:opened", { project: newProject });

      // Verify new project appears in sidebar
      await waitFor(() => {
        expect(screen.getByText("my-project")).toBeInTheDocument();
      });
    });

    it("close project: click [×] → dialog opens → confirm → closeProject → project:closed event → project removed from sidebar", async () => {
      // Projects always show dialog before closing (user confirms they want to stop tracking)
      const project = createProject("my-project", []);
      mockApi.projects.list.mockResolvedValue([project]);
      openCreationPanelSession();

      render(App);
      showMainView();

      // Wait for project to appear
      await waitFor(() => {
        expect(screen.getByText("my-project")).toBeInTheDocument();
      });

      // Get actual projectId from store (ID is regenerated from path)
      const actualProjectId = projectsStore.projects.value[0]!.id;

      // Verify close button exists and click it
      const closeButton = screen.getByLabelText(/close project/i);
      expect(closeButton).toBeInTheDocument();
      await fireEvent.click(closeButton);

      // Click the close button
      await fireEvent.click(closeButton);

      // Verify dialog opens (projects always show confirmation dialog)
      const dialog = await waitFor(() => {
        const d = screen.getByRole("dialog");
        expect(d).toBeInTheDocument();
        expect(screen.getByRole("heading", { name: /close project/i })).toBeInTheDocument();
        return d;
      });

      // Confirm the close dialog - use within() to scope to dialog
      const confirmButton = within(dialog).getByRole("button", { name: /close project/i });
      await fireEvent.click(confirmButton);

      // Verify closeProject was called with project path
      await waitFor(() => {
        expect(mockApi.projects.close).toHaveBeenCalledWith(project.path, undefined);
      });

      // Simulate project:closed event (v2 format uses projectId not path)
      fireApiEvent("project:closed", { projectId: actualProjectId });

      // Verify project is removed from sidebar and the New workspace view (empty state) appears
      await waitFor(() => {
        expect(screen.queryByText("my-project")).not.toBeInTheDocument();
        expect(screen.getByRole("heading", { name: "New workspace" })).toBeInTheDocument();
      });
    });

    it("create workspace: click [+] → dialog opens → dialog receives workspace:created event → new workspace in sidebar", async () => {
      // This test focuses on the dialog opening and event handling
      // BranchDropdown interaction is tested separately in BranchDropdown.test.ts
      const project = createProject("my-project", [createWorkspace("main", "/test/my-project")]);
      mockApi.projects.list.mockResolvedValue([project]);
      openCreationPanelSession();

      render(App);
      showMainView();

      // Wait for project to appear
      await waitFor(() => {
        expect(screen.getByText("my-project")).toBeInTheDocument();
      });

      // Click add workspace button
      const addButton = screen.getByRole("button", { name: /new workspace/i });
      await fireEvent.click(addButton);

      // Verify the New workspace view opens
      await waitFor(() => {
        expect(screen.getByRole("heading", { name: "New workspace" })).toBeInTheDocument();
      });

      // Should have 3 comboboxes: project dropdown, name dropdown, and branch dropdown
      expect(screen.getAllByRole("combobox")).toHaveLength(3);

      // Simulate workspace:created event (v2 format uses projectId)
      // Get actual projectId from store (ID is regenerated from path)
      const actualProjectId = projectsStore.projects.value[0]!.id;
      const newWorkspace = createWorkspace("feature-x", "/test/my-project", actualProjectId);
      fireApiEvent("workspace:created", {
        projectId: actualProjectId,
        workspace: newWorkspace,
      });

      // Verify new workspace appears in sidebar
      await waitFor(() => {
        expect(screen.getByText("feature-x")).toBeInTheDocument();
      });
    });

    it("remove workspace: click [×] → dialog opens → confirm → workspace:removed event → workspace removed from sidebar", async () => {
      const workspace = createWorkspace("feature-x", "/test/my-project");
      const project = createProject("my-project", [workspace]);
      mockApi.projects.list.mockResolvedValue([project]);

      render(App);
      showMainView();

      // Wait for workspace to appear
      await waitFor(() => {
        expect(screen.getByText("feature-x")).toBeInTheDocument();
      });

      // Get actual projectId from store (ID is regenerated from path)
      const actualProjectId = projectsStore.projects.value[0]!.id;

      // Click remove workspace button (use getByRole to target the button specifically)
      const removeButton = screen.getByRole("button", { name: /remove workspace/i });
      await fireEvent.click(removeButton);

      // Verify dialog opens
      await waitFor(() => {
        expect(screen.getByRole("dialog")).toBeInTheDocument();
        expect(screen.getByText("Remove Workspace")).toBeInTheDocument();
      });

      // Confirm removal - use the dialog's Remove button (vscode-button web component)
      mockApi.workspaces.remove.mockResolvedValue({ branchDeleted: true });
      const dialog = screen.getByRole("dialog");
      const removeConfirmButton = Array.from(dialog.querySelectorAll("vscode-button")).find(
        (btn) => btn.textContent?.trim() === "Remove"
      ) as HTMLElement;
      await fireEvent.click(removeConfirmButton);

      // Verify workspaces.remove was called with workspace path and options
      await waitFor(() => {
        expect(mockApi.workspaces.remove).toHaveBeenCalledWith(
          workspace.path, // workspacePath
          { keepBranch: false, ignoreWarnings: true } // keepBranch (default is unchecked, so keepBranch=false)
        );
      });

      // Simulate workspace:removed event (v2 format uses WorkspaceRef)
      fireApiEvent("workspace:removed", {
        projectId: actualProjectId,
        workspaceName: workspace.name,
        path: workspace.path,
      });

      // Verify dialog closes and workspace is removed
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(screen.queryByText("feature-x")).not.toBeInTheDocument();
      });
    });

    it("switch workspace: click workspace → workspace:switched event → aria-current updates", async () => {
      const ws1 = createWorkspace("main", "/test/my-project");
      const ws2 = createWorkspace("feature-x", "/test/my-project");
      const project = createProject("my-project", [ws1, ws2]);
      mockApi.projects.list.mockResolvedValue([project]);

      render(App);
      showMainView();

      // Wait for workspaces to appear
      await waitFor(() => {
        expect(screen.getByText("main")).toBeInTheDocument();
        expect(screen.getByText("feature-x")).toBeInTheDocument();
      });

      // Get actual projectId from store (ID is regenerated from path)
      const actualProjectId = projectsStore.projects.value[0]!.id;

      // Click on feature-x workspace
      const featureButton = screen.getByRole("button", { name: "feature-x" });
      await fireEvent.click(featureButton);

      // Verify switchWorkspace was called with workspacePath
      // Note: focus parameter is optional, MainView doesn't pass it (defaults to true)
      await waitFor(() => {
        expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith(ws2.path);
      });

      // Simulate workspace:switched event (v2 format uses WorkspaceRef)
      fireApiEvent("workspace:switched", {
        projectId: actualProjectId,
        workspaceName: ws2.name,
        path: ws2.path,
      });

      // Verify aria-current updates
      await waitFor(() => {
        const featureItem = screen.getByText("feature-x").closest("li");
        expect(featureItem).toHaveAttribute("aria-current", "true");
      });
    });
  });

  describe("error paths", () => {
    it("projects.open returns null (user cancelled) → no action taken", async () => {
      // Start with an existing project to avoid auto-open picker
      const existingProject = createProject("existing", [
        createWorkspace("main", "/test/existing"),
      ]);
      mockApi.projects.list.mockResolvedValue([existingProject]);
      openCreationPanelSession();

      render(App);
      showMainView();

      await waitFor(() => {
        expect(screen.getByText("existing")).toBeInTheDocument();
      });

      // Open Create Workspace dialog via the + button
      const addButton = screen.getByRole("button", { name: /new workspace/i });
      await fireEvent.click(addButton);

      await waitFor(() => {
        expect(screen.getByRole("heading", { name: "New workspace" })).toBeInTheDocument();
      });

      // Click the folder icon: the action goes to the backend, which handles
      // the cancelled picker itself (no project:opened event follows).
      const folderButton = screen.getByRole("button", { name: /open project folder/i });
      await fireEvent.click(folderButton);

      await waitFor(() => {
        expect(mockApi.sendDialogEvent).toHaveBeenCalledWith(
          expect.objectContaining({ actionId: "open-folder" })
        );
      });

      // Existing project should still be shown
      expect(screen.getByText("existing")).toBeInTheDocument();
    });

    it("createWorkspace API error handling is owned by the backend creation module", async () => {
      // Validation and creation errors are handled in the main-process
      // creation module (see creation-module.integration.test.ts). This
      // integration test verifies the panel opens with the form context.
      const project = createProject("my-project", [createWorkspace("main", "/test/my-project")]);
      mockApi.projects.list.mockResolvedValue([project]);
      openCreationPanelSession();

      render(App);
      showMainView();

      await waitFor(() => {
        expect(screen.getByText("my-project")).toBeInTheDocument();
      });

      // Open dialog
      const addButton = screen.getByRole("button", { name: /new workspace/i });
      await fireEvent.click(addButton);

      await waitFor(() => {
        expect(screen.getByRole("heading", { name: "New workspace" })).toBeInTheDocument();
      });

      // Should have 3 comboboxes: project dropdown, name dropdown, and branch dropdown
      expect(screen.getAllByRole("combobox")).toHaveLength(3);
    });

    it("removeWorkspace uses fire-and-forget pattern → dialog closes immediately", async () => {
      // Note: RemoveWorkspaceDialog uses fire-and-forget pattern.
      // The dialog closes immediately after clicking Remove, and any errors
      // are shown via DeletionProgressView (tested in DeletionProgressView.test.ts).
      const workspace = createWorkspace("feature-x", "/test/my-project");
      const project = createProject("my-project", [workspace]);
      mockApi.projects.list.mockResolvedValue([project]);

      render(App);
      showMainView();

      await waitFor(() => {
        expect(screen.getByText("feature-x")).toBeInTheDocument();
      });

      // Open dialog (use getByRole to target the button specifically)
      const removeButton = screen.getByRole("button", { name: /remove workspace/i });
      await fireEvent.click(removeButton);

      await waitFor(() => {
        expect(screen.getByRole("dialog")).toBeInTheDocument();
      });

      // Use the dialog's Remove button (vscode-button web component)
      const dialog = screen.getByRole("dialog");
      const removeConfirmButton = Array.from(dialog.querySelectorAll("vscode-button")).find(
        (btn) => btn.textContent?.trim() === "Remove"
      ) as HTMLElement;
      await fireEvent.click(removeConfirmButton);

      // Dialog closes immediately (fire-and-forget pattern)
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      });

      // API was called
      expect(mockApi.workspaces.remove).toHaveBeenCalledWith(
        workspace.path, // workspacePath
        { keepBranch: false, ignoreWarnings: true } // keepBranch default, ignoreWarnings default
      );
    });
  });

  describe("New workspace view z-order integration", () => {
    // Note: These tests verify that MainView notifies the ui-mode store when the
    // New workspace view opens/closes. The panel keeps the UI on top at hover
    // level (so Alt+X still works), so it goes through setNewWorkspaceViewOpen,
    // not setDialogOpen.

    it("notifies ui-mode store when the New workspace view opens", async () => {
      const project = createProject("my-project", [createWorkspace("main", "/test/my-project")]);
      mockApi.projects.list.mockResolvedValue([project]);
      openCreationPanelSession();

      render(App);
      showMainView();

      await waitFor(() => {
        expect(screen.getByText("my-project")).toBeInTheDocument();
      });

      mockUiModeStore.setNewWorkspaceViewOpen.mockClear();

      // Open the New workspace view
      const newWorkspaceButton = screen.getByRole("button", { name: /new workspace/i });
      await fireEvent.click(newWorkspaceButton);

      await waitFor(() => {
        expect(screen.getByRole("heading", { name: "New workspace" })).toBeInTheDocument();
      });

      expect(mockUiModeStore.setNewWorkspaceViewOpen).toHaveBeenCalledWith(true);
      // It is NOT a modal dialog.
      expect(mockUiModeStore.setDialogOpen).not.toHaveBeenCalledWith(true);
    });

    it("notifies ui-mode store when leaving the view by switching workspace", async () => {
      const workspace = createWorkspace("main", "/test/my-project");
      const project = createProject("my-project", [workspace]);
      mockApi.projects.list.mockResolvedValue([project]);
      openCreationPanelSession();

      render(App);
      showMainView();

      await waitFor(() => {
        expect(screen.getByText("my-project")).toBeInTheDocument();
      });

      // Open the New workspace view
      const newWorkspaceButton = screen.getByRole("button", { name: /new workspace/i });
      await fireEvent.click(newWorkspaceButton);

      await waitFor(() => {
        expect(screen.getByRole("heading", { name: "New workspace" })).toBeInTheDocument();
      });

      mockUiModeStore.setNewWorkspaceViewOpen.mockClear();

      // Leave by clicking a workspace
      await fireEvent.click(screen.getByText("main"));

      await waitFor(() => {
        expect(screen.queryByRole("heading", { name: "New workspace" })).not.toBeInTheDocument();
      });

      expect(mockUiModeStore.setNewWorkspaceViewOpen).toHaveBeenCalledWith(false);
    });

    it("handles api.setMode failure gracefully", async () => {
      const project = createProject("my-project", [createWorkspace("main", "/test/my-project")]);
      mockApi.projects.list.mockResolvedValue([project]);
      mockApi.ui.setMode.mockRejectedValue(new Error("IPC failed"));
      openCreationPanelSession();

      render(App);
      showMainView();

      await waitFor(() => {
        expect(screen.getByText("my-project")).toBeInTheDocument();
      });

      // Open the view - should not throw
      const newWorkspaceButton = screen.getByRole("button", { name: /new workspace/i });
      await fireEvent.click(newWorkspaceButton);

      // View should still open in UI despite API failure
      await waitFor(() => {
        expect(screen.getByRole("heading", { name: "New workspace" })).toBeInTheDocument();
      });
    });
  });

  describe("state consistency", () => {
    it("projects store matches sidebar display at all times", async () => {
      const project = createProject("my-project", [
        createWorkspace("main", "/test/my-project"),
        createWorkspace("feature-x", "/test/my-project"),
      ]);
      mockApi.projects.list.mockResolvedValue([project]);

      render(App);
      showMainView();

      // Wait for load
      await waitFor(() => {
        expect(bootstrapStore.bootstrap.initialized).toBe(true);
      });

      // Verify store and UI match
      expect(projectsStore.projects.value).toHaveLength(1);
      expect(screen.getByText("my-project")).toBeInTheDocument();
      expect(screen.getByText("main")).toBeInTheDocument();
      expect(screen.getByText("feature-x")).toBeInTheDocument();

      // Add another project via event (v2 format includes id)
      const newProject = createProject("new-project", [
        createWorkspace("develop", "/test/new-project"),
      ]);
      fireApiEvent("project:opened", { project: newProject });

      await waitFor(() => {
        expect(projectsStore.projects.value).toHaveLength(2);
      });

      expect(screen.getByText("new-project")).toBeInTheDocument();
      expect(screen.getByText("develop")).toBeInTheDocument();
    });

    it("activeWorkspacePath matches aria-current element", async () => {
      const ws1 = createWorkspace("main", "/test/my-project");
      const ws2 = createWorkspace("feature-x", "/test/my-project");
      const project = createProject("my-project", [ws1, ws2]);
      mockApi.projects.list.mockResolvedValue([project]);

      render(App);
      showMainView();

      await waitFor(() => {
        expect(screen.getByText("main")).toBeInTheDocument();
      });

      // Initially no active workspace
      expect(projectsStore.activeWorkspacePath.value).toBeNull();
      expect(screen.queryByRole("listitem", { current: true })).toBeNull();

      // Get actual projectId from store (ID is regenerated from path)
      const actualProjectId = projectsStore.projects.value[0]!.id;

      // Set active workspace via event (v2 format uses WorkspaceRef)
      fireApiEvent("workspace:switched", {
        projectId: actualProjectId,
        workspaceName: ws1.name,
        path: ws1.path,
      });

      await waitFor(() => {
        expect(projectsStore.activeWorkspacePath.value).toBe(ws1.path);
      });

      const mainItem = screen.getByText("main").closest("li");
      expect(mainItem).toHaveAttribute("aria-current", "true");

      // Switch to another workspace (v2 format uses WorkspaceRef)
      fireApiEvent("workspace:switched", {
        projectId: actualProjectId,
        workspaceName: ws2.name,
        path: ws2.path,
      });

      await waitFor(() => {
        expect(projectsStore.activeWorkspacePath.value).toBe(ws2.path);
      });

      const featureItem = screen.getByText("feature-x").closest("li");
      expect(featureItem).toHaveAttribute("aria-current", "true");
      expect(mainItem).not.toHaveAttribute("aria-current", "true");
    });
  });

  describe("keyboard activation", () => {
    // Note: These tests verify that mode change events from main process trigger
    // the correct store updates. Since the ui-mode store mock doesn't have Svelte's
    // reactivity, we test the integration boundary (setModeFromMain calls and store state)
    // rather than UI updates. UI rendering based on reactive state is covered by
    // component-level tests with proper Svelte test setup.

    it("mode change events update store state correctly", async () => {
      render(App);
      showMainView();

      // Wait for initial load (New workspace entry is always present in the sidebar)
      await waitFor(() => {
        expect(screen.getByRole("button", { name: /new workspace/i })).toBeInTheDocument();
      });

      // Clear any calls from initialization
      mockUiModeStore.setModeFromMain.mockClear();

      // Step 1: Simulate shortcut enable event (Alt+X pressed)
      fireApiEvent("ui:mode-changed", { mode: "shortcut", previousMode: "workspace" });

      // Step 2: Verify setModeFromMain was called with "shortcut"
      expect(mockUiModeStore.setModeFromMain).toHaveBeenCalledWith("shortcut");

      // Step 3: Verify store state changed
      // Note: shortcutsStore re-exports from ui-mode store, so this tests the mock's getter
      expect(uiModeStore.shortcutModeActive.value).toBe(true);

      // Step 4: Main process sends mode-changed when Alt is released
      mockUiModeStore.setModeFromMain.mockClear();
      fireApiEvent("ui:mode-changed", { mode: "workspace", previousMode: "shortcut" });

      // Step 5: Verify setModeFromMain was called with "workspace"
      expect(mockUiModeStore.setModeFromMain).toHaveBeenCalledWith("workspace");

      // Step 6: Verify store state changed back
      expect(uiModeStore.shortcutModeActive.value).toBe(false);
    });
  });

  describe("keyboard action flows", () => {
    it("should-complete-full-shortcut-flow-activate-action-release: Alt+X → ↓ → workspace switches → release Alt → overlay hides", async () => {
      const ws1 = createWorkspace("main", "/test/my-project");
      const ws2 = createWorkspace("feature", "/test/my-project");
      const project = createProject("my-project", [ws1, ws2]);
      mockApi.projects.list.mockResolvedValue([project]);

      render(App);
      showMainView();

      // Wait for load
      await waitFor(() => {
        expect(screen.getByText("main")).toBeInTheDocument();
        expect(screen.getByText("feature")).toBeInTheDocument();
      });

      // Get actual projectId from store (ID is regenerated from path)
      const actualProjectId = projectsStore.projects.value[0]!.id;

      // Set active workspace (v2 format uses WorkspaceRef)
      fireApiEvent("workspace:switched", {
        projectId: actualProjectId,
        workspaceName: ws1.name,
        path: ws1.path,
      });
      await waitFor(() => {
        expect(projectsStore.activeWorkspacePath.value).toBe(ws1.path);
      });

      // Clear mocks
      mockApi.ui.switchWorkspace.mockClear();

      // Step 1: Activate shortcut mode
      fireApiEvent("ui:mode-changed", { mode: "shortcut", previousMode: "workspace" });
      await waitFor(() => {
        expect(uiModeStore.shortcutModeActive.value).toBe(true);
      });

      // Step 2: Fire shortcut key event (keys now come from main process via onShortcut)
      fireApiEvent("shortcut:key", "down");

      // Step 3: Verify workspace switch was called (workspacePath, focus)
      await waitFor(() => {
        expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith(
          ws2.path,
          false // focus=false to keep shortcut mode active
        );
      });

      // Step 4: Verify overlay is still active
      expect(uiModeStore.shortcutModeActive.value).toBe(true);

      // Step 5: Main process sends mode-changed when Alt is released
      // (Alt release handling moved from renderer to main process in Stage 2)
      fireApiEvent("ui:mode-changed", { mode: "workspace", previousMode: "shortcut" });

      // Step 6: Verify overlay hides
      await waitFor(() => {
        expect(uiModeStore.shortcutModeActive.value).toBe(false);
      });
    });

    it("should-execute-multiple-actions-in-sequence: Alt+X → 1 → 2 → verify both executed", async () => {
      const workspaces = Array.from({ length: 3 }, (_, i) =>
        createWorkspace(`ws${i + 1}`, "/test/my-project")
      );
      const project = createProject("my-project", workspaces);
      mockApi.projects.list.mockResolvedValue([project]);

      render(App);
      showMainView();

      // Wait for load
      await waitFor(() => {
        expect(screen.getByText("ws1")).toBeInTheDocument();
      });

      // Activate shortcut mode
      fireApiEvent("ui:mode-changed", { mode: "shortcut", previousMode: "workspace" });
      await waitFor(() => {
        expect(uiModeStore.shortcutModeActive.value).toBe(true);
      });

      // Fire shortcut key events (keys now come from main process via onShortcut)
      fireApiEvent("shortcut:key", "1");
      await waitFor(() => {
        expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith(workspaces[0]!.path, false);
      });

      // Clear and fire key "2"
      mockApi.ui.switchWorkspace.mockClear();
      fireApiEvent("shortcut:key", "2");

      await waitFor(() => {
        expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith(workspaces[1]!.path, false);
      });

      // Verify overlay is still visible
      expect(uiModeStore.shortcutModeActive.value).toBe(true);
    });

    it("should-open-dialog-and-hide-overlay: Alt+X → Enter → dialog opens, overlay hides", async () => {
      const ws = createWorkspace("main", "/test/my-project");
      const project = createProject("my-project", [ws]);
      mockApi.projects.list.mockResolvedValue([project]);

      openCreationPanelSession();
      render(App);
      showMainView();

      // Wait for load
      await waitFor(() => {
        expect(screen.getByText("my-project")).toBeInTheDocument();
      });

      // Get actual projectId from store (ID is regenerated from path)
      const actualProjectId = projectsStore.projects.value[0]!.id;

      // Set active workspace so activeProject is available (v2 format uses WorkspaceRef)
      fireApiEvent("workspace:switched", {
        projectId: actualProjectId,
        workspaceName: ws.name,
        path: ws.path,
      });
      await waitFor(() => {
        expect(projectsStore.activeWorkspacePath.value).toBe(ws.path);
      });

      // Activate shortcut mode
      fireApiEvent("ui:mode-changed", { mode: "shortcut", previousMode: "workspace" });
      await waitFor(() => {
        expect(uiModeStore.shortcutModeActive.value).toBe(true);
      });

      // Fire Enter shortcut key to open the New workspace view
      fireApiEvent("shortcut:key", "enter");

      // Verify the New workspace view opens
      await waitFor(() => {
        expect(screen.getByRole("heading", { name: "New workspace" })).toBeInTheDocument();
      });

      // Verify shortcut mode deactivated
      expect(uiModeStore.shortcutModeActive.value).toBe(false);
    });

    it("should-wrap-navigation-at-boundaries: Alt+X → at last workspace → ↓ → wraps to first", async () => {
      const ws1 = createWorkspace("first", "/test/my-project");
      const ws2 = createWorkspace("last", "/test/my-project");
      const project = createProject("my-project", [ws1, ws2]);
      mockApi.projects.list.mockResolvedValue([project]);

      render(App);
      showMainView();

      await waitFor(() => {
        expect(screen.getByText("first")).toBeInTheDocument();
      });

      // Get actual projectId from store (ID is regenerated from path)
      const actualProjectId = projectsStore.projects.value[0]!.id;

      // Set active to last workspace (v2 format uses WorkspaceRef)
      fireApiEvent("workspace:switched", {
        projectId: actualProjectId,
        workspaceName: ws2.name,
        path: ws2.path,
      });
      await waitFor(() => {
        expect(projectsStore.activeWorkspacePath.value).toBe(ws2.path);
      });

      mockApi.ui.switchWorkspace.mockClear();

      // Activate shortcut mode
      fireApiEvent("ui:mode-changed", { mode: "shortcut", previousMode: "workspace" });

      // Fire ArrowDown shortcut key (should wrap to first)
      fireApiEvent("shortcut:key", "down");

      await waitFor(() => {
        expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith(ws1.path, false);
      });
    });

    it("should-handle-no-workspaces-gracefully: no workspaces → navigation hints hidden", async () => {
      mockApi.projects.list.mockResolvedValue([]);

      render(App);
      showMainView();

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /new workspace/i })).toBeInTheDocument();
      });

      // Activate shortcut mode
      fireApiEvent("ui:mode-changed", { mode: "shortcut", previousMode: "workspace" });
      await waitFor(() => {
        expect(uiModeStore.shortcutModeActive.value).toBe(true);
      });

      // Verify navigate and jump hints are hidden
      const navigateHint = screen.getByLabelText("Up and Down arrows to navigate");
      expect(navigateHint).toHaveClass("shortcut-hint--hidden");

      const jumpHint = screen.getByLabelText("Number keys 1 through 0 to jump");
      expect(jumpHint).toHaveClass("shortcut-hint--hidden");

      // Pressing arrow should be no-op (fires via shortcut:key event)
      mockApi.ui.switchWorkspace.mockClear();
      fireApiEvent("shortcut:key", "down");
      // Even with event fired, no workspaces means no switch
      expect(mockApi.ui.switchWorkspace).not.toHaveBeenCalled();
    });

    it("should-handle-single-workspace-gracefully: single workspace → navigate hints hidden, jump works for index 1", async () => {
      const ws = createWorkspace("only", "/test/my-project");
      const project = createProject("my-project", [ws]);
      mockApi.projects.list.mockResolvedValue([project]);

      render(App);
      showMainView();

      await waitFor(() => {
        expect(screen.getByText("only")).toBeInTheDocument();
      });

      // With a single workspace, mark it as active so the overlay treats this
      // as "already on the only workspace" (real-world scenario). Without an
      // active workspace, navigation hints stay visible because Alt+X+↓ would
      // land on the only workspace — meaningful from the New workspace view.
      projectsStore.setActiveWorkspace(ws.path);

      // Activate shortcut mode
      fireApiEvent("ui:mode-changed", { mode: "shortcut", previousMode: "workspace" });
      await waitFor(() => {
        expect(uiModeStore.shortcutModeActive.value).toBe(true);
      });

      // Navigate hints should be hidden (single workspace, already active)
      const navigateHint = screen.getByLabelText("Up and Down arrows to navigate");
      expect(navigateHint).toHaveClass("shortcut-hint--hidden");

      // Jump should still work for index 1 (workspacePath, focus)
      fireApiEvent("shortcut:key", "1");

      await waitFor(() => {
        expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith(ws.path, false);
      });
    });
  });

  describe("onboarding flow", () => {
    it("complete-onboarding-flow: empty state → panel auto-opens → click folder → backend opens project", async () => {
      // Start with no projects (empty state)
      mockApi.projects.list.mockResolvedValue([]);
      openCreationPanelSession();

      render(App);
      showMainView();

      // Wait for the New workspace view to auto-open (empty state)
      await waitFor(() => {
        expect(screen.getByRole("heading", { name: "New workspace" })).toBeInTheDocument();
      });

      // Click the folder button: the form sends the action to the backend
      // creation module, which drives the native picker itself.
      const folderButton = screen.getByRole("button", { name: "Open project folder" });
      await fireEvent.click(folderButton);

      await waitFor(() => {
        expect(mockApi.sendDialogEvent).toHaveBeenCalledWith(
          expect.objectContaining({ actionId: "open-folder" })
        );
      });

      // Simulate the backend completing the open: project:opened event with a
      // project that has NO workspaces (v2 format)
      const emptyProject = createProject("new-project", []);
      fireApiEvent("project:opened", { project: emptyProject });

      // Verify the New workspace view is still open with the project
      await waitFor(() => {
        expect(screen.getByRole("heading", { name: "New workspace" })).toBeInTheDocument();
      });
    });

    it("auto-open-when-no-projects: empty state → New workspace view opens", async () => {
      mockApi.projects.list.mockResolvedValue([]);
      openCreationPanelSession();

      render(App);
      showMainView();

      // Wait for the New workspace view to auto-open
      await waitFor(() => {
        expect(screen.getByRole("heading", { name: "New workspace" })).toBeInTheDocument();
      });

      // Verify projects.open was NOT called (user needs to click the button)
      expect(mockApi.projects.open).not.toHaveBeenCalled();
    });

    it("project-with-workspaces-no-auto-open: opening a project with workspaces does not auto-open the view", async () => {
      const existingProject = createProject("existing", [
        createWorkspace("main", "/test/existing"),
      ]);
      mockApi.projects.list.mockResolvedValue([existingProject]);

      const newProject = createProject("another-project", [
        createWorkspace("develop", "/test/another-project"),
      ]);

      render(App);
      showMainView();

      // Wait for load. Workspaces exist, so the New workspace view is NOT auto-opened.
      await waitFor(() => {
        expect(screen.getByText("existing")).toBeInTheDocument();
      });
      expect(screen.queryByRole("heading", { name: "New workspace" })).not.toBeInTheDocument();

      // Simulate opening another project that has workspaces.
      fireApiEvent("project:opened", { project: newProject });

      // Verify project is added
      await waitFor(() => {
        expect(screen.getByText("another-project")).toBeInTheDocument();
      });

      // Give time for any auto-open to trigger
      await new Promise((resolve) => setTimeout(resolve, 50));

      // The New workspace view should NOT have auto-opened (the project has workspaces).
      expect(screen.queryByRole("heading", { name: "New workspace" })).not.toBeInTheDocument();
    });
  });

  // ============================================================================
  // NOTE: "setup flow integration" tests have been removed.
  // Setup is now handled via app:setup intent in the main process. The renderer
  // is passive and waits for lifecycle:show-main-view IPC event before showing
  // MainView. See APP_SETUP_MIGRATION.md for details.
  // ============================================================================
});
