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
import App from "./App.svelte";
import * as projectsStore from "$lib/stores/projects.svelte.js";
import * as dialogsStore from "$lib/stores/dialogs.svelte.js";
import * as shortcutsStore from "$lib/stores/shortcuts.svelte.js";
import * as agentStatusStore from "$lib/stores/agent-status.svelte.js";
import * as setupStore from "$lib/stores/setup.svelte.js";
import type { SetupProgress, SetupErrorPayload } from "@shared/ipc";

describe("App component", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset stores before each test
    projectsStore.reset();
    dialogsStore.reset();
    shortcutsStore.reset();
    agentStatusStore.reset();
    setupStore.resetSetup();
    // Default to returning empty projects
    mockApi.listProjects.mockResolvedValue([]);
    // Default to returning empty agent statuses
    mockApi.getAllAgentStatuses.mockResolvedValue({});
    // Default to setup complete (ready mode)
    mockApi.setupReady.mockResolvedValue({ ready: true });
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

  describe("shortcut mode handling", () => {
    it("should-subscribe-to-shortcut-enable-on-mount: subscribes to onShortcutEnable via $effect", async () => {
      render(App);

      await waitFor(() => {
        expect(mockApi.onShortcutEnable).toHaveBeenCalledTimes(1);
      });
    });

    it("should-subscribe-to-shortcut-disable-on-mount: subscribes to onShortcutDisable via $effect", async () => {
      render(App);

      await waitFor(() => {
        expect(mockApi.onShortcutDisable).toHaveBeenCalledTimes(1);
      });
    });

    it("should-cleanup-subscriptions-on-unmount: unsubscribe called when component unmounts", async () => {
      const unsubShortcutEnable = vi.fn();
      const unsubShortcutDisable = vi.fn();
      mockApi.onShortcutEnable.mockReturnValue(unsubShortcutEnable);
      mockApi.onShortcutDisable.mockReturnValue(unsubShortcutDisable);

      const { unmount } = render(App);

      await waitFor(() => {
        expect(mockApi.onShortcutEnable).toHaveBeenCalled();
        expect(mockApi.onShortcutDisable).toHaveBeenCalled();
      });

      unmount();

      expect(unsubShortcutEnable).toHaveBeenCalledTimes(1);
      expect(unsubShortcutDisable).toHaveBeenCalledTimes(1);
    });

    it("should-render-shortcut-overlay-component: ShortcutOverlay is rendered", async () => {
      render(App);

      // Wait for normal app mode to be active (after listProjects resolves)
      await waitFor(() => {
        // The overlay should be in the DOM when in normal app mode (hidden when inactive)
        // Find the shortcut overlay by its unique class
        const overlay = document.querySelector(".shortcut-overlay");
        expect(overlay).toBeInTheDocument();
        expect(overlay).toHaveAttribute("role", "status");
      });
    });

    it("should-pass-active-prop-to-overlay: overlay shows when shortcut mode active", async () => {
      let shortcutEnableCallback: (() => void) | null = null;
      (
        mockApi.onShortcutEnable as unknown as {
          mockImplementation: (fn: (cb: () => void) => Unsubscribe) => void;
        }
      ).mockImplementation((cb) => {
        shortcutEnableCallback = cb;
        return vi.fn();
      });

      render(App);

      await waitFor(() => {
        expect(shortcutEnableCallback).not.toBeNull();
      });

      // Trigger shortcut enable
      shortcutEnableCallback!();

      // Overlay should now be active (aria-hidden=false)
      await waitFor(() => {
        const overlay = screen.getByRole("status");
        expect(overlay).toHaveClass("active");
      });
    });

    it("should-wire-keyup-handler-to-window: Alt keyup disables shortcut mode", async () => {
      let shortcutEnableCallback: (() => void) | null = null;
      (
        mockApi.onShortcutEnable as unknown as {
          mockImplementation: (fn: (cb: () => void) => Unsubscribe) => void;
        }
      ).mockImplementation((cb) => {
        shortcutEnableCallback = cb;
        return vi.fn();
      });

      render(App);

      await waitFor(() => {
        expect(shortcutEnableCallback).not.toBeNull();
      });

      // Enable shortcut mode first
      shortcutEnableCallback!();

      // Clear calls from dialog state sync
      mockApi.setDialogMode.mockClear();
      mockApi.focusActiveWorkspace.mockClear();

      // Simulate Alt keyup
      window.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt" }));

      expect(mockApi.setDialogMode).toHaveBeenCalledWith(false);
      expect(mockApi.focusActiveWorkspace).toHaveBeenCalled();
    });

    it("should-wire-blur-handler-to-window: window blur disables shortcut mode", async () => {
      let shortcutEnableCallback: (() => void) | null = null;
      (
        mockApi.onShortcutEnable as unknown as {
          mockImplementation: (fn: (cb: () => void) => Unsubscribe) => void;
        }
      ).mockImplementation((cb) => {
        shortcutEnableCallback = cb;
        return vi.fn();
      });

      render(App);

      await waitFor(() => {
        expect(shortcutEnableCallback).not.toBeNull();
      });

      // Enable shortcut mode first
      shortcutEnableCallback!();

      // Clear calls from dialog state sync
      mockApi.setDialogMode.mockClear();
      mockApi.focusActiveWorkspace.mockClear();

      // Simulate window blur
      window.dispatchEvent(new Event("blur"));

      expect(mockApi.setDialogMode).toHaveBeenCalledWith(false);
      expect(mockApi.focusActiveWorkspace).toHaveBeenCalled();
    });

    it("does not call setDialogMode when shortcut mode is not active", async () => {
      render(App);

      // Wait for component to mount
      await waitFor(() => {
        expect(mockApi.onShortcutEnable).toHaveBeenCalled();
      });

      // Clear initial calls from dialog state sync
      mockApi.setDialogMode.mockClear();

      // Simulate Alt keyup without shortcut mode being enabled
      window.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt" }));

      // setDialogMode should not be called when shortcut mode is not active
      expect(mockApi.setDialogMode).not.toHaveBeenCalled();
    });

    it("should-connect-handleKeyDown-to-window: action key triggers action during shortcut mode", async () => {
      // Set up projects with workspaces
      const mockProjects: Project[] = [
        {
          path: asProjectPath("/test/project"),
          name: "test-project",
          workspaces: [
            { path: "/test/.worktrees/ws1", name: "ws1", branch: "main" },
            { path: "/test/.worktrees/ws2", name: "ws2", branch: "feature" },
          ],
        },
      ];
      mockApi.listProjects.mockResolvedValue(mockProjects);

      let shortcutEnableCallback: (() => void) | null = null;
      (
        mockApi.onShortcutEnable as unknown as {
          mockImplementation: (fn: (cb: () => void) => Unsubscribe) => void;
        }
      ).mockImplementation((cb) => {
        shortcutEnableCallback = cb;
        return vi.fn();
      });

      render(App);

      // Wait for projects to load
      await waitFor(() => {
        expect(projectsStore.projects.value).toHaveLength(1);
        expect(shortcutEnableCallback).not.toBeNull();
      });

      // Enable shortcut mode
      shortcutEnableCallback!();

      // Press "1" key to jump to first workspace
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "1" }));

      // Should have called switchWorkspace with focusWorkspace=false to keep shortcut mode active
      await waitFor(() => {
        expect(mockApi.switchWorkspace).toHaveBeenCalledWith("/test/.worktrees/ws1", false);
      });
    });

    it("should-pass-shortcutModeActive-to-sidebar: sidebar shows index numbers when active", async () => {
      const mockProjects: Project[] = [
        {
          path: asProjectPath("/test/project"),
          name: "test-project",
          workspaces: [{ path: "/test/.worktrees/ws1", name: "ws1", branch: "main" }],
        },
      ];
      mockApi.listProjects.mockResolvedValue(mockProjects);

      let shortcutEnableCallback: (() => void) | null = null;
      (
        mockApi.onShortcutEnable as unknown as {
          mockImplementation: (fn: (cb: () => void) => Unsubscribe) => void;
        }
      ).mockImplementation((cb) => {
        shortcutEnableCallback = cb;
        return vi.fn();
      });

      render(App);

      await waitFor(() => {
        expect(shortcutEnableCallback).not.toBeNull();
      });

      // Enable shortcut mode
      shortcutEnableCallback!();

      // Sidebar should show the index number
      await waitFor(() => {
        expect(screen.getByText("1")).toBeInTheDocument();
      });
    });

    it("should-pass-all-context-props-to-overlay: overlay hides hints when no context", async () => {
      // Empty projects = no workspaces, no active project/workspace
      mockApi.listProjects.mockResolvedValue([]);

      let shortcutEnableCallback: (() => void) | null = null;
      (
        mockApi.onShortcutEnable as unknown as {
          mockImplementation: (fn: (cb: () => void) => Unsubscribe) => void;
        }
      ).mockImplementation((cb) => {
        shortcutEnableCallback = cb;
        return vi.fn();
      });

      render(App);

      await waitFor(() => {
        expect(shortcutEnableCallback).not.toBeNull();
      });

      // Enable shortcut mode
      shortcutEnableCallback!();

      // With no workspaces, navigate and jump hints should be hidden
      await waitFor(() => {
        const navigateHint = screen.getByLabelText("Up and Down arrows to navigate");
        expect(navigateHint).toHaveClass("shortcut-hint--hidden");

        const jumpHint = screen.getByLabelText("Number keys 1 through 0 to jump");
        expect(jumpHint).toHaveClass("shortcut-hint--hidden");

        // Open should always be visible
        const openHint = screen.getByLabelText("O to open project");
        expect(openHint).not.toHaveClass("shortcut-hint--hidden");
      });
    });
  });

  describe("agent status handling", () => {
    it("calls getAllAgentStatuses on mount to initialize", async () => {
      render(App);

      await waitFor(() => {
        expect(mockApi.getAllAgentStatuses).toHaveBeenCalledTimes(1);
      });
    });

    it("sets initial statuses from getAllAgentStatuses response", async () => {
      const initialStatuses: Record<string, AggregatedAgentStatus> = {
        "/test/.worktrees/ws1": { status: "idle", counts: { idle: 2, busy: 0 } },
        "/test/.worktrees/ws2": { status: "busy", counts: { idle: 0, busy: 1 } },
      };
      mockApi.getAllAgentStatuses.mockResolvedValue(initialStatuses);

      render(App);

      await waitFor(() => {
        expect(agentStatusStore.getStatus("/test/.worktrees/ws1")).toEqual(
          initialStatuses["/test/.worktrees/ws1"]
        );
        expect(agentStatusStore.getStatus("/test/.worktrees/ws2")).toEqual(
          initialStatuses["/test/.worktrees/ws2"]
        );
      });
    });

    it("subscribes to onAgentStatusChanged on mount", async () => {
      render(App);

      await waitFor(() => {
        expect(mockApi.onAgentStatusChanged).toHaveBeenCalledTimes(1);
      });
    });

    it("updates store on agent:status-changed event", async () => {
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

      render(App);

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

      // Verify status was updated in store
      expect(agentStatusStore.getStatus("/test/.worktrees/feature")).toEqual(newStatus);
    });

    it("unsubscribes from onAgentStatusChanged on unmount", async () => {
      const unsubAgentStatus = vi.fn();
      mockApi.onAgentStatusChanged.mockReturnValue(unsubAgentStatus);

      const { unmount } = render(App);

      await waitFor(() => {
        expect(mockApi.onAgentStatusChanged).toHaveBeenCalled();
      });

      unmount();

      expect(unsubAgentStatus).toHaveBeenCalledTimes(1);
    });
  });

  describe("setup flow handling", () => {
    it("calls setupReady on mount", async () => {
      render(App);

      await waitFor(() => {
        expect(mockApi.setupReady).toHaveBeenCalledTimes(1);
      });
    });

    it("subscribes to setup events on mount", async () => {
      render(App);

      await waitFor(() => {
        expect(mockApi.onSetupProgress).toHaveBeenCalledTimes(1);
        expect(mockApi.onSetupComplete).toHaveBeenCalledTimes(1);
        expect(mockApi.onSetupError).toHaveBeenCalledTimes(1);
      });
    });

    it("unsubscribes from setup events on unmount", async () => {
      const unsubProgress = vi.fn();
      const unsubComplete = vi.fn();
      const unsubError = vi.fn();
      mockApi.onSetupProgress.mockReturnValue(unsubProgress);
      mockApi.onSetupComplete.mockReturnValue(unsubComplete);
      mockApi.onSetupError.mockReturnValue(unsubError);

      const { unmount } = render(App);

      await waitFor(() => {
        expect(mockApi.onSetupProgress).toHaveBeenCalled();
      });

      unmount();

      expect(unsubProgress).toHaveBeenCalledTimes(1);
      expect(unsubComplete).toHaveBeenCalledTimes(1);
      expect(unsubError).toHaveBeenCalledTimes(1);
    });

    it("shows SetupScreen when in loading state", async () => {
      // Keep loading state by never resolving listProjects
      mockApi.listProjects.mockReturnValue(new Promise(() => {}));

      render(App);

      // Should show setup screen with loading indicator
      await waitFor(() => {
        expect(screen.getByText("Setting up VSCode...")).toBeInTheDocument();
      });
    });

    it("updates setup screen on progress event", async () => {
      // Setup mode - setupReady returns { ready: false }
      mockApi.setupReady.mockResolvedValue({ ready: false });

      let progressCallback: ((event: SetupProgress) => void) | null = null;
      (
        mockApi.onSetupProgress as unknown as {
          mockImplementation: (fn: (cb: (event: SetupProgress) => void) => Unsubscribe) => void;
        }
      ).mockImplementation((cb) => {
        progressCallback = cb;
        return vi.fn();
      });

      render(App);

      await waitFor(() => {
        expect(progressCallback).not.toBeNull();
      });

      // Simulate progress event
      progressCallback!({ step: "extensions", message: "Installing OpenCode extension..." });

      await waitFor(() => {
        expect(screen.getByText("Installing OpenCode extension...")).toBeInTheDocument();
      });
    });

    it("shows SetupComplete on complete event", async () => {
      // Setup mode - setupReady returns { ready: false }
      mockApi.setupReady.mockResolvedValue({ ready: false });

      let completeCallback: (() => void) | null = null;
      (
        mockApi.onSetupComplete as unknown as {
          mockImplementation: (fn: (cb: () => void) => Unsubscribe) => void;
        }
      ).mockImplementation((cb) => {
        completeCallback = cb;
        return vi.fn();
      });

      render(App);

      await waitFor(() => {
        expect(completeCallback).not.toBeNull();
      });

      // Simulate complete event
      completeCallback!();

      await waitFor(() => {
        expect(screen.getByText("Setup complete!")).toBeInTheDocument();
      });
    });

    it("shows SetupError on error event", async () => {
      // Setup mode - setupReady returns { ready: false }
      mockApi.setupReady.mockResolvedValue({ ready: false });

      let errorCallback: ((event: SetupErrorPayload) => void) | null = null;
      (
        mockApi.onSetupError as unknown as {
          mockImplementation: (fn: (cb: (event: SetupErrorPayload) => void) => Unsubscribe) => void;
        }
      ).mockImplementation((cb) => {
        errorCallback = cb;
        return vi.fn();
      });

      render(App);

      await waitFor(() => {
        expect(errorCallback).not.toBeNull();
      });

      // Simulate error event
      errorCallback!({ message: "Network error", code: "network" });

      await waitFor(() => {
        expect(screen.getByText("Setup Failed")).toBeInTheDocument();
        expect(screen.getByText("Error: Network error")).toBeInTheDocument();
      });
    });

    it("calls setupRetry when Retry button clicked on error screen", async () => {
      // Setup mode - setupReady returns { ready: false }
      mockApi.setupReady.mockResolvedValue({ ready: false });

      let errorCallback: ((event: SetupErrorPayload) => void) | null = null;
      (
        mockApi.onSetupError as unknown as {
          mockImplementation: (fn: (cb: (event: SetupErrorPayload) => void) => Unsubscribe) => void;
        }
      ).mockImplementation((cb) => {
        errorCallback = cb;
        return vi.fn();
      });

      render(App);

      await waitFor(() => {
        expect(errorCallback).not.toBeNull();
      });

      // Trigger error state
      errorCallback!({ message: "Failed", code: "network" });

      await waitFor(() => {
        expect(screen.getByText("Setup Failed")).toBeInTheDocument();
      });

      // Click retry button
      const retryButton = screen.getByRole("button", { name: "Retry" });
      retryButton.click();

      expect(mockApi.setupRetry).toHaveBeenCalledTimes(1);
    });

    it("calls setupQuit when Quit button clicked on error screen", async () => {
      // Setup mode - setupReady returns { ready: false }
      mockApi.setupReady.mockResolvedValue({ ready: false });

      let errorCallback: ((event: SetupErrorPayload) => void) | null = null;
      (
        mockApi.onSetupError as unknown as {
          mockImplementation: (fn: (cb: (event: SetupErrorPayload) => void) => Unsubscribe) => void;
        }
      ).mockImplementation((cb) => {
        errorCallback = cb;
        return vi.fn();
      });

      render(App);

      await waitFor(() => {
        expect(errorCallback).not.toBeNull();
      });

      // Trigger error state
      errorCallback!({ message: "Failed", code: "network" });

      await waitFor(() => {
        expect(screen.getByText("Setup Failed")).toBeInTheDocument();
      });

      // Click quit button
      const quitButton = screen.getByRole("button", { name: "Quit" });
      quitButton.click();

      expect(mockApi.setupQuit).toHaveBeenCalledTimes(1);
    });

    it("transitions to normal app after listProjects succeeds", async () => {
      // Normal mode - listProjects returns immediately
      mockApi.listProjects.mockResolvedValue([]);

      render(App);

      // Should show Sidebar (normal app)
      await waitFor(() => {
        expect(screen.getByRole("navigation", { name: "Projects" })).toBeInTheDocument();
      });

      // Should NOT show setup screen
      expect(screen.queryByText("Setting up VSCode...")).not.toBeInTheDocument();
    });
  });
});
