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

const mockApi = vi.hoisted(() => ({
  // Normal API (flat structure)
  workspaces: {
    create: vi.fn().mockResolvedValue({}),
    remove: vi.fn().mockResolvedValue({ branchDeleted: true }),
    getStatus: vi.fn().mockResolvedValue({ isDirty: false, agent: { type: "none" } }),
    get: vi.fn().mockResolvedValue(undefined),
  },
  projects: {
    list: vi.fn().mockResolvedValue([]),
    open: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(undefined),
    fetchBases: vi.fn().mockResolvedValue({ bases: [] }),
  },
  ui: {
    selectFolder: vi.fn().mockResolvedValue(null),
    getActiveWorkspace: vi.fn().mockResolvedValue(null),
    switchWorkspace: vi.fn().mockResolvedValue(undefined),
    setMode: vi.fn().mockResolvedValue(undefined),
  },
  lifecycle: {
    getState: vi.fn().mockResolvedValue({ state: "loading", agent: "opencode" }),
    setup: vi.fn().mockResolvedValue({ success: true }),
    startServices: vi.fn().mockResolvedValue({ success: true }),
    setAgent: vi.fn().mockResolvedValue(undefined),
    quit: vi.fn().mockResolvedValue(undefined),
  },
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
  isWorkspaceDirty: vi.fn().mockResolvedValue(false),
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
import * as dialogsStore from "$lib/stores/dialogs.svelte.js";
import * as shortcutsStore from "$lib/stores/shortcuts.svelte.js";
import * as uiModeStore from "$lib/stores/ui-mode.svelte.js";
import * as agentStatusStore from "$lib/stores/agent-status.svelte.js";

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
    dialogsStore.reset();
    shortcutsStore.reset();
    agentStatusStore.reset();
    // Reset ui-mode store state (the mock's reset function updates the mutable state)
    mockUiModeStore.reset();

    // Reset v2 event callbacks
    clearEventCallbacks();

    // Default mocks for v2 API
    mockApi.projects.list.mockResolvedValue([]);
    mockApi.projects.fetchBases.mockResolvedValue({
      bases: [
        { name: "main", isRemote: false },
        { name: "develop", isRemote: false },
      ],
    });
    mockApi.ui.getActiveWorkspace.mockResolvedValue(null);
    mockApi.workspaces.getStatus.mockResolvedValue({
      isDirty: false,
      agent: { type: "none" },
    });
    // Legacy mocks that may still be used in some places
    mockApi.listBases.mockResolvedValue([
      { name: "main", isRemote: false },
      { name: "develop", isRemote: false },
    ]);
    mockApi.isWorkspaceDirty.mockResolvedValue(false);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  describe("happy paths", () => {
    it("open project: folder icon in Create Workspace dialog → selectFolder returns path → openProject → project:opened event → UI shows project in sidebar", async () => {
      // Start with an existing project to avoid auto-open picker
      const existingProject = createProject("existing", [
        createWorkspace("main", "/test/existing"),
      ]);
      mockApi.projects.list.mockResolvedValue([existingProject]);

      const projectPath = "/test/my-project";
      mockApi.ui.selectFolder.mockResolvedValue(projectPath);

      render(App);

      // Wait for initial load
      await waitFor(() => {
        expect(screen.getByText("existing")).toBeInTheDocument();
      });

      // Open Create Workspace dialog via the + button
      const addButton = screen.getByLabelText(/add workspace/i);
      await fireEvent.click(addButton);

      await waitFor(() => {
        expect(screen.getByRole("dialog")).toBeInTheDocument();
      });

      // Click the folder icon to open a new project
      const folderButton = screen.getByRole("button", { name: /open project folder/i });
      await fireEvent.click(folderButton);

      // Verify selectFolder was called (v2 API)
      await waitFor(() => {
        expect(mockApi.ui.selectFolder).toHaveBeenCalledTimes(1);
      });

      // Verify openProject was called with the path (v2 API)
      await waitFor(() => {
        expect(mockApi.projects.open).toHaveBeenCalledWith(projectPath);
      });

      // Simulate project:opened event (v2 format includes id)
      const newProject = createProject("my-project", [createWorkspace("main", projectPath)]);
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

      render(App);

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

      // Verify closeProject was called (v2 API uses projectId)
      await waitFor(() => {
        expect(mockApi.projects.close).toHaveBeenCalledWith(actualProjectId);
      });

      // Simulate project:closed event (v2 format uses projectId not path)
      fireApiEvent("project:closed", { projectId: actualProjectId });

      // Verify project is removed from sidebar
      await waitFor(() => {
        expect(screen.queryByText("my-project")).not.toBeInTheDocument();
        expect(screen.getByText(/No projects open\./)).toBeInTheDocument();
      });
    });

    it("create workspace: click [+] → dialog opens → dialog receives workspace:created event → new workspace in sidebar", async () => {
      // This test focuses on the dialog opening and event handling
      // BranchDropdown interaction is tested separately in BranchDropdown.test.ts
      const project = createProject("my-project", [createWorkspace("main", "/test/my-project")]);
      mockApi.projects.list.mockResolvedValue([project]);

      render(App);

      // Wait for project to appear
      await waitFor(() => {
        expect(screen.getByText("my-project")).toBeInTheDocument();
      });

      // Click add workspace button
      const addButton = screen.getByLabelText(/add workspace/i);
      await fireEvent.click(addButton);

      // Verify dialog opens
      await waitFor(() => {
        expect(screen.getByRole("dialog")).toBeInTheDocument();
        expect(screen.getByText("Create Workspace")).toBeInTheDocument();
      });

      // Verify the dialog has project dropdown, name/branch dropdown, and base branch dropdown
      // NameBranchDropdown is a filterable combobox, query its container
      expect(document.querySelector(".name-branch-dropdown")).toBeInTheDocument();
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

      // Verify v2.workspaces.remove was called with correct params
      // (projectId is generated, workspaceName matches, keepBranch is false by default)
      await waitFor(() => {
        expect(mockApi.workspaces.remove).toHaveBeenCalledWith(
          expect.any(String), // projectId (generated)
          workspace.name, // workspaceName
          false // keepBranch (default is unchecked, so keepBranch=false)
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

      // Verify switchWorkspace was called (v2 API uses projectId, workspaceName)
      // Note: focus parameter is optional, MainView doesn't pass it (defaults to true)
      await waitFor(() => {
        expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith(actualProjectId, ws2.name);
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
    it("selectFolder returns null (user cancelled) → no action taken", async () => {
      // Start with an existing project to avoid auto-open picker
      const existingProject = createProject("existing", [
        createWorkspace("main", "/test/existing"),
      ]);
      mockApi.projects.list.mockResolvedValue([existingProject]);

      mockApi.ui.selectFolder.mockResolvedValue(null);

      render(App);

      await waitFor(() => {
        expect(screen.getByText("existing")).toBeInTheDocument();
      });

      // Open Create Workspace dialog via the + button
      const addButton = screen.getByLabelText(/add workspace/i);
      await fireEvent.click(addButton);

      await waitFor(() => {
        expect(screen.getByRole("dialog")).toBeInTheDocument();
      });

      // Click the folder icon
      const folderButton = screen.getByRole("button", { name: /open project folder/i });
      await fireEvent.click(folderButton);

      await waitFor(() => {
        expect(mockApi.ui.selectFolder).toHaveBeenCalledTimes(1);
      });

      // openProject should NOT be called
      expect(mockApi.projects.open).not.toHaveBeenCalled();

      // Existing project should still be shown
      expect(screen.getByText("existing")).toBeInTheDocument();
    });

    it("API rejection during load → loadingState is 'error', loadingError has message", async () => {
      mockApi.projects.list.mockRejectedValue(new Error("Database connection failed"));

      render(App);

      await waitFor(() => {
        expect(screen.getByText(/database connection failed/i)).toBeInTheDocument();
      });

      expect(projectsStore.loadingState.value).toBe("error");
      expect(projectsStore.loadingError.value).toBe("Database connection failed");
    });

    it("createWorkspace API error handling is tested in CreateWorkspaceDialog.test.ts", async () => {
      // The full form validation and API error handling is tested in the component test
      // This integration test verifies the dialog opens and receives the project context
      const project = createProject("my-project", [createWorkspace("main", "/test/my-project")]);
      mockApi.projects.list.mockResolvedValue([project]);

      render(App);

      await waitFor(() => {
        expect(screen.getByText("my-project")).toBeInTheDocument();
      });

      // Open dialog
      const addButton = screen.getByLabelText(/add workspace/i);
      await fireEvent.click(addButton);

      await waitFor(() => {
        expect(screen.getByRole("dialog")).toBeInTheDocument();
      });

      // Verify dialog opened with correct context (has project dropdown, name dropdown, and branch dropdown)
      // NameBranchDropdown is a filterable combobox, query its container
      expect(document.querySelector(".name-branch-dropdown")).toBeInTheDocument();
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
        project.id,
        workspace.name,
        false // keepBranch default
      );
    });
  });

  describe("dialog z-order integration", () => {
    // Note: These tests verify that MainView correctly notifies the ui-mode store
    // when dialog state changes. The actual api.ui.setMode call happens inside
    // the ui-mode store, which has its own unit tests for reactivity.
    // Since the mock doesn't have Svelte's reactivity, we test the integration
    // boundary (setDialogOpen calls) rather than the downstream IPC call.

    it("notifies ui-mode store when dialog opens", async () => {
      const project = createProject("my-project", [createWorkspace("main", "/test/my-project")]);
      mockApi.projects.list.mockResolvedValue([project]);

      render(App);

      // Wait for initial load
      await waitFor(() => {
        expect(screen.getByText("my-project")).toBeInTheDocument();
      });

      // Clear any calls from initialization
      mockUiModeStore.setDialogOpen.mockClear();

      // Open create dialog
      const addButton = screen.getByLabelText(/add workspace/i);
      await fireEvent.click(addButton);

      // Wait for dialog to appear
      await waitFor(() => {
        expect(screen.getByRole("dialog")).toBeInTheDocument();
      });

      // Verify setDialogOpen was called with true
      expect(mockUiModeStore.setDialogOpen).toHaveBeenCalledWith(true);
    });

    it("notifies ui-mode store when dialog closes", async () => {
      const project = createProject("my-project", [createWorkspace("main", "/test/my-project")]);
      mockApi.projects.list.mockResolvedValue([project]);

      render(App);

      // Wait for initial load
      await waitFor(() => {
        expect(screen.getByText("my-project")).toBeInTheDocument();
      });

      // Open create dialog
      const addButton = screen.getByLabelText(/add workspace/i);
      await fireEvent.click(addButton);

      await waitFor(() => {
        expect(screen.getByRole("dialog")).toBeInTheDocument();
      });

      // Clear calls and close dialog
      mockUiModeStore.setDialogOpen.mockClear();

      // Close dialog via Cancel button
      const cancelButton = screen.getByRole("button", { name: /cancel/i });
      await fireEvent.click(cancelButton);

      // Wait for dialog to close
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      });

      // Verify setDialogOpen was called with false
      expect(mockUiModeStore.setDialogOpen).toHaveBeenCalledWith(false);
    });

    it("handles api.setMode failure gracefully", async () => {
      const project = createProject("my-project", [createWorkspace("main", "/test/my-project")]);
      mockApi.projects.list.mockResolvedValue([project]);
      mockApi.ui.setMode.mockRejectedValue(new Error("IPC failed"));

      render(App);

      // Wait for initial load
      await waitFor(() => {
        expect(screen.getByText("my-project")).toBeInTheDocument();
      });

      // Open create dialog - should not throw
      const addButton = screen.getByLabelText(/add workspace/i);
      await fireEvent.click(addButton);

      // Dialog should still open in UI despite API failure
      await waitFor(() => {
        expect(screen.getByRole("dialog")).toBeInTheDocument();
      });
    });

    it("dialog close works with active workspace", async () => {
      const workspace = createWorkspace("main", "/test/my-project");
      const project = createProject("my-project", [workspace]);
      mockApi.projects.list.mockResolvedValue([project]);
      mockApi.ui.getActiveWorkspace.mockResolvedValue({
        projectId: project.id,
        workspaceName: workspace.name,
        path: workspace.path,
      });

      render(App);

      // Wait for initial load and active workspace to be set
      await waitFor(() => {
        expect(screen.getByText("my-project")).toBeInTheDocument();
        expect(projectsStore.activeWorkspacePath.value).toBe(workspace.path);
      });

      // Open create dialog
      const addButton = screen.getByLabelText(/add workspace/i);
      await fireEvent.click(addButton);

      await waitFor(() => {
        expect(screen.getByRole("dialog")).toBeInTheDocument();
      });

      // Clear calls
      mockUiModeStore.setDialogOpen.mockClear();

      // Close dialog via Cancel button
      const cancelButton = screen.getByRole("button", { name: /cancel/i });
      await fireEvent.click(cancelButton);

      // Wait for dialog to close
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      });

      // Verify setDialogOpen(false) was called - ui-mode store handles the actual setMode call
      expect(mockUiModeStore.setDialogOpen).toHaveBeenCalledWith(false);
    });

    it("dialog close works with no active workspace", async () => {
      const project = createProject("my-project", [createWorkspace("main", "/test/my-project")]);
      mockApi.projects.list.mockResolvedValue([project]);
      mockApi.ui.getActiveWorkspace.mockResolvedValue(null); // No active workspace

      render(App);

      // Wait for initial load
      await waitFor(() => {
        expect(screen.getByText("my-project")).toBeInTheDocument();
      });

      // Open create dialog
      const addButton = screen.getByLabelText(/add workspace/i);
      await fireEvent.click(addButton);

      await waitFor(() => {
        expect(screen.getByRole("dialog")).toBeInTheDocument();
      });

      // Clear calls
      mockUiModeStore.setDialogOpen.mockClear();

      // Close dialog via Cancel button
      const cancelButton = screen.getByRole("button", { name: /cancel/i });
      await fireEvent.click(cancelButton);

      // Wait for dialog to close
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      });

      // Verify setDialogOpen(false) was called - ui-mode store handles the actual setMode call
      expect(mockUiModeStore.setDialogOpen).toHaveBeenCalledWith(false);
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

      // Wait for load
      await waitFor(() => {
        expect(projectsStore.loadingState.value).toBe("loaded");
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

      // Wait for initial load
      await waitFor(() => {
        expect(screen.getByText(/No projects open\./)).toBeInTheDocument();
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

      // Step 3: Verify workspace switch was called (v2 API: projectId, workspaceName, focus)
      await waitFor(() => {
        expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith(
          actualProjectId,
          ws2.name,
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

      // Wait for load
      await waitFor(() => {
        expect(screen.getByText("ws1")).toBeInTheDocument();
      });

      // Get actual projectId from store (ID is regenerated from path)
      const actualProjectId = projectsStore.projects.value[0]!.id;

      // Activate shortcut mode
      fireApiEvent("ui:mode-changed", { mode: "shortcut", previousMode: "workspace" });
      await waitFor(() => {
        expect(uiModeStore.shortcutModeActive.value).toBe(true);
      });

      // Fire shortcut key events (keys now come from main process via onShortcut)
      fireApiEvent("shortcut:key", "1");
      await waitFor(() => {
        expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith(
          actualProjectId,
          workspaces[0]!.name,
          false
        );
      });

      // Clear and fire key "2"
      mockApi.ui.switchWorkspace.mockClear();
      fireApiEvent("shortcut:key", "2");

      await waitFor(() => {
        expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith(
          actualProjectId,
          workspaces[1]!.name,
          false
        );
      });

      // Verify overlay is still visible
      expect(uiModeStore.shortcutModeActive.value).toBe(true);
    });

    it("should-open-dialog-and-hide-overlay: Alt+X → Enter → dialog opens, overlay hides", async () => {
      const ws = createWorkspace("main", "/test/my-project");
      const project = createProject("my-project", [ws]);
      mockApi.projects.list.mockResolvedValue([project]);

      render(App);

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

      // Fire Enter shortcut key to open create dialog
      fireApiEvent("shortcut:key", "enter");

      // Verify dialog opens
      await waitFor(() => {
        expect(screen.getByRole("dialog")).toBeInTheDocument();
        expect(screen.getByText("Create Workspace")).toBeInTheDocument();
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
        expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith(actualProjectId, ws1.name, false);
      });
    });

    it("should-handle-no-workspaces-gracefully: no workspaces → navigation hints hidden", async () => {
      mockApi.projects.list.mockResolvedValue([]);

      render(App);

      await waitFor(() => {
        expect(screen.getByText(/No projects open\./)).toBeInTheDocument();
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

      await waitFor(() => {
        expect(screen.getByText("only")).toBeInTheDocument();
      });

      // Get actual projectId from store (ID is regenerated from path)
      const actualProjectId = projectsStore.projects.value[0]!.id;

      // Activate shortcut mode
      fireApiEvent("ui:mode-changed", { mode: "shortcut", previousMode: "workspace" });
      await waitFor(() => {
        expect(uiModeStore.shortcutModeActive.value).toBe(true);
      });

      // Navigate hints should be hidden (single workspace)
      const navigateHint = screen.getByLabelText("Up and Down arrows to navigate");
      expect(navigateHint).toHaveClass("shortcut-hint--hidden");

      // Jump should still work for index 1 (v2 API: projectId, workspaceName, focus)
      fireApiEvent("shortcut:key", "1");

      await waitFor(() => {
        expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith(actualProjectId, ws.name, false);
      });
    });
  });

  describe("onboarding flow", () => {
    it("complete-onboarding-flow: empty state → auto-open picker → select folder → project with 0 workspaces → auto-open create dialog", async () => {
      // Start with no projects (empty state)
      mockApi.projects.list.mockResolvedValue([]);

      // Defer folder selection to simulate user selecting a folder
      let folderPromiseResolve: (value: string | null) => void = () => {};
      mockApi.ui.selectFolder.mockImplementation(() => {
        return new Promise((resolve) => {
          folderPromiseResolve = resolve;
        });
      });

      render(App);

      // Wait for MainView to load (should see EmptyState briefly, then folder picker auto-opens)
      await waitFor(() => {
        expect(mockApi.projects.list).toHaveBeenCalled();
      });

      // Verify folder picker was automatically triggered (auto-open on empty state)
      await waitFor(() => {
        expect(mockApi.ui.selectFolder).toHaveBeenCalledTimes(1);
      });

      // Simulate user selecting a folder
      const selectedPath = "/test/new-project";
      folderPromiseResolve(selectedPath);

      // Verify openProject was called with the selected path
      await waitFor(() => {
        expect(mockApi.projects.open).toHaveBeenCalledWith(selectedPath);
      });

      // Simulate project:opened event with a project that has NO workspaces (v2 format)
      const emptyProject = createProject("new-project", []);
      fireApiEvent("project:opened", { project: emptyProject });

      // Verify create workspace dialog auto-opens because project has 0 workspaces
      await waitFor(() => {
        expect(screen.getByRole("dialog")).toBeInTheDocument();
        expect(screen.getByText("Create Workspace")).toBeInTheDocument();
      });

      // Verify dialog is for the correct project (uses project ID, not path)
      expect(dialogsStore.dialogState.value.type).toBe("create");
      if (dialogsStore.dialogState.value.type === "create") {
        // The project ID is generated from the path, so we just verify it's set
        expect(dialogsStore.dialogState.value.projectId).toBeDefined();
      }
    });

    it("auto-open-picker-cancelled: empty state → picker cancelled → EmptyState shown", async () => {
      mockApi.projects.list.mockResolvedValue([]);
      mockApi.ui.selectFolder.mockResolvedValue(null); // User cancels

      render(App);

      // Wait for auto-open
      await waitFor(() => {
        expect(mockApi.ui.selectFolder).toHaveBeenCalled();
      });

      // Verify EmptyState is shown after cancel
      await waitFor(() => {
        expect(screen.getByText(/No projects open\./)).toBeInTheDocument();
      });

      // Verify openProject was NOT called
      expect(mockApi.projects.open).not.toHaveBeenCalled();
    });

    it("project-with-workspaces-no-auto-dialog: opening project with workspaces does not auto-open dialog", async () => {
      const existingProject = createProject("existing", [
        createWorkspace("main", "/test/existing"),
      ]);
      mockApi.projects.list.mockResolvedValue([existingProject]);

      const projectPath = "/test/another-project";
      mockApi.ui.selectFolder.mockResolvedValue(projectPath);

      render(App);

      // Wait for load
      await waitFor(() => {
        expect(screen.getByText("existing")).toBeInTheDocument();
      });

      // Open Create Workspace dialog via the + button
      const addButton = screen.getByLabelText(/add workspace/i);
      await fireEvent.click(addButton);

      await waitFor(() => {
        expect(screen.getByRole("dialog")).toBeInTheDocument();
      });

      // Click the folder icon to open another project
      const folderButton = screen.getByRole("button", { name: /open project folder/i });
      await fireEvent.click(folderButton);

      await waitFor(() => {
        expect(mockApi.projects.open).toHaveBeenCalledWith(projectPath);
      });

      // Simulate project:opened with workspaces (v2 format)
      const newProject = createProject("another-project", [
        createWorkspace("develop", "/test/another-project"),
      ]);
      fireApiEvent("project:opened", { project: newProject });

      // Verify project is added
      await waitFor(() => {
        expect(screen.getByText("another-project")).toBeInTheDocument();
      });

      // Close the dialog to verify we're back to normal state
      const cancelButton = screen.getByRole("button", { name: /cancel/i });
      await fireEvent.click(cancelButton);

      // Give time for any auto-open to trigger
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify NO dialog opened (project has workspaces, so no auto-open)
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  describe("setup flow integration", () => {
    it("routes-to-mainview-when-loading: lifecycle.getState returns 'loading', startServices called, MainView mounts", async () => {
      mockApi.lifecycle.getState.mockResolvedValue({ state: "loading", agent: "opencode" });
      mockApi.lifecycle.startServices.mockResolvedValue({ success: true });
      mockApi.projects.list.mockResolvedValue([]);

      render(App);

      // Wait for MainView to mount and call listProjects (v2 API)
      await waitFor(() => {
        expect(mockApi.projects.list).toHaveBeenCalled();
      });

      // Verify startServices was called
      expect(mockApi.lifecycle.startServices).toHaveBeenCalled();

      // Verify we're in normal app mode (empty state shown)
      await waitFor(() => {
        expect(screen.getByText(/No projects open\./)).toBeInTheDocument();
      });
    });

    it("routes-to-setupscreen-when-setup: lifecycle.getState returns 'setup', SetupScreen shown", async () => {
      mockApi.lifecycle.getState.mockResolvedValue({ state: "setup", agent: "opencode" });
      // Keep setup running indefinitely
      mockApi.lifecycle.setup.mockReturnValue(new Promise(() => {}));

      render(App);

      // Wait for setup screen to appear
      await waitFor(() => {
        expect(screen.getByText("Setting up CodeHydra")).toBeInTheDocument();
      });

      // Verify v2.projects.list was NOT called (we're in setup mode)
      expect(mockApi.projects.list).not.toHaveBeenCalled();
    });

    // Note: setup completion transition is tested in App.test.ts with proper mock setup
    // The integration test focuses on the routing behavior verified above

    it("does-not-call-listProjects-during-setup: IPC calls deferred until MainView mounts", async () => {
      mockApi.lifecycle.getState.mockResolvedValue({ state: "setup", agent: "opencode" });
      // Keep setup running indefinitely
      mockApi.lifecycle.setup.mockReturnValue(new Promise(() => {}));

      render(App);

      // Wait for setup screen
      await waitFor(() => {
        expect(screen.getByText("Setting up CodeHydra")).toBeInTheDocument();
      });

      // Verify no domain IPC calls during setup
      expect(mockApi.projects.list).not.toHaveBeenCalled();
    });

    it("setup-success-triggers-mainview-mount: lifecycle.setup success triggers startServices, then MainView mount", async () => {
      // Start in setup mode
      mockApi.lifecycle.getState.mockResolvedValue({ state: "setup", agent: "opencode" });
      mockApi.projects.list.mockResolvedValue([]);
      // Setup completes successfully
      mockApi.lifecycle.setup.mockResolvedValue({ success: true });
      // startServices completes successfully (called after setup succeeds)
      mockApi.lifecycle.startServices.mockResolvedValue({ success: true });

      render(App);

      // Wait for SetupComplete screen to show (setup completes quickly)
      await waitFor(() => {
        expect(screen.getByText("Setup complete!")).toBeInTheDocument();
      });

      // The SetupComplete timer will transition to loading state, then call startServices
      // After startServices succeeds, MainView should mount and call v2.projects.list
      await waitFor(
        () => {
          expect(mockApi.projects.list).toHaveBeenCalled();
        },
        { timeout: 3000 }
      ); // Allow time for the 1.5s success screen + startServices

      // Verify the full flow: setup() → startServices()
      expect(mockApi.lifecycle.setup).toHaveBeenCalled();
      expect(mockApi.lifecycle.startServices).toHaveBeenCalled();
    });

    it("handlers-registered-before-lifecycle-getState-returns: normal handlers available when startServices completes", async () => {
      // This test verifies that when lifecycle.startServices completes,
      // the IPC handlers that MainView needs are already registered.
      // We can verify this by checking that v2.projects.list succeeds.
      mockApi.lifecycle.getState.mockResolvedValue({ state: "loading", agent: "opencode" });
      mockApi.lifecycle.startServices.mockResolvedValue({ success: true });
      const mockProjects = [createProject("my-project", [])];
      mockApi.projects.list.mockResolvedValue(mockProjects);

      render(App);

      // Wait for MainView to mount and successfully call IPC
      await waitFor(() => {
        expect(mockApi.projects.list).toHaveBeenCalled();
      });

      // Verify the project loaded successfully (no handler-not-registered error)
      await waitFor(() => {
        expect(screen.getByText("my-project")).toBeInTheDocument();
      });
    });
  });
});
