/**
 * Integration tests for the UI layer.
 * Tests complete user flows from interaction through IPC events to UI updates.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/svelte";
import type {
  Project,
  ProjectPath,
  Workspace,
  ProjectOpenedEvent,
  ProjectClosedEvent,
  WorkspaceCreatedEvent,
  WorkspaceRemovedEvent,
  WorkspaceSwitchedEvent,
} from "@shared/ipc";

// Helper to create typed paths
function asProjectPath(path: string): ProjectPath {
  return path as ProjectPath;
}

// Event callback storage for old API (kept for backwards compatibility with some tests)
type EventCallbacks = {
  onProjectOpened: ((event: ProjectOpenedEvent) => void) | null;
  onProjectClosed: ((event: ProjectClosedEvent) => void) | null;
  onWorkspaceCreated: ((event: WorkspaceCreatedEvent) => void) | null;
  onWorkspaceRemoved: ((event: WorkspaceRemovedEvent) => void) | null;
  onWorkspaceSwitched: ((event: WorkspaceSwitchedEvent) => void) | null;
  onShortcutEnable: (() => void) | null;
  onShortcutDisable: (() => void) | null;
};

// Create mock API functions with callback capture
const callbacks: EventCallbacks = {
  onProjectOpened: null,
  onProjectClosed: null,
  onWorkspaceCreated: null,
  onWorkspaceRemoved: null,
  onWorkspaceSwitched: null,
  onShortcutEnable: null,
  onShortcutDisable: null,
};

// v2 API event callbacks - MainView uses api.v2.on() which stores callbacks here
type V2EventCallback = (...args: unknown[]) => void;
const v2EventCallbacks = new Map<string, V2EventCallback>();

// Helper to fire a v2 event
function fireV2Event(event: string, payload?: unknown): void {
  const callback = v2EventCallbacks.get(event);
  if (callback) {
    callback(payload);
  }
}

// Helper to clear v2 event callbacks between tests
function clearV2EventCallbacks(): void {
  v2EventCallbacks.clear();
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
    getState: vi.fn().mockResolvedValue("ready"),
    setup: vi.fn().mockResolvedValue({ success: true }),
    quit: vi.fn().mockResolvedValue(undefined),
  },
  // on() captures callbacks by event name for tests to fire events
  on: vi.fn((event: string, callback: V2EventCallback) => {
    v2EventCallbacks.set(event, callback);
    return vi.fn(); // unsubscribe
  }),
  // onModeChange captures callback for ui:mode-changed events
  onModeChange: vi.fn((callback: V2EventCallback) => {
    v2EventCallbacks.set("ui:mode-changed", callback);
    return vi.fn(); // unsubscribe
  }),
  // onShortcut captures callback for shortcut key events from main process
  onShortcut: vi.fn((callback: V2EventCallback) => {
    v2EventCallbacks.set("shortcut:key", callback);
    return vi.fn(); // unsubscribe
  }),
  // Legacy APIs (kept for backwards compatibility with some old tests)
  listBases: vi.fn().mockResolvedValue([]),
  isWorkspaceDirty: vi.fn().mockResolvedValue(false),
}));

// Mock the API module
vi.mock("$lib/api", () => mockApi);

// Import after mock setup
import App from "../App.svelte";
import * as projectsStore from "$lib/stores/projects.svelte.js";
import * as dialogsStore from "$lib/stores/dialogs.svelte.js";
import * as shortcutsStore from "$lib/stores/shortcuts.svelte.js";
import * as agentStatusStore from "$lib/stores/agent-status.svelte.js";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// Get the current directory for reading CSS files
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Helper to read CSS file content for variable verification
function readCssFile(relativePath: string): string {
  const fullPath = resolve(__dirname, relativePath);
  return readFileSync(fullPath, "utf-8");
}

// Helper to create mock workspace (v2 API format)
function createWorkspace(name: string, projectPath: string, projectId?: string): Workspace {
  return {
    name,
    path: `${projectPath}/.worktrees/${name}`,
    branch: name,
    // v2 API adds projectId to workspaces
    ...(projectId ? { projectId } : {}),
  };
}

// Helper to generate consistent project ID from name
function projectIdFromName(name: string): string {
  // Simple hash for deterministic IDs in tests
  return `${name}-12345678`;
}

// Helper to create mock project (v2 API format with ID)
function createProject(name: string, workspaces: Workspace[] = []): Project & { id: string } {
  const id = projectIdFromName(name);
  return {
    id,
    path: asProjectPath(`/test/${name}`),
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

    // Reset v2 event callbacks
    clearV2EventCallbacks();

    // Reset old callbacks (for backwards compatibility)
    callbacks.onProjectOpened = null;
    callbacks.onProjectClosed = null;
    callbacks.onWorkspaceCreated = null;
    callbacks.onWorkspaceRemoved = null;
    callbacks.onWorkspaceSwitched = null;
    callbacks.onShortcutEnable = null;
    callbacks.onShortcutDisable = null;

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
    it("open project: selectFolder returns path → openProject → project:opened event → UI shows project in sidebar", async () => {
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

      // Click Open Project button
      const openButton = screen.getByRole("button", { name: /open project/i });
      await fireEvent.click(openButton);

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
      fireV2Event("project:opened", { project: newProject });

      // Verify new project appears in sidebar
      await waitFor(() => {
        expect(screen.getByText("my-project")).toBeInTheDocument();
      });
    });

    it("close project: click [×] → closeProject → project:closed event → project removed from sidebar", async () => {
      // Use project with no workspaces for direct close (projects with workspaces show dialog)
      const project = createProject("my-project", []);
      mockApi.projects.list.mockResolvedValue([project]);

      render(App);

      // Wait for project to appear
      await waitFor(() => {
        expect(screen.getByText("my-project")).toBeInTheDocument();
      });

      // Get actual projectId from store (ID is regenerated from path)
      const actualProjectId = projectsStore.projects.value[0]!.id;

      // Click close project button
      const closeButton = screen.getByLabelText(/close project/i);
      await fireEvent.click(closeButton);

      // Verify closeProject was called (v2 API uses projectId)
      await waitFor(() => {
        expect(mockApi.projects.close).toHaveBeenCalledWith(actualProjectId);
      });

      // Simulate project:closed event (v2 format uses projectId not path)
      fireV2Event("project:closed", { projectId: actualProjectId });

      // Verify project is removed
      await waitFor(() => {
        expect(screen.queryByText("my-project")).not.toBeInTheDocument();
        expect(screen.getByText("No projects open.")).toBeInTheDocument();
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

      // Verify the dialog has project dropdown, name input, and branch dropdown
      // Note: vscode-textfield is a web component, so we query by id
      expect(document.getElementById("workspace-name")).toBeInTheDocument();
      // Should have 2 comboboxes: project dropdown and branch dropdown
      expect(screen.getAllByRole("combobox")).toHaveLength(2);

      // Simulate workspace:created event (v2 format uses projectId)
      // Get actual projectId from store (ID is regenerated from path)
      const actualProjectId = projectsStore.projects.value[0]!.id;
      const newWorkspace = createWorkspace("feature-x", "/test/my-project", actualProjectId);
      fireV2Event("workspace:created", {
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
      fireV2Event("workspace:removed", {
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
      fireV2Event("workspace:switched", {
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

      const openButton = screen.getByRole("button", { name: /open project/i });
      await fireEvent.click(openButton);

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

      // Verify dialog opened with correct context (has project dropdown, name input, and branch dropdown)
      // Note: vscode-textfield is a web component, so we query by id
      expect(document.getElementById("workspace-name")).toBeInTheDocument();
      // Should have 2 comboboxes: project dropdown and branch dropdown
      expect(screen.getAllByRole("combobox")).toHaveLength(2);
    });

    it("removeWorkspace rejects → error shown in dialog, form re-enabled", async () => {
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

      // Make v2.workspaces.remove fail
      mockApi.workspaces.remove.mockRejectedValue(new Error("Workspace has uncommitted changes"));

      // Use the dialog's Remove button (vscode-button web component)
      const dialog = screen.getByRole("dialog");
      const removeConfirmButton = Array.from(dialog.querySelectorAll("vscode-button")).find(
        (btn) => btn.textContent?.trim() === "Remove"
      ) as HTMLElement;
      await fireEvent.click(removeConfirmButton);

      // Verify error is shown
      await waitFor(() => {
        expect(screen.getByText(/workspace has uncommitted changes/i)).toBeInTheDocument();
      });

      // Verify button is re-enabled
      expect(removeConfirmButton).not.toBeDisabled();
    });
  });

  describe("dialog z-order integration", () => {
    it("calls api.setMode('dialog') when dialog opens", async () => {
      const project = createProject("my-project", [createWorkspace("main", "/test/my-project")]);
      mockApi.projects.list.mockResolvedValue([project]);

      render(App);

      // Wait for initial load
      await waitFor(() => {
        expect(screen.getByText("my-project")).toBeInTheDocument();
      });

      // Clear any calls from initialization
      mockApi.ui.setMode.mockClear();

      // Open create dialog
      const addButton = screen.getByLabelText(/add workspace/i);
      await fireEvent.click(addButton);

      // Wait for dialog to appear
      await waitFor(() => {
        expect(screen.getByRole("dialog")).toBeInTheDocument();
      });

      // Verify setMode was called with "dialog"
      expect(mockApi.ui.setMode).toHaveBeenCalledWith("dialog");
    });

    it("calls api.setMode('workspace') when dialog closes", async () => {
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
      mockApi.ui.setMode.mockClear();

      // Close dialog via Cancel button
      const cancelButton = screen.getByRole("button", { name: /cancel/i });
      await fireEvent.click(cancelButton);

      // Wait for dialog to close
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      });

      // Verify setMode was called with "workspace"
      expect(mockApi.ui.setMode).toHaveBeenCalledWith("workspace");
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

    it("setMode('workspace') handles focus when dialog closes with active workspace", async () => {
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
      mockApi.ui.setMode.mockClear();

      // Close dialog via Cancel button
      const cancelButton = screen.getByRole("button", { name: /cancel/i });
      await fireEvent.click(cancelButton);

      // Wait for dialog to close
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      });

      // Verify setMode("workspace") was called - it handles both z-order and focus internally
      expect(mockApi.ui.setMode).toHaveBeenCalledWith("workspace");
    });

    it("setMode('workspace') handles dialog close with no active workspace", async () => {
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
      mockApi.ui.setMode.mockClear();

      // Close dialog via Cancel button
      const cancelButton = screen.getByRole("button", { name: /cancel/i });
      await fireEvent.click(cancelButton);

      // Wait for dialog to close
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      });

      // Verify setMode("workspace") was called - ViewManager gracefully handles null activeWorkspacePath
      expect(mockApi.ui.setMode).toHaveBeenCalledWith("workspace");
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
      fireV2Event("project:opened", { project: newProject });

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
      fireV2Event("workspace:switched", {
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
      fireV2Event("workspace:switched", {
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
    it("keyboard-activation-full-flow: Alt+X → overlay shows → Alt release → overlay hides → APIs called", async () => {
      render(App);

      // Wait for initial load
      await waitFor(() => {
        expect(screen.getByText("No projects open.")).toBeInTheDocument();
      });

      // Clear any calls from initialization
      mockApi.ui.setMode.mockClear();

      // Verify overlay exists but is initially inactive (opacity 0)
      // Use { hidden: true } because aria-hidden="true" excludes from accessible tree
      const overlay = screen.getByRole("status", { hidden: true });
      expect(overlay).toHaveClass("shortcut-overlay");
      expect(overlay).not.toHaveClass("active");

      // Step 1: Simulate shortcut enable event (Alt+X pressed)
      fireV2Event("ui:mode-changed", { mode: "shortcut", previousMode: "workspace" });

      // Step 2: Verify overlay becomes active
      await waitFor(() => {
        expect(overlay).toHaveClass("active");
      });
      expect(shortcutsStore.shortcutModeActive.value).toBe(true);

      // Step 3: Main process sends mode-changed when Alt is released
      // (Alt release handling moved from renderer to main process in Stage 2)
      fireV2Event("ui:mode-changed", { mode: "workspace", previousMode: "shortcut" });

      // Step 4: Verify overlay becomes inactive
      await waitFor(() => {
        expect(overlay).not.toHaveClass("active");
      });
      expect(shortcutsStore.shortcutModeActive.value).toBe(false);
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
      fireV2Event("workspace:switched", {
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
      fireV2Event("ui:mode-changed", { mode: "shortcut", previousMode: "workspace" });
      await waitFor(() => {
        expect(shortcutsStore.shortcutModeActive.value).toBe(true);
      });

      // Step 2: Fire shortcut key event (keys now come from main process via onShortcut)
      fireV2Event("shortcut:key", "down");

      // Step 3: Verify workspace switch was called (v2 API: projectId, workspaceName, focus)
      await waitFor(() => {
        expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith(
          actualProjectId,
          ws2.name,
          false // focus=false to keep shortcut mode active
        );
      });

      // Step 4: Verify overlay is still active
      expect(shortcutsStore.shortcutModeActive.value).toBe(true);

      // Step 5: Main process sends mode-changed when Alt is released
      // (Alt release handling moved from renderer to main process in Stage 2)
      fireV2Event("ui:mode-changed", { mode: "workspace", previousMode: "shortcut" });

      // Step 6: Verify overlay hides
      await waitFor(() => {
        expect(shortcutsStore.shortcutModeActive.value).toBe(false);
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
      fireV2Event("ui:mode-changed", { mode: "shortcut", previousMode: "workspace" });
      await waitFor(() => {
        expect(shortcutsStore.shortcutModeActive.value).toBe(true);
      });

      // Fire shortcut key events (keys now come from main process via onShortcut)
      fireV2Event("shortcut:key", "1");
      await waitFor(() => {
        expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith(
          actualProjectId,
          workspaces[0]!.name,
          false
        );
      });

      // Clear and fire key "2"
      mockApi.ui.switchWorkspace.mockClear();
      fireV2Event("shortcut:key", "2");

      await waitFor(() => {
        expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith(
          actualProjectId,
          workspaces[1]!.name,
          false
        );
      });

      // Verify overlay is still visible
      expect(shortcutsStore.shortcutModeActive.value).toBe(true);
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
      fireV2Event("workspace:switched", {
        projectId: actualProjectId,
        workspaceName: ws.name,
        path: ws.path,
      });
      await waitFor(() => {
        expect(projectsStore.activeWorkspacePath.value).toBe(ws.path);
      });

      // Activate shortcut mode
      fireV2Event("ui:mode-changed", { mode: "shortcut", previousMode: "workspace" });
      await waitFor(() => {
        expect(shortcutsStore.shortcutModeActive.value).toBe(true);
      });

      // Fire Enter shortcut key to open create dialog
      fireV2Event("shortcut:key", "enter");

      // Verify dialog opens
      await waitFor(() => {
        expect(screen.getByRole("dialog")).toBeInTheDocument();
        expect(screen.getByText("Create Workspace")).toBeInTheDocument();
      });

      // Verify shortcut mode deactivated
      expect(shortcutsStore.shortcutModeActive.value).toBe(false);
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
      fireV2Event("workspace:switched", {
        projectId: actualProjectId,
        workspaceName: ws2.name,
        path: ws2.path,
      });
      await waitFor(() => {
        expect(projectsStore.activeWorkspacePath.value).toBe(ws2.path);
      });

      mockApi.ui.switchWorkspace.mockClear();

      // Activate shortcut mode
      fireV2Event("ui:mode-changed", { mode: "shortcut", previousMode: "workspace" });

      // Fire ArrowDown shortcut key (should wrap to first)
      fireV2Event("shortcut:key", "down");

      await waitFor(() => {
        expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith(actualProjectId, ws1.name, false);
      });
    });

    it("should-trigger-folder-picker-on-o-key: Alt+X → O → folder picker opens", async () => {
      render(App);

      await waitFor(() => {
        expect(screen.getByText("No projects open.")).toBeInTheDocument();
      });

      mockApi.ui.selectFolder.mockClear();

      // Activate shortcut mode
      fireV2Event("ui:mode-changed", { mode: "shortcut", previousMode: "workspace" });
      await waitFor(() => {
        expect(shortcutsStore.shortcutModeActive.value).toBe(true);
      });

      // Fire O shortcut key
      fireV2Event("shortcut:key", "o");

      // Verify shortcut mode deactivated
      expect(shortcutsStore.shortcutModeActive.value).toBe(false);

      // Verify folder picker called
      await waitFor(() => {
        expect(mockApi.ui.selectFolder).toHaveBeenCalled();
      });
    });

    it("should-handle-no-workspaces-gracefully: no workspaces → only O Open visible", async () => {
      mockApi.projects.list.mockResolvedValue([]);

      render(App);

      await waitFor(() => {
        expect(screen.getByText("No projects open.")).toBeInTheDocument();
      });

      // Activate shortcut mode
      fireV2Event("ui:mode-changed", { mode: "shortcut", previousMode: "workspace" });
      await waitFor(() => {
        expect(shortcutsStore.shortcutModeActive.value).toBe(true);
      });

      // Verify navigate and jump hints are hidden
      const navigateHint = screen.getByLabelText("Up and Down arrows to navigate");
      expect(navigateHint).toHaveClass("shortcut-hint--hidden");

      const jumpHint = screen.getByLabelText("Number keys 1 through 0 to jump");
      expect(jumpHint).toHaveClass("shortcut-hint--hidden");

      // Verify O Open is visible
      const openHint = screen.getByLabelText("O to open project");
      expect(openHint).not.toHaveClass("shortcut-hint--hidden");

      // Pressing arrow should be no-op (fires via shortcut:key event)
      mockApi.ui.switchWorkspace.mockClear();
      fireV2Event("shortcut:key", "down");
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
      fireV2Event("ui:mode-changed", { mode: "shortcut", previousMode: "workspace" });
      await waitFor(() => {
        expect(shortcutsStore.shortcutModeActive.value).toBe(true);
      });

      // Navigate hints should be hidden (single workspace)
      const navigateHint = screen.getByLabelText("Up and Down arrows to navigate");
      expect(navigateHint).toHaveClass("shortcut-hint--hidden");

      // Jump should still work for index 1 (v2 API: projectId, workspaceName, focus)
      fireV2Event("shortcut:key", "1");

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
      fireV2Event("project:opened", { project: emptyProject });

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
        expect(screen.getByText("No projects open.")).toBeInTheDocument();
      });

      // Verify openProject was NOT called
      expect(mockApi.projects.open).not.toHaveBeenCalled();
    });

    it("project-with-workspaces-no-auto-dialog: opening project with workspaces does not auto-open dialog", async () => {
      const existingProject = createProject("existing", [
        createWorkspace("main", "/test/existing"),
      ]);
      mockApi.projects.list.mockResolvedValue([existingProject]);

      render(App);

      // Wait for load
      await waitFor(() => {
        expect(screen.getByText("existing")).toBeInTheDocument();
      });

      // Open another project with workspaces
      const projectPath = "/test/another-project";
      mockApi.ui.selectFolder.mockResolvedValue(projectPath);

      // Click Open Project button
      const openButton = screen.getByRole("button", { name: /open project/i });
      await fireEvent.click(openButton);

      await waitFor(() => {
        expect(mockApi.projects.open).toHaveBeenCalledWith(projectPath);
      });

      // Simulate project:opened with workspaces (v2 format)
      const newProject = createProject("another-project", [
        createWorkspace("develop", "/test/another-project"),
      ]);
      fireV2Event("project:opened", { project: newProject });

      // Verify project is added
      await waitFor(() => {
        expect(screen.getByText("another-project")).toBeInTheDocument();
      });

      // Give time for any auto-open to trigger
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify NO dialog opened
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  describe("CSS theming", () => {
    // Read CSS file for testing variable definitions
    const variablesCss = readCssFile("./styles/variables.css");

    describe("semantic variables defined (Step 1)", () => {
      it("--ch-success is defined with VS Code fallback", () => {
        expect(variablesCss).toContain("--ch-success:");
        expect(variablesCss).toMatch(/--ch-success:.*#4ec9b0/);
      });

      it("--ch-danger is defined with VS Code fallback", () => {
        expect(variablesCss).toContain("--ch-danger:");
        expect(variablesCss).toMatch(/--ch-danger:.*#f14c4c/);
      });

      it("--ch-warning is defined with VS Code fallback", () => {
        expect(variablesCss).toContain("--ch-warning:");
        expect(variablesCss).toMatch(/--ch-warning:.*#cca700/);
      });

      it("--ch-border is defined (used by SetupError)", () => {
        expect(variablesCss).toContain("--ch-border:");
        expect(variablesCss).toMatch(/--ch-border:.*#454545/);
      });

      it("--ch-button-hover-bg is defined (used by SetupError)", () => {
        expect(variablesCss).toContain("--ch-button-hover-bg:");
        expect(variablesCss).toMatch(/--ch-button-hover-bg:.*#1177bb/);
      });

      it("--ch-agent-idle references --ch-success", () => {
        expect(variablesCss).toContain("--ch-agent-idle:");
        expect(variablesCss).toMatch(/--ch-agent-idle:\s*var\(--ch-success\)/);
      });

      it("--ch-agent-busy references --ch-danger", () => {
        expect(variablesCss).toContain("--ch-agent-busy:");
        expect(variablesCss).toMatch(/--ch-agent-busy:\s*var\(--ch-danger\)/);
      });

      it("--ch-overlay-bg is defined with dark theme value", () => {
        expect(variablesCss).toContain("--ch-overlay-bg:");
        expect(variablesCss).toMatch(/--ch-overlay-bg:.*rgba\(0,\s*0,\s*0,\s*0\.5\)/);
      });

      it("--ch-shadow-color is defined", () => {
        expect(variablesCss).toContain("--ch-shadow-color:");
        expect(variablesCss).toMatch(/--ch-shadow-color:.*rgba\(0,\s*0,\s*0/);
      });

      it("--ch-shadow references --ch-shadow-color", () => {
        expect(variablesCss).toContain("--ch-shadow:");
        expect(variablesCss).toMatch(/--ch-shadow:.*var\(--ch-shadow-color\)/);
      });

      it("--ch-list-hover-bg is defined", () => {
        expect(variablesCss).toContain("--ch-list-hover-bg:");
        expect(variablesCss).toMatch(/--ch-list-hover-bg:.*#2a2d2e/);
      });

      it("--ch-input-hover-border is defined", () => {
        expect(variablesCss).toContain("--ch-input-hover-border:");
        expect(variablesCss).toMatch(/--ch-input-hover-border:.*#5a5a5a/);
      });

      it("--ch-button-disabled-bg is defined", () => {
        expect(variablesCss).toContain("--ch-button-disabled-bg:");
        expect(variablesCss).toMatch(/--ch-button-disabled-bg:.*#3c3c3c/);
      });

      it("--ch-button-disabled-fg is defined", () => {
        expect(variablesCss).toContain("--ch-button-disabled-fg:");
        expect(variablesCss).toMatch(/--ch-button-disabled-fg:.*#8c8c8c/);
      });

      it("--ch-input-disabled-bg is defined", () => {
        expect(variablesCss).toContain("--ch-input-disabled-bg:");
        expect(variablesCss).toMatch(/--ch-input-disabled-bg:.*#2d2d2d/);
      });

      it("--ch-input-disabled-fg is defined", () => {
        expect(variablesCss).toContain("--ch-input-disabled-fg:");
        expect(variablesCss).toMatch(/--ch-input-disabled-fg:.*#6c6c6c/);
      });

      it("layout variables are outside media query", () => {
        // Verify layout variables are defined in :root but NOT in media query
        expect(variablesCss).toContain("--ch-sidebar-width:");
        expect(variablesCss).toContain("--ch-dialog-max-width:");
      });
    });

    describe("light theme media query (Step 2)", () => {
      it("has prefers-color-scheme: light media query", () => {
        expect(variablesCss).toMatch(/@media\s*\(\s*prefers-color-scheme:\s*light\s*\)/);
      });

      it("light theme overrides --ch-foreground fallback", () => {
        // Light theme should have different fallback (#3c3c3c instead of #cccccc)
        expect(variablesCss).toMatch(
          /@media\s*\(\s*prefers-color-scheme:\s*light\s*\)[^}]*--ch-foreground:[^;]*#3c3c3c/s
        );
      });

      it("light theme overrides --ch-background fallback", () => {
        expect(variablesCss).toMatch(
          /@media\s*\(\s*prefers-color-scheme:\s*light\s*\)[^}]*--ch-background:[^;]*#ffffff/s
        );
      });

      it("light theme overrides --ch-border fallback", () => {
        expect(variablesCss).toMatch(
          /@media\s*\(\s*prefers-color-scheme:\s*light\s*\)[^}]*--ch-border:[^;]*#e5e5e5/s
        );
      });

      it("light theme overrides --ch-success fallback", () => {
        expect(variablesCss).toMatch(
          /@media\s*\(\s*prefers-color-scheme:\s*light\s*\)[^}]*--ch-success:[^;]*#008000/s
        );
      });

      it("light theme overrides --ch-danger fallback", () => {
        expect(variablesCss).toMatch(
          /@media\s*\(\s*prefers-color-scheme:\s*light\s*\)[^}]*--ch-danger:[^;]*#e51400/s
        );
      });

      it("light theme overrides --ch-overlay-bg fallback", () => {
        expect(variablesCss).toMatch(
          /@media\s*\(\s*prefers-color-scheme:\s*light\s*\)[^}]*--ch-overlay-bg:[^;]*rgba\(0,\s*0,\s*0,\s*0\.4\)/s
        );
      });

      it("layout variables NOT in media query", () => {
        // Extract the media query block
        const mediaMatch = variablesCss.match(
          /@media\s*\(\s*prefers-color-scheme:\s*light\s*\)\s*\{[^}]*\}/s
        );
        const mediaBlock = mediaMatch?.[0] ?? "";
        // Layout variables should NOT be in the media query
        expect(mediaBlock).not.toContain("--ch-sidebar-width");
        expect(mediaBlock).not.toContain("--ch-dialog-max-width");
      });

      it("dark theme defaults when no preference (variables defined in :root)", () => {
        // Verify dark theme values are in main :root block (before any media query)
        const rootMatch = variablesCss.match(/:root\s*\{[^}]+\}/);
        const rootBlock = rootMatch?.[0] ?? "";
        expect(rootBlock).toContain("--ch-foreground");
        expect(rootBlock).toContain("#cccccc"); // dark theme foreground
        expect(rootBlock).toContain("#1e1e1e"); // dark theme background
      });
    });

    describe("global.css light theme compatibility (Step 7)", () => {
      // Read global.css to verify compatibility
      const globalCss = readCssFile("./styles/global.css");

      it("body background uses transparent (does not override theme)", () => {
        expect(globalCss).toMatch(/background:\s*transparent/);
      });

      it("body uses var(--ch-foreground) for text color", () => {
        expect(globalCss).toMatch(/color:\s*var\(--ch-foreground\)/);
      });

      it("focus-visible uses var(--ch-focus-border)", () => {
        expect(globalCss).toMatch(/:focus-visible[^{]*\{[^}]*var\(--ch-focus-border\)/);
      });
    });
  });

  describe("setup flow integration", () => {
    it("routes-to-mainview-when-ready: lifecycle.getState returns 'ready', MainView mounts and calls listProjects", async () => {
      mockApi.lifecycle.getState.mockResolvedValue("ready");
      mockApi.projects.list.mockResolvedValue([]);

      render(App);

      // Wait for MainView to mount and call listProjects (v2 API)
      await waitFor(() => {
        expect(mockApi.projects.list).toHaveBeenCalled();
      });

      // Verify we're in normal app mode (empty state shown)
      await waitFor(() => {
        expect(screen.getByText("No projects open.")).toBeInTheDocument();
      });
    });

    it("routes-to-setupscreen-when-setup: lifecycle.getState returns 'setup', SetupScreen shown", async () => {
      mockApi.lifecycle.getState.mockResolvedValue("setup");
      // Keep setup running indefinitely
      mockApi.lifecycle.setup.mockReturnValue(new Promise(() => {}));

      render(App);

      // Wait for setup screen to appear
      await waitFor(() => {
        expect(screen.getByText("Setting up VSCode...")).toBeInTheDocument();
      });

      // Verify v2.projects.list was NOT called (we're in setup mode)
      expect(mockApi.projects.list).not.toHaveBeenCalled();
    });

    // Note: setup completion transition is tested in App.test.ts with proper mock setup
    // The integration test focuses on the routing behavior verified above

    it("does-not-call-listProjects-during-setup: IPC calls deferred until MainView mounts", async () => {
      mockApi.lifecycle.getState.mockResolvedValue("setup");
      // Keep setup running indefinitely
      mockApi.lifecycle.setup.mockReturnValue(new Promise(() => {}));

      render(App);

      // Wait for setup screen
      await waitFor(() => {
        expect(screen.getByText("Setting up VSCode...")).toBeInTheDocument();
      });

      // Verify no domain IPC calls during setup
      expect(mockApi.projects.list).not.toHaveBeenCalled();
    });

    it("setup-success-triggers-mainview-mount: lifecycle.setup success triggers MainView mount", async () => {
      // Start in setup mode
      mockApi.lifecycle.getState.mockResolvedValue("setup");
      mockApi.projects.list.mockResolvedValue([]);
      // Setup completes successfully
      mockApi.lifecycle.setup.mockResolvedValue({ success: true });

      render(App);

      // Wait for SetupComplete screen to show (setup completes quickly)
      await waitFor(() => {
        expect(screen.getByText("Setup complete!")).toBeInTheDocument();
      });

      // The SetupComplete timer will transition to MainView
      // After transition, MainView should call v2.projects.list
      await waitFor(
        () => {
          expect(mockApi.projects.list).toHaveBeenCalled();
        },
        { timeout: 3000 }
      ); // Allow time for the 1.5s success screen
    });

    it("handlers-registered-before-lifecycle-getState-returns: normal handlers available when setup is complete", async () => {
      // This test verifies that when lifecycle.getState returns "ready",
      // the IPC handlers that MainView needs are already registered.
      // We can verify this by checking that v2.projects.list succeeds.
      mockApi.lifecycle.getState.mockResolvedValue("ready");
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
