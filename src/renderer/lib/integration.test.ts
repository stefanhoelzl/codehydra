/**
 * Integration tests for the UI layer.
 * Tests complete user flows from interaction through IPC events to UI updates.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/svelte";
import type { Unsubscribe } from "@shared/electron-api";
import type {
  Project,
  ProjectPath,
  Workspace,
  WorkspacePath,
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

function asWorkspacePath(path: string): WorkspacePath {
  return path as WorkspacePath;
}

// Event callback storage
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
  getAgentStatus: vi.fn().mockResolvedValue({ status: "none", counts: { idle: 0, busy: 0 } }),
  getAllAgentStatuses: vi.fn().mockResolvedValue({}),
  refreshAgentStatus: vi.fn().mockResolvedValue(undefined),
  onProjectOpened: vi.fn((cb: (e: ProjectOpenedEvent) => void): Unsubscribe => {
    callbacks.onProjectOpened = cb;
    return vi.fn();
  }),
  onProjectClosed: vi.fn((cb: (e: ProjectClosedEvent) => void): Unsubscribe => {
    callbacks.onProjectClosed = cb;
    return vi.fn();
  }),
  onWorkspaceCreated: vi.fn((cb: (e: WorkspaceCreatedEvent) => void): Unsubscribe => {
    callbacks.onWorkspaceCreated = cb;
    return vi.fn();
  }),
  onWorkspaceRemoved: vi.fn((cb: (e: WorkspaceRemovedEvent) => void): Unsubscribe => {
    callbacks.onWorkspaceRemoved = cb;
    return vi.fn();
  }),
  onWorkspaceSwitched: vi.fn((cb: (e: WorkspaceSwitchedEvent) => void): Unsubscribe => {
    callbacks.onWorkspaceSwitched = cb;
    return vi.fn();
  }),
  onShortcutEnable: vi.fn((cb: () => void): Unsubscribe => {
    callbacks.onShortcutEnable = cb;
    return vi.fn();
  }),
  onShortcutDisable: vi.fn((cb: () => void): Unsubscribe => {
    callbacks.onShortcutDisable = cb;
    return vi.fn();
  }),
  onAgentStatusChanged: vi.fn((): Unsubscribe => {
    return vi.fn();
  }),
  focusActiveWorkspace: vi.fn().mockResolvedValue(undefined),
}));

// Mock the API module
vi.mock("$lib/api", () => mockApi);

// Import after mock setup
import App from "../App.svelte";
import * as projectsStore from "$lib/stores/projects.svelte.js";
import * as dialogsStore from "$lib/stores/dialogs.svelte.js";
import * as shortcutsStore from "$lib/stores/shortcuts.svelte.js";
import * as agentStatusStore from "$lib/stores/agent-status.svelte.js";

// Helper to create mock workspace
function createWorkspace(name: string, projectPath: string): Workspace {
  return {
    name,
    path: `${projectPath}/.worktrees/${name}`,
    branch: name,
  };
}

// Helper to create mock project
function createProject(name: string, workspaces: Workspace[] = []): Project {
  return {
    path: asProjectPath(`/test/${name}`),
    name,
    workspaces,
  };
}

describe("Integration tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projectsStore.reset();
    dialogsStore.reset();
    shortcutsStore.reset();
    agentStatusStore.reset();

    // Reset callbacks
    callbacks.onProjectOpened = null;
    callbacks.onProjectClosed = null;
    callbacks.onWorkspaceCreated = null;
    callbacks.onWorkspaceRemoved = null;
    callbacks.onWorkspaceSwitched = null;
    callbacks.onShortcutEnable = null;
    callbacks.onShortcutDisable = null;

    // Default mocks
    mockApi.listProjects.mockResolvedValue([]);
    mockApi.listBases.mockResolvedValue([
      { name: "main", isRemote: false },
      { name: "develop", isRemote: false },
    ]);
    mockApi.isWorkspaceDirty.mockResolvedValue(false);
    mockApi.getAllAgentStatuses.mockResolvedValue({});
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  describe("happy paths", () => {
    it("open project: selectFolder returns path → openProject → project:opened event → UI shows project in sidebar", async () => {
      const projectPath = "/test/my-project";
      mockApi.selectFolder.mockResolvedValue(projectPath);

      render(App);

      // Wait for initial load
      await waitFor(() => {
        expect(screen.getByText("No projects open.")).toBeInTheDocument();
      });

      // Click Open Project button
      const openButton = screen.getByRole("button", { name: /open project/i });
      await fireEvent.click(openButton);

      // Verify selectFolder was called
      await waitFor(() => {
        expect(mockApi.selectFolder).toHaveBeenCalledTimes(1);
      });

      // Verify openProject was called with the path
      await waitFor(() => {
        expect(mockApi.openProject).toHaveBeenCalledWith(projectPath);
      });

      // Simulate project:opened event
      const newProject = createProject("my-project", [createWorkspace("main", projectPath)]);
      callbacks.onProjectOpened!({ project: newProject });

      // Verify project appears in sidebar
      await waitFor(() => {
        expect(screen.getByText("my-project")).toBeInTheDocument();
      });
    });

    it("close project: click [×] → closeProject → project:closed event → project removed from sidebar", async () => {
      const project = createProject("my-project", [createWorkspace("main", "/test/my-project")]);
      mockApi.listProjects.mockResolvedValue([project]);

      render(App);

      // Wait for project to appear
      await waitFor(() => {
        expect(screen.getByText("my-project")).toBeInTheDocument();
      });

      // Click close project button
      const closeButton = screen.getByLabelText(/close project/i);
      await fireEvent.click(closeButton);

      // Verify closeProject was called
      await waitFor(() => {
        expect(mockApi.closeProject).toHaveBeenCalledWith(project.path);
      });

      // Simulate project:closed event
      callbacks.onProjectClosed!({ path: project.path });

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
      mockApi.listProjects.mockResolvedValue([project]);

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

      // Verify the dialog has a name input and branch dropdown
      expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
      expect(screen.getByRole("combobox")).toBeInTheDocument();

      // Simulate workspace:created event (as if creation succeeded via IPC)
      const newWorkspace = createWorkspace("feature-x", "/test/my-project");
      callbacks.onWorkspaceCreated!({
        projectPath: project.path,
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
      mockApi.listProjects.mockResolvedValue([project]);

      render(App);

      // Wait for workspace to appear
      await waitFor(() => {
        expect(screen.getByText("feature-x")).toBeInTheDocument();
      });

      // Click remove workspace button (use getByRole to target the button specifically)
      const removeButton = screen.getByRole("button", { name: /remove workspace/i });
      await fireEvent.click(removeButton);

      // Verify dialog opens
      await waitFor(() => {
        expect(screen.getByRole("dialog")).toBeInTheDocument();
        expect(screen.getByText("Remove Workspace")).toBeInTheDocument();
      });

      // Confirm removal - use the dialog's Remove button (not the sidebar one)
      mockApi.removeWorkspace.mockResolvedValue(undefined);
      const dialog = screen.getByRole("dialog");
      const removeConfirmButton = dialog.querySelector("button.ok-button") as HTMLButtonElement;
      await fireEvent.click(removeConfirmButton);

      // Verify removeWorkspace was called with correct params
      await waitFor(() => {
        expect(mockApi.removeWorkspace).toHaveBeenCalledWith(
          workspace.path,
          true // deleteBranch is checked by default
        );
      });

      // Simulate workspace:removed event
      callbacks.onWorkspaceRemoved!({
        projectPath: project.path,
        workspacePath: asWorkspacePath(workspace.path),
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
      mockApi.listProjects.mockResolvedValue([project]);

      render(App);

      // Wait for workspaces to appear
      await waitFor(() => {
        expect(screen.getByText("main")).toBeInTheDocument();
        expect(screen.getByText("feature-x")).toBeInTheDocument();
      });

      // Click on feature-x workspace
      const featureButton = screen.getByRole("button", { name: "feature-x" });
      await fireEvent.click(featureButton);

      // Verify switchWorkspace was called
      await waitFor(() => {
        expect(mockApi.switchWorkspace).toHaveBeenCalledWith(ws2.path);
      });

      // Simulate workspace:switched event
      callbacks.onWorkspaceSwitched!({
        workspacePath: asWorkspacePath(ws2.path),
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
      mockApi.selectFolder.mockResolvedValue(null);

      render(App);

      await waitFor(() => {
        expect(screen.getByText("No projects open.")).toBeInTheDocument();
      });

      const openButton = screen.getByRole("button", { name: /open project/i });
      await fireEvent.click(openButton);

      await waitFor(() => {
        expect(mockApi.selectFolder).toHaveBeenCalledTimes(1);
      });

      // openProject should NOT be called
      expect(mockApi.openProject).not.toHaveBeenCalled();

      // UI should remain unchanged
      expect(screen.getByText("No projects open.")).toBeInTheDocument();
    });

    it("API rejection during load → loadingState is 'error', loadingError has message", async () => {
      mockApi.listProjects.mockRejectedValue(new Error("Database connection failed"));

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
      mockApi.listProjects.mockResolvedValue([project]);

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

      // Verify dialog opened with correct context (has name input and branch dropdown)
      expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
      expect(screen.getByRole("combobox")).toBeInTheDocument();
    });

    it("removeWorkspace rejects → error shown in dialog, form re-enabled", async () => {
      const workspace = createWorkspace("feature-x", "/test/my-project");
      const project = createProject("my-project", [workspace]);
      mockApi.listProjects.mockResolvedValue([project]);

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

      // Make removeWorkspace fail
      mockApi.removeWorkspace.mockRejectedValue(new Error("Workspace has uncommitted changes"));

      // Use the dialog's Remove button
      const dialog = screen.getByRole("dialog");
      const removeConfirmButton = dialog.querySelector("button.ok-button") as HTMLButtonElement;
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
    it("calls api.setDialogMode(true) when dialog opens", async () => {
      const project = createProject("my-project", [createWorkspace("main", "/test/my-project")]);
      mockApi.listProjects.mockResolvedValue([project]);

      render(App);

      // Wait for initial load
      await waitFor(() => {
        expect(screen.getByText("my-project")).toBeInTheDocument();
      });

      // Clear any calls from initialization
      mockApi.setDialogMode.mockClear();

      // Open create dialog
      const addButton = screen.getByLabelText(/add workspace/i);
      await fireEvent.click(addButton);

      // Wait for dialog to appear
      await waitFor(() => {
        expect(screen.getByRole("dialog")).toBeInTheDocument();
      });

      // Verify setDialogMode was called with true
      expect(mockApi.setDialogMode).toHaveBeenCalledWith(true);
    });

    it("calls api.setDialogMode(false) when dialog closes", async () => {
      const project = createProject("my-project", [createWorkspace("main", "/test/my-project")]);
      mockApi.listProjects.mockResolvedValue([project]);

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
      mockApi.setDialogMode.mockClear();

      // Close dialog via Cancel button
      const cancelButton = screen.getByRole("button", { name: /cancel/i });
      await fireEvent.click(cancelButton);

      // Wait for dialog to close
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      });

      // Verify setDialogMode was called with false
      expect(mockApi.setDialogMode).toHaveBeenCalledWith(false);
    });

    it("handles api.setDialogMode failure gracefully", async () => {
      const project = createProject("my-project", [createWorkspace("main", "/test/my-project")]);
      mockApi.listProjects.mockResolvedValue([project]);
      mockApi.setDialogMode.mockRejectedValue(new Error("IPC failed"));

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
  });

  describe("state consistency", () => {
    it("projects store matches sidebar display at all times", async () => {
      const project = createProject("my-project", [
        createWorkspace("main", "/test/my-project"),
        createWorkspace("feature-x", "/test/my-project"),
      ]);
      mockApi.listProjects.mockResolvedValue([project]);

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

      // Add another project via event
      const newProject = createProject("new-project", [
        createWorkspace("develop", "/test/new-project"),
      ]);
      callbacks.onProjectOpened!({ project: newProject });

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
      mockApi.listProjects.mockResolvedValue([project]);

      render(App);

      await waitFor(() => {
        expect(screen.getByText("main")).toBeInTheDocument();
      });

      // Initially no active workspace
      expect(projectsStore.activeWorkspacePath.value).toBeNull();
      expect(screen.queryByRole("listitem", { current: true })).toBeNull();

      // Set active workspace via event
      callbacks.onWorkspaceSwitched!({
        workspacePath: asWorkspacePath(ws1.path),
      });

      await waitFor(() => {
        expect(projectsStore.activeWorkspacePath.value).toBe(ws1.path);
      });

      const mainItem = screen.getByText("main").closest("li");
      expect(mainItem).toHaveAttribute("aria-current", "true");

      // Switch to another workspace
      callbacks.onWorkspaceSwitched!({
        workspacePath: asWorkspacePath(ws2.path),
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
      mockApi.setDialogMode.mockClear();
      mockApi.focusActiveWorkspace.mockClear();

      // Verify overlay exists but is initially inactive (opacity 0)
      // Use { hidden: true } because aria-hidden="true" excludes from accessible tree
      const overlay = screen.getByRole("status", { hidden: true });
      expect(overlay).toHaveClass("shortcut-overlay");
      expect(overlay).not.toHaveClass("active");

      // Step 1: Simulate shortcut enable event (Alt+X pressed)
      callbacks.onShortcutEnable!();

      // Step 2: Verify overlay becomes active
      await waitFor(() => {
        expect(overlay).toHaveClass("active");
      });
      expect(shortcutsStore.shortcutModeActive.value).toBe(true);

      // Step 3: Simulate Alt keyup event
      await fireEvent.keyUp(window, { key: "Alt" });

      // Step 4: Verify overlay becomes inactive
      await waitFor(() => {
        expect(overlay).not.toHaveClass("active");
      });
      expect(shortcutsStore.shortcutModeActive.value).toBe(false);

      // Step 5: Verify APIs were called
      expect(mockApi.setDialogMode).toHaveBeenCalledWith(false);
      expect(mockApi.focusActiveWorkspace).toHaveBeenCalled();
    });
  });

  describe("keyboard action flows", () => {
    it("should-complete-full-shortcut-flow-activate-action-release: Alt+X → ↓ → workspace switches → release Alt → overlay hides", async () => {
      const ws1 = createWorkspace("main", "/test/my-project");
      const ws2 = createWorkspace("feature", "/test/my-project");
      const project = createProject("my-project", [ws1, ws2]);
      mockApi.listProjects.mockResolvedValue([project]);

      render(App);

      // Wait for load
      await waitFor(() => {
        expect(screen.getByText("main")).toBeInTheDocument();
        expect(screen.getByText("feature")).toBeInTheDocument();
      });

      // Set active workspace
      callbacks.onWorkspaceSwitched!({ workspacePath: asWorkspacePath(ws1.path) });
      await waitFor(() => {
        expect(projectsStore.activeWorkspacePath.value).toBe(ws1.path);
      });

      // Clear mocks
      mockApi.switchWorkspace.mockClear();

      // Step 1: Activate shortcut mode
      callbacks.onShortcutEnable!();
      await waitFor(() => {
        expect(shortcutsStore.shortcutModeActive.value).toBe(true);
      });

      // Step 2: Press ArrowDown
      await fireEvent.keyDown(window, { key: "ArrowDown" });

      // Step 3: Verify workspace switch was called with focusWorkspace=false to keep shortcut mode active
      await waitFor(() => {
        expect(mockApi.switchWorkspace).toHaveBeenCalledWith(ws2.path, false);
      });

      // Step 4: Verify overlay is still active
      expect(shortcutsStore.shortcutModeActive.value).toBe(true);

      // Step 5: Release Alt
      await fireEvent.keyUp(window, { key: "Alt" });

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
      mockApi.listProjects.mockResolvedValue([project]);

      render(App);

      // Wait for load
      await waitFor(() => {
        expect(screen.getByText("ws1")).toBeInTheDocument();
      });

      // Activate shortcut mode
      callbacks.onShortcutEnable!();
      await waitFor(() => {
        expect(shortcutsStore.shortcutModeActive.value).toBe(true);
      });

      // Press 1 then wait for it to complete
      await fireEvent.keyDown(window, { key: "1" });
      await waitFor(() => {
        expect(mockApi.switchWorkspace).toHaveBeenCalledWith(workspaces[0]!.path, false);
      });

      // Clear and press 2
      mockApi.switchWorkspace.mockClear();
      await fireEvent.keyDown(window, { key: "2" });

      await waitFor(() => {
        expect(mockApi.switchWorkspace).toHaveBeenCalledWith(workspaces[1]!.path, false);
      });

      // Verify overlay is still visible
      expect(shortcutsStore.shortcutModeActive.value).toBe(true);
    });

    it("should-open-dialog-and-hide-overlay: Alt+X → Enter → dialog opens, overlay hides", async () => {
      const ws = createWorkspace("main", "/test/my-project");
      const project = createProject("my-project", [ws]);
      mockApi.listProjects.mockResolvedValue([project]);

      render(App);

      // Wait for load
      await waitFor(() => {
        expect(screen.getByText("my-project")).toBeInTheDocument();
      });

      // Set active workspace so activeProject is available
      callbacks.onWorkspaceSwitched!({ workspacePath: asWorkspacePath(ws.path) });
      await waitFor(() => {
        expect(projectsStore.activeWorkspacePath.value).toBe(ws.path);
      });

      // Activate shortcut mode
      callbacks.onShortcutEnable!();
      await waitFor(() => {
        expect(shortcutsStore.shortcutModeActive.value).toBe(true);
      });

      // Press Enter to open create dialog
      await fireEvent.keyDown(window, { key: "Enter" });

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
      mockApi.listProjects.mockResolvedValue([project]);

      render(App);

      await waitFor(() => {
        expect(screen.getByText("first")).toBeInTheDocument();
      });

      // Set active to last workspace
      callbacks.onWorkspaceSwitched!({ workspacePath: asWorkspacePath(ws2.path) });
      await waitFor(() => {
        expect(projectsStore.activeWorkspacePath.value).toBe(ws2.path);
      });

      mockApi.switchWorkspace.mockClear();

      // Activate shortcut mode
      callbacks.onShortcutEnable!();

      // Press ArrowDown (should wrap to first)
      await fireEvent.keyDown(window, { key: "ArrowDown" });

      await waitFor(() => {
        expect(mockApi.switchWorkspace).toHaveBeenCalledWith(ws1.path, false);
      });
    });

    it("should-trigger-folder-picker-on-o-key: Alt+X → O → folder picker opens", async () => {
      render(App);

      await waitFor(() => {
        expect(screen.getByText("No projects open.")).toBeInTheDocument();
      });

      mockApi.selectFolder.mockClear();

      // Activate shortcut mode
      callbacks.onShortcutEnable!();
      await waitFor(() => {
        expect(shortcutsStore.shortcutModeActive.value).toBe(true);
      });

      // Press O
      await fireEvent.keyDown(window, { key: "o" });

      // Verify shortcut mode deactivated
      expect(shortcutsStore.shortcutModeActive.value).toBe(false);

      // Verify folder picker called
      await waitFor(() => {
        expect(mockApi.selectFolder).toHaveBeenCalled();
      });
    });

    it("should-handle-no-workspaces-gracefully: no workspaces → only O Open visible", async () => {
      mockApi.listProjects.mockResolvedValue([]);

      render(App);

      await waitFor(() => {
        expect(screen.getByText("No projects open.")).toBeInTheDocument();
      });

      // Activate shortcut mode
      callbacks.onShortcutEnable!();
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

      // Pressing arrow should be no-op
      mockApi.switchWorkspace.mockClear();
      await fireEvent.keyDown(window, { key: "ArrowDown" });
      expect(mockApi.switchWorkspace).not.toHaveBeenCalled();
    });

    it("should-handle-single-workspace-gracefully: single workspace → navigate hints hidden, jump works for index 1", async () => {
      const ws = createWorkspace("only", "/test/my-project");
      const project = createProject("my-project", [ws]);
      mockApi.listProjects.mockResolvedValue([project]);

      render(App);

      await waitFor(() => {
        expect(screen.getByText("only")).toBeInTheDocument();
      });

      // Activate shortcut mode
      callbacks.onShortcutEnable!();
      await waitFor(() => {
        expect(shortcutsStore.shortcutModeActive.value).toBe(true);
      });

      // Navigate hints should be hidden (single workspace)
      const navigateHint = screen.getByLabelText("Up and Down arrows to navigate");
      expect(navigateHint).toHaveClass("shortcut-hint--hidden");

      // Jump should still work for index 1
      await fireEvent.keyDown(window, { key: "1" });

      await waitFor(() => {
        expect(mockApi.switchWorkspace).toHaveBeenCalledWith(ws.path, false);
      });
    });
  });
});
