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
  listProjects: vi.fn().mockResolvedValue({ projects: [], activeWorkspacePath: null }),
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
  // Setup API mocks
  setupReady: vi.fn().mockResolvedValue({ ready: true }),
  setupRetry: vi.fn().mockResolvedValue(undefined),
  setupQuit: vi.fn().mockResolvedValue(undefined),
  onSetupProgress: vi.fn((): Unsubscribe => vi.fn()),
  onSetupComplete: vi.fn((): Unsubscribe => vi.fn()),
  onSetupError: vi.fn((): Unsubscribe => vi.fn()),
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
    mockApi.listProjects.mockResolvedValue({ projects: [], activeWorkspacePath: null });
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
      // Start with an existing project to avoid auto-open picker
      const existingProject = createProject("existing", [
        createWorkspace("main", "/test/existing"),
      ]);
      mockApi.listProjects.mockResolvedValue({
        projects: [existingProject],
        activeWorkspacePath: null,
      });

      const projectPath = "/test/my-project";
      mockApi.selectFolder.mockResolvedValue(projectPath);

      render(App);

      // Wait for initial load
      await waitFor(() => {
        expect(screen.getByText("existing")).toBeInTheDocument();
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

      // Verify new project appears in sidebar
      await waitFor(() => {
        expect(screen.getByText("my-project")).toBeInTheDocument();
      });
    });

    it("close project: click [×] → closeProject → project:closed event → project removed from sidebar", async () => {
      const project = createProject("my-project", [createWorkspace("main", "/test/my-project")]);
      mockApi.listProjects.mockResolvedValue({ projects: [project], activeWorkspacePath: null });

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
      mockApi.listProjects.mockResolvedValue({ projects: [project], activeWorkspacePath: null });

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
      mockApi.listProjects.mockResolvedValue({ projects: [project], activeWorkspacePath: null });

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
      mockApi.listProjects.mockResolvedValue({ projects: [project], activeWorkspacePath: null });

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
      // Start with an existing project to avoid auto-open picker
      const existingProject = createProject("existing", [
        createWorkspace("main", "/test/existing"),
      ]);
      mockApi.listProjects.mockResolvedValue({
        projects: [existingProject],
        activeWorkspacePath: null,
      });

      mockApi.selectFolder.mockResolvedValue(null);

      render(App);

      await waitFor(() => {
        expect(screen.getByText("existing")).toBeInTheDocument();
      });

      const openButton = screen.getByRole("button", { name: /open project/i });
      await fireEvent.click(openButton);

      await waitFor(() => {
        expect(mockApi.selectFolder).toHaveBeenCalledTimes(1);
      });

      // openProject should NOT be called
      expect(mockApi.openProject).not.toHaveBeenCalled();

      // Existing project should still be shown
      expect(screen.getByText("existing")).toBeInTheDocument();
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
      mockApi.listProjects.mockResolvedValue({ projects: [project], activeWorkspacePath: null });

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
      mockApi.listProjects.mockResolvedValue({ projects: [project], activeWorkspacePath: null });

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
      mockApi.listProjects.mockResolvedValue({ projects: [project], activeWorkspacePath: null });

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
      mockApi.listProjects.mockResolvedValue({ projects: [project], activeWorkspacePath: null });

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
      mockApi.listProjects.mockResolvedValue({ projects: [project], activeWorkspacePath: null });
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

    it("focuses active workspace when dialog closes", async () => {
      const workspace = createWorkspace("main", "/test/my-project");
      const project = createProject("my-project", [workspace]);
      mockApi.listProjects.mockResolvedValue({
        projects: [project],
        activeWorkspacePath: asWorkspacePath(workspace.path),
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
      mockApi.setDialogMode.mockClear();
      mockApi.focusActiveWorkspace.mockClear();

      // Close dialog via Cancel button
      const cancelButton = screen.getByRole("button", { name: /cancel/i });
      await fireEvent.click(cancelButton);

      // Wait for dialog to close
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      });

      // Verify both setDialogMode(false) AND focusActiveWorkspace() were called
      expect(mockApi.setDialogMode).toHaveBeenCalledWith(false);
      expect(mockApi.focusActiveWorkspace).toHaveBeenCalled();
    });

    it("does NOT focus workspace when dialog closes and no active workspace", async () => {
      const project = createProject("my-project", [createWorkspace("main", "/test/my-project")]);
      mockApi.listProjects.mockResolvedValue({
        projects: [project],
        activeWorkspacePath: null, // No active workspace
      });

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
      mockApi.setDialogMode.mockClear();
      mockApi.focusActiveWorkspace.mockClear();

      // Close dialog via Cancel button
      const cancelButton = screen.getByRole("button", { name: /cancel/i });
      await fireEvent.click(cancelButton);

      // Wait for dialog to close
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      });

      // Verify setDialogMode(false) was called but NOT focusActiveWorkspace()
      expect(mockApi.setDialogMode).toHaveBeenCalledWith(false);
      expect(mockApi.focusActiveWorkspace).not.toHaveBeenCalled();
    });
  });

  describe("state consistency", () => {
    it("projects store matches sidebar display at all times", async () => {
      const project = createProject("my-project", [
        createWorkspace("main", "/test/my-project"),
        createWorkspace("feature-x", "/test/my-project"),
      ]);
      mockApi.listProjects.mockResolvedValue({ projects: [project], activeWorkspacePath: null });

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
      mockApi.listProjects.mockResolvedValue({ projects: [project], activeWorkspacePath: null });

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
      mockApi.listProjects.mockResolvedValue({ projects: [project], activeWorkspacePath: null });

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
      mockApi.listProjects.mockResolvedValue({ projects: [project], activeWorkspacePath: null });

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
      mockApi.listProjects.mockResolvedValue({ projects: [project], activeWorkspacePath: null });

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
      mockApi.listProjects.mockResolvedValue({ projects: [project], activeWorkspacePath: null });

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
      mockApi.listProjects.mockResolvedValue({ projects: [], activeWorkspacePath: null });

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
      mockApi.listProjects.mockResolvedValue({ projects: [project], activeWorkspacePath: null });

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

  describe("onboarding flow", () => {
    it("complete-onboarding-flow: empty state → auto-open picker → select folder → project with 0 workspaces → auto-open create dialog", async () => {
      // Start with no projects (empty state)
      mockApi.listProjects.mockResolvedValue({ projects: [], activeWorkspacePath: null });

      // Defer folder selection to simulate user selecting a folder
      let folderPromiseResolve: (value: string | null) => void = () => {};
      mockApi.selectFolder.mockImplementation(() => {
        return new Promise((resolve) => {
          folderPromiseResolve = resolve;
        });
      });

      render(App);

      // Wait for MainView to load (should see EmptyState briefly, then folder picker auto-opens)
      await waitFor(() => {
        expect(mockApi.listProjects).toHaveBeenCalled();
      });

      // Verify folder picker was automatically triggered (auto-open on empty state)
      await waitFor(() => {
        expect(mockApi.selectFolder).toHaveBeenCalledTimes(1);
      });

      // Simulate user selecting a folder
      const selectedPath = "/test/new-project";
      folderPromiseResolve(selectedPath);

      // Verify openProject was called with the selected path
      await waitFor(() => {
        expect(mockApi.openProject).toHaveBeenCalledWith(selectedPath);
      });

      // Simulate project:opened event with a project that has NO workspaces
      const emptyProject = createProject("new-project", []);
      callbacks.onProjectOpened!({ project: emptyProject });

      // Verify create workspace dialog auto-opens because project has 0 workspaces
      await waitFor(() => {
        expect(screen.getByRole("dialog")).toBeInTheDocument();
        expect(screen.getByText("Create Workspace")).toBeInTheDocument();
      });

      // Verify dialog is for the correct project
      expect(dialogsStore.dialogState.value.type).toBe("create");
      if (dialogsStore.dialogState.value.type === "create") {
        expect(dialogsStore.dialogState.value.projectPath).toBe("/test/new-project");
      }
    });

    it("auto-open-picker-cancelled: empty state → picker cancelled → EmptyState shown", async () => {
      mockApi.listProjects.mockResolvedValue({ projects: [], activeWorkspacePath: null });
      mockApi.selectFolder.mockResolvedValue(null); // User cancels

      render(App);

      // Wait for auto-open
      await waitFor(() => {
        expect(mockApi.selectFolder).toHaveBeenCalled();
      });

      // Verify EmptyState is shown after cancel
      await waitFor(() => {
        expect(screen.getByText("No projects open.")).toBeInTheDocument();
      });

      // Verify openProject was NOT called
      expect(mockApi.openProject).not.toHaveBeenCalled();
    });

    it("project-with-workspaces-no-auto-dialog: opening project with workspaces does not auto-open dialog", async () => {
      const existingProject = createProject("existing", [
        createWorkspace("main", "/test/existing"),
      ]);
      mockApi.listProjects.mockResolvedValue({
        projects: [existingProject],
        activeWorkspacePath: null,
      });

      render(App);

      // Wait for load
      await waitFor(() => {
        expect(screen.getByText("existing")).toBeInTheDocument();
      });

      // Open another project with workspaces
      const projectPath = "/test/another-project";
      mockApi.selectFolder.mockResolvedValue(projectPath);

      // Click Open Project button
      const openButton = screen.getByRole("button", { name: /open project/i });
      await fireEvent.click(openButton);

      await waitFor(() => {
        expect(mockApi.openProject).toHaveBeenCalledWith(projectPath);
      });

      // Simulate project:opened with workspaces
      const newProject = createProject("another-project", [
        createWorkspace("develop", "/test/another-project"),
      ]);
      callbacks.onProjectOpened!({ project: newProject });

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
    it("routes-to-mainview-when-ready-true: setupReady returns ready, MainView mounts and calls listProjects", async () => {
      mockApi.setupReady.mockResolvedValue({ ready: true });
      mockApi.listProjects.mockResolvedValue({ projects: [], activeWorkspacePath: null });

      render(App);

      // Wait for MainView to mount and call listProjects
      await waitFor(() => {
        expect(mockApi.listProjects).toHaveBeenCalled();
      });

      // Verify we're in normal app mode (empty state shown)
      await waitFor(() => {
        expect(screen.getByText("No projects open.")).toBeInTheDocument();
      });
    });

    it("routes-to-setupscreen-when-ready-false: setupReady returns not ready, SetupScreen shown", async () => {
      mockApi.setupReady.mockResolvedValue({ ready: false });

      render(App);

      // Wait for setup screen to appear
      await waitFor(() => {
        expect(screen.getByText("Setting up VSCode...")).toBeInTheDocument();
      });

      // Verify listProjects was NOT called (we're in setup mode)
      expect(mockApi.listProjects).not.toHaveBeenCalled();
    });

    // Note: setup:complete event transition is tested in App.test.ts with proper mock setup
    // The integration test focuses on the routing behavior verified above

    it("does-not-call-listProjects-during-setup: IPC calls deferred until MainView mounts", async () => {
      mockApi.setupReady.mockResolvedValue({ ready: false });

      render(App);

      // Wait for setup screen
      await waitFor(() => {
        expect(screen.getByText("Setting up VSCode...")).toBeInTheDocument();
      });

      // Verify no domain IPC calls during setup
      expect(mockApi.listProjects).not.toHaveBeenCalled();
      expect(mockApi.getAllAgentStatuses).not.toHaveBeenCalled();
    });

    it("complete-event-triggers-mainview-mount-and-initialization: setup:complete triggers MainView mount", async () => {
      // Start in setup mode
      mockApi.setupReady.mockResolvedValue({ ready: false });
      mockApi.listProjects.mockResolvedValue({ projects: [], activeWorkspacePath: null });
      mockApi.getAllAgentStatuses.mockResolvedValue({});

      // Capture the setup complete callback
      let setupCompleteCallback: (() => void) | null = null;
      (
        mockApi.onSetupComplete as unknown as {
          mockImplementation: (fn: (cb: () => void) => Unsubscribe) => void;
        }
      ).mockImplementation((cb) => {
        setupCompleteCallback = cb;
        return vi.fn();
      });

      render(App);

      // Wait for setup screen to appear
      await waitFor(() => {
        expect(screen.getByText("Setting up VSCode...")).toBeInTheDocument();
        expect(setupCompleteCallback).not.toBeNull();
      });

      // Verify IPC hasn't been called yet
      expect(mockApi.listProjects).not.toHaveBeenCalled();

      // Simulate setup complete event
      setupCompleteCallback!();

      // Wait for SetupComplete screen to show
      await waitFor(() => {
        expect(screen.getByText("Setup complete!")).toBeInTheDocument();
      });

      // The SetupComplete timer will transition to MainView
      // After transition, MainView should call listProjects
      await waitFor(
        () => {
          expect(mockApi.listProjects).toHaveBeenCalled();
        },
        { timeout: 3000 }
      ); // Allow time for the 1.5s success screen
    });

    it("handlers-registered-before-setupReady-returns: normal handlers available when setup is complete", async () => {
      // This test verifies that when setupReady returns { ready: true },
      // the IPC handlers that MainView needs are already registered.
      // We can verify this by checking that listProjects succeeds.
      mockApi.setupReady.mockResolvedValue({ ready: true });
      const mockProjects = [
        {
          path: asProjectPath("/test/project"),
          name: "my-project",
          workspaces: [],
        },
      ];
      mockApi.listProjects.mockResolvedValue({ projects: mockProjects, activeWorkspacePath: null });
      mockApi.getAllAgentStatuses.mockResolvedValue({});

      render(App);

      // Wait for MainView to mount and successfully call IPC
      await waitFor(() => {
        expect(mockApi.listProjects).toHaveBeenCalled();
      });

      // Verify the project loaded successfully (no handler-not-registered error)
      await waitFor(() => {
        expect(screen.getByText("my-project")).toBeInTheDocument();
      });
    });
  });
});
