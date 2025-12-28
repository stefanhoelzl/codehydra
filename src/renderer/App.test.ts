/**
 * Tests for the App component.
 * Tests initialization, store integration, and dialog rendering.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/svelte";
import { delay } from "@services/test-utils";
import { asProjectId, asProjectPath, asWorkspaceRef } from "@shared/test-fixtures";

// API event callbacks - must be hoisted with mockApi so it's available when mock runs
type EventCallback = (...args: unknown[]) => void;
const { mockApi, eventCallbacks } = vi.hoisted(() => {
  const callbacks = new Map<string, EventCallback>();
  return {
    eventCallbacks: callbacks,
    mockApi: {
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
      on: vi.fn((event: string, callback: EventCallback) => {
        callbacks.set(event, callback);
        return vi.fn(); // unsubscribe
      }),
      // onModeChange captures callback for ui:mode-changed events
      onModeChange: vi.fn((callback: EventCallback) => {
        callbacks.set("ui:mode-changed", callback);
        return vi.fn(); // unsubscribe
      }),
      // onShortcut captures callback for shortcut:key events
      onShortcut: vi.fn((callback: EventCallback) => {
        callbacks.set("shortcut:key", callback);
        return vi.fn(); // unsubscribe
      }),
    },
  };
});

// Helper to get an event callback
function getEventCallback(event: string): EventCallback | undefined {
  return eventCallbacks.get(event);
}

// Helper to fire an event
function fireEvent(event: string, payload?: unknown): void {
  const callback = eventCallbacks.get(event);
  if (callback) {
    callback(payload);
  }
}

// Helper to clear event callbacks between tests
function clearEventCallbacks(): void {
  eventCallbacks.clear();
}

// Mock the API module before any imports use it
vi.mock("$lib/api", () => mockApi);

// Import after mock setup
import App from "./App.svelte";
import * as projectsStore from "$lib/stores/projects.svelte.js";
import * as dialogsStore from "$lib/stores/dialogs.svelte.js";
import * as shortcutsStore from "$lib/stores/shortcuts.svelte.js";
import * as agentStatusStore from "$lib/stores/agent-status.svelte.js";
import * as setupStore from "$lib/stores/setup.svelte.js";

describe("App component", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset stores before each test
    projectsStore.reset();
    dialogsStore.reset();
    shortcutsStore.reset();
    agentStatusStore.reset();
    setupStore.resetSetup();
    // Reset v2 event callbacks
    clearEventCallbacks();
    // Reset v2.on implementation to capture callbacks (some tests override it)
    mockApi.on.mockImplementation((event: string, callback: EventCallback) => {
      eventCallbacks.set(event, callback);
      return vi.fn();
    });
    // Reset onModeChange implementation to capture callbacks (some tests override it)
    mockApi.onModeChange.mockImplementation((callback: EventCallback) => {
      eventCallbacks.set("ui:mode-changed", callback);
      return vi.fn();
    });
    // Reset onShortcut implementation to capture callbacks
    mockApi.onShortcut.mockImplementation((callback: EventCallback) => {
      eventCallbacks.set("shortcut:key", callback);
      return vi.fn();
    });
    // Default to returning empty projects
    mockApi.projects.list.mockResolvedValue([]);
    // Default to setup complete (ready mode)
    mockApi.lifecycle.getState.mockResolvedValue("ready");
    mockApi.lifecycle.setup.mockResolvedValue({ success: true });
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
      dialogsStore.openCreateDialog(asProjectId("test-project-12345678"));

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
      dialogsStore.openRemoveDialog(
        asWorkspaceRef("test-project-12345678", "feature", "/test/.worktrees/feature")
      );

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
        // Now uses v2 API
        expect(mockApi.projects.list).toHaveBeenCalledTimes(1);
      });
    });

    it("sets loadingState to 'loaded' after successful listProjects", async () => {
      const mockProjects = [
        {
          id: asProjectId("test-project-12345678"),
          path: asProjectPath("/test/project"),
          name: "test-project",
          workspaces: [],
        },
      ];
      // Now uses v2 API
      mockApi.projects.list.mockResolvedValue(mockProjects);

      render(App);

      // Wait for loading to complete
      await waitFor(() => {
        expect(projectsStore.loadingState.value).toBe("loaded");
      });
    });

    it("sets loadingState to 'error' with message on listProjects failure", async () => {
      // Now uses v2 API
      mockApi.projects.list.mockRejectedValue(new Error("Network error"));

      render(App);

      await waitFor(() => {
        expect(projectsStore.loadingState.value).toBe("error");
        expect(projectsStore.loadingError.value).toBe("Network error");
      });
    });
  });

  describe("event subscriptions", () => {
    it("subscribes to all domain events via v2.on() on mount", async () => {
      render(App);

      await waitFor(() => {
        // Now uses v2 API events via api.v2.on() for domain events
        expect(mockApi.on).toHaveBeenCalledWith("project:opened", expect.any(Function));
        expect(mockApi.on).toHaveBeenCalledWith("project:closed", expect.any(Function));
        expect(mockApi.on).toHaveBeenCalledWith("workspace:created", expect.any(Function));
        expect(mockApi.on).toHaveBeenCalledWith("workspace:removed", expect.any(Function));
        expect(mockApi.on).toHaveBeenCalledWith("workspace:switched", expect.any(Function));
      });
    });

    it("unsubscribes from all v2 events on unmount", async () => {
      // Track unsubscribe functions per event
      const unsubFunctions = new Map<string, ReturnType<typeof vi.fn>>();
      mockApi.on.mockImplementation((event: string) => {
        const unsub = vi.fn();
        unsubFunctions.set(event, unsub);
        return unsub;
      });

      const { unmount } = render(App);

      // Wait for subscriptions to be set up
      await waitFor(() => {
        expect(mockApi.on).toHaveBeenCalledWith("project:opened", expect.any(Function));
      });

      // Unmount the component
      unmount();

      // Verify domain event unsubscribe functions were called
      expect(unsubFunctions.get("project:opened")).toHaveBeenCalledTimes(1);
      expect(unsubFunctions.get("project:closed")).toHaveBeenCalledTimes(1);
      expect(unsubFunctions.get("workspace:created")).toHaveBeenCalledTimes(1);
      expect(unsubFunctions.get("workspace:removed")).toHaveBeenCalledTimes(1);
      expect(unsubFunctions.get("workspace:switched")).toHaveBeenCalledTimes(1);
    });

    it("handles project:opened event by adding project to store", async () => {
      render(App);

      // Wait for subscriptions
      await waitFor(() => {
        expect(getEventCallback("project:opened")).toBeDefined();
      });

      // Simulate v2 project opened event (includes id)
      const newProject = {
        id: asProjectId("new-project-12345678"),
        path: asProjectPath("/test/new-project"),
        name: "new-project",
        workspaces: [],
      };
      fireEvent("project:opened", { project: newProject });

      // Verify project was added (check path since projects now have generated id)
      const addedProject = projectsStore.projects.value.find((p) => p.path === newProject.path);
      expect(addedProject).toBeDefined();
      expect(addedProject?.name).toBe(newProject.name);
    });

    it("handles project:closed event by removing project from store", async () => {
      // Pre-populate store with a project - use v2 API format with ID
      const existingProject = {
        id: asProjectId("existing-12345678"),
        path: asProjectPath("/test/existing"),
        name: "existing",
        workspaces: [],
      };
      mockApi.projects.list.mockResolvedValue([existingProject]);

      render(App);

      // Wait for initial load and subscriptions
      await waitFor(() => {
        expect(projectsStore.projects.value).toHaveLength(1);
        expect(getEventCallback("project:closed")).toBeDefined();
      });

      // Get the actual project ID from the store (ID is regenerated from path)
      const actualProjectId = projectsStore.projects.value[0]!.id;

      // Simulate v2 project closed event (uses projectId not path)
      fireEvent("project:closed", { projectId: actualProjectId });

      // Verify project was removed
      expect(projectsStore.projects.value).toHaveLength(0);
    });

    it("handles workspace:switched event by updating active workspace", async () => {
      render(App);

      await waitFor(() => {
        expect(getEventCallback("workspace:switched")).toBeDefined();
      });

      // Simulate v2 workspace switched event (uses WorkspaceRef)
      fireEvent(
        "workspace:switched",
        asWorkspaceRef("test-12345678", "feature", "/test/.worktrees/feature")
      );

      expect(projectsStore.activeWorkspacePath.value).toBe("/test/.worktrees/feature");
    });
  });

  describe("shortcut mode handling", () => {
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
      render(App);

      // Wait for subscription
      await waitFor(() => {
        expect(getEventCallback("ui:mode-changed")).toBeDefined();
      });

      // Trigger shortcut mode via ui:mode-changed event
      fireEvent("ui:mode-changed", { mode: "shortcut", previousMode: "workspace" });

      // Overlay should now be active (aria-hidden=false)
      await waitFor(() => {
        const overlay = screen.getByRole("status");
        expect(overlay).toHaveClass("active");
      });
    });

    // NOTE: Alt keyup handling was moved to main process in Stage 2 of SHORTCUT_MODE_REFACTOR.
    // The main process detects Alt release via before-input-event and emits ui:mode-changed.
    // The renderer no longer listens to keyup events for Alt.

    it("should-wire-blur-handler-to-window: window blur exits shortcut mode", async () => {
      render(App);

      // Wait for subscription
      await waitFor(() => {
        expect(getEventCallback("ui:mode-changed")).toBeDefined();
      });

      // Enable shortcut mode first via ui:mode-changed event
      fireEvent("ui:mode-changed", { mode: "shortcut", previousMode: "workspace" });

      // Simulate window blur - should call setMode("workspace") via fire-and-forget
      window.dispatchEvent(new Event("blur"));

      // In the new architecture, window blur calls api.ui.setMode("workspace")
      expect(mockApi.ui.setMode).toHaveBeenCalledWith("workspace");
    });

    it("does not call setMode when shortcut mode is not active", async () => {
      render(App);

      // Wait for component to mount
      await waitFor(() => {
        expect(mockApi.onModeChange).toHaveBeenCalled();
      });

      // Clear any previous calls
      mockApi.ui.setMode.mockClear();

      // Simulate Alt keyup without shortcut mode being enabled
      window.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt" }));

      // setMode should not be called when shortcut mode is not active
      expect(mockApi.ui.setMode).not.toHaveBeenCalled();
    });

    // NOTE: Test "Alt keyup in shortcut mode calls api.ui.setMode('workspace') as fallback" removed.
    // The renderer fallback for Alt keyup was removed in favor of focusing the UI layer
    // during shortcut mode, which ensures the main process's before-input-event handler
    // reliably receives Alt keyup events.

    // NOTE: Test "should-connect-handleKeyDown-to-window" removed in Stage 2.6
    // It tested old keyboard-based action handling which is now replaced by:
    // - Main process detects keys and emits shortcut:key events
    // - Tests: "shortcut '1'-'9' jumps to workspace by index" etc.

    it("should-pass-shortcutModeActive-to-sidebar: sidebar shows index numbers when active", async () => {
      const mockProjects = [
        {
          id: asProjectId("test-project-12345678"),
          path: asProjectPath("/test/project"),
          name: "test-project",
          workspaces: [{ path: "/test/.worktrees/ws1", name: "ws1", branch: "main" }],
        },
      ];
      mockApi.projects.list.mockResolvedValue(mockProjects);

      render(App);

      await waitFor(() => {
        expect(getEventCallback("ui:mode-changed")).toBeDefined();
      });

      // Enable shortcut mode via ui:mode-changed event
      fireEvent("ui:mode-changed", { mode: "shortcut", previousMode: "workspace" });

      // Sidebar should show the index number
      await waitFor(() => {
        expect(screen.getByText("1")).toBeInTheDocument();
      });
    });

    it("should-pass-all-context-props-to-overlay: overlay hides hints when no context", async () => {
      // Empty projects = no workspaces, no active project/workspace
      mockApi.projects.list.mockResolvedValue([]);

      render(App);

      await waitFor(() => {
        expect(getEventCallback("ui:mode-changed")).toBeDefined();
      });

      // Enable shortcut mode via ui:mode-changed event
      fireEvent("ui:mode-changed", { mode: "shortcut", previousMode: "workspace" });

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

    // ============ Step 1.6: ui:mode-changed event tests ============

    it("should-subscribe-to-mode-change-on-mount: subscribes to onModeChange via $effect", async () => {
      render(App);

      await waitFor(() => {
        expect(mockApi.onModeChange).toHaveBeenCalledWith(expect.any(Function));
      });
    });

    it("should-show-overlay-on-shortcut-mode: onModeChange with mode=shortcut shows overlay", async () => {
      render(App);

      // Wait for subscription
      await waitFor(() => {
        expect(getEventCallback("ui:mode-changed")).toBeDefined();
      });

      // Fire ui:mode-changed event with mode=shortcut
      fireEvent("ui:mode-changed", { mode: "shortcut", previousMode: "workspace" });

      // Overlay should now be active
      await waitFor(() => {
        const overlay = screen.getByRole("status");
        expect(overlay).toHaveClass("active");
      });
    });

    it("should-hide-overlay-on-workspace-mode: onModeChange with mode=workspace hides overlay", async () => {
      render(App);

      // Wait for subscription
      await waitFor(() => {
        expect(getEventCallback("ui:mode-changed")).toBeDefined();
      });

      // First activate shortcut mode
      fireEvent("ui:mode-changed", { mode: "shortcut", previousMode: "workspace" });

      await waitFor(() => {
        const overlay = document.querySelector(".shortcut-overlay");
        expect(overlay).toHaveClass("active");
      });

      // Then deactivate with workspace mode
      fireEvent("ui:mode-changed", { mode: "workspace", previousMode: "shortcut" });

      // Overlay should be hidden (check class directly since role query may have timing issues)
      await waitFor(() => {
        const overlay = document.querySelector(".shortcut-overlay");
        expect(overlay).toBeDefined();
        expect(overlay).not.toHaveClass("active");
      });
    });

    it("should-cleanup-mode-subscription-on-unmount: unsubscribe called when component unmounts", async () => {
      const unsubModeChange = vi.fn();
      mockApi.onModeChange.mockReturnValue(unsubModeChange);

      const { unmount } = render(App);

      await waitFor(() => {
        expect(mockApi.onModeChange).toHaveBeenCalledWith(expect.any(Function));
      });

      unmount();

      expect(unsubModeChange).toHaveBeenCalledTimes(1);
    });

    it("should-announce-shortcut-mode-for-screen-readers: ARIA live region announces mode change", async () => {
      render(App);

      // Wait for subscription
      await waitFor(() => {
        expect(getEventCallback("ui:mode-changed")).toBeDefined();
      });

      // Fire ui:mode-changed event with mode=shortcut
      fireEvent("ui:mode-changed", { mode: "shortcut", previousMode: "workspace" });

      // Should have ARIA live announcement
      await waitFor(() => {
        const liveRegion = document.querySelector('[aria-live="polite"]');
        expect(liveRegion).toHaveTextContent("Shortcut mode active");
      });
    });

    // ============ Stage 2.5: Shortcut key events from main process ============

    it("subscribes to onShortcut on mount", async () => {
      render(App);

      await waitFor(() => {
        expect(mockApi.onShortcut).toHaveBeenCalledWith(expect.any(Function));
      });
    });

    it('shortcut "up" navigates to previous workspace', async () => {
      const mockProjects = [
        {
          id: asProjectId("test-project-12345678"),
          path: asProjectPath("/test/project"),
          name: "test-project",
          workspaces: [
            { path: "/test/.worktrees/ws1", name: "ws1", branch: "main" },
            { path: "/test/.worktrees/ws2", name: "ws2", branch: "feature" },
          ],
        },
      ];
      mockApi.projects.list.mockResolvedValue(mockProjects);

      render(App);

      await waitFor(() => {
        expect(projectsStore.projects.value).toHaveLength(1);
        expect(getEventCallback("shortcut:key")).toBeDefined();
      });

      // Get actual project ID
      const actualProjectId = projectsStore.projects.value[0]!.id;

      // Set active workspace to second one
      projectsStore.setActiveWorkspace("/test/.worktrees/ws2");

      // Enable shortcut mode first (via mode change event)
      fireEvent("ui:mode-changed", { mode: "shortcut", previousMode: "workspace" });

      // Fire shortcut:key event with "up"
      fireEvent("shortcut:key", "up");

      await waitFor(() => {
        // Should navigate to first workspace (ws1)
        expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith(actualProjectId, "ws1", false);
      });
    });

    it('shortcut "down" navigates to next workspace', async () => {
      const mockProjects = [
        {
          id: asProjectId("test-project-12345678"),
          path: asProjectPath("/test/project"),
          name: "test-project",
          workspaces: [
            { path: "/test/.worktrees/ws1", name: "ws1", branch: "main" },
            { path: "/test/.worktrees/ws2", name: "ws2", branch: "feature" },
          ],
        },
      ];
      mockApi.projects.list.mockResolvedValue(mockProjects);

      render(App);

      await waitFor(() => {
        expect(projectsStore.projects.value).toHaveLength(1);
        expect(getEventCallback("shortcut:key")).toBeDefined();
      });

      // Get actual project ID
      const actualProjectId = projectsStore.projects.value[0]!.id;

      // Set active workspace to first one
      projectsStore.setActiveWorkspace("/test/.worktrees/ws1");

      // Enable shortcut mode
      fireEvent("ui:mode-changed", { mode: "shortcut", previousMode: "workspace" });

      // Fire shortcut:key event with "down"
      fireEvent("shortcut:key", "down");

      await waitFor(() => {
        // Should navigate to second workspace (ws2)
        expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith(actualProjectId, "ws2", false);
      });
    });

    it('shortcut "1"-"9" jumps to workspace by index (1=first, 9=ninth)', async () => {
      const mockProjects = [
        {
          id: asProjectId("test-project-12345678"),
          path: asProjectPath("/test/project"),
          name: "test-project",
          workspaces: [
            { path: "/test/.worktrees/ws1", name: "ws1", branch: "main" },
            { path: "/test/.worktrees/ws2", name: "ws2", branch: "feature" },
            { path: "/test/.worktrees/ws3", name: "ws3", branch: "bugfix" },
          ],
        },
      ];
      mockApi.projects.list.mockResolvedValue(mockProjects);

      render(App);

      await waitFor(() => {
        expect(projectsStore.projects.value).toHaveLength(1);
        expect(getEventCallback("shortcut:key")).toBeDefined();
      });

      const actualProjectId = projectsStore.projects.value[0]!.id;

      // Enable shortcut mode
      fireEvent("ui:mode-changed", { mode: "shortcut", previousMode: "workspace" });

      // Fire shortcut:key event with "2" to jump to second workspace
      fireEvent("shortcut:key", "2");

      await waitFor(() => {
        expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith(actualProjectId, "ws2", false);
      });
    });

    it('shortcut "0" jumps to workspace 10 (index 9)', async () => {
      // Create 10 workspaces with zero-padded names for correct sorting
      // ws01, ws02, ..., ws10 sort correctly: ws01 at index 0, ws10 at index 9
      const workspaces = Array.from({ length: 10 }, (_, i) => ({
        path: `/test/.worktrees/ws${String(i + 1).padStart(2, "0")}`,
        name: `ws${String(i + 1).padStart(2, "0")}`,
        branch: `branch${i + 1}`,
      }));

      const mockProjects = [
        {
          id: asProjectId("test-project-12345678"),
          path: asProjectPath("/test/project"),
          name: "test-project",
          workspaces,
        },
      ];
      mockApi.projects.list.mockResolvedValue(mockProjects);

      render(App);

      await waitFor(() => {
        expect(projectsStore.projects.value).toHaveLength(1);
        expect(getEventCallback("shortcut:key")).toBeDefined();
      });

      const actualProjectId = projectsStore.projects.value[0]!.id;

      // Enable shortcut mode
      fireEvent("ui:mode-changed", { mode: "shortcut", previousMode: "workspace" });

      // Fire shortcut:key event with "0" to jump to 10th workspace
      fireEvent("shortcut:key", "0");

      await waitFor(() => {
        expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith(actualProjectId, "ws10", false);
      });
    });

    it("shortcut number beyond workspace count is ignored", async () => {
      const mockProjects = [
        {
          id: asProjectId("test-project-12345678"),
          path: asProjectPath("/test/project"),
          name: "test-project",
          workspaces: [
            { path: "/test/.worktrees/ws1", name: "ws1", branch: "main" },
            { path: "/test/.worktrees/ws2", name: "ws2", branch: "feature" },
          ],
        },
      ];
      mockApi.projects.list.mockResolvedValue(mockProjects);

      render(App);

      await waitFor(() => {
        expect(projectsStore.projects.value).toHaveLength(1);
        expect(getEventCallback("shortcut:key")).toBeDefined();
      });

      // Clear any previous calls
      mockApi.ui.switchWorkspace.mockClear();

      // Enable shortcut mode
      fireEvent("ui:mode-changed", { mode: "shortcut", previousMode: "workspace" });

      // Fire shortcut:key event with "5" (only 2 workspaces exist)
      fireEvent("shortcut:key", "5");

      // Should NOT call switchWorkspace (index out of range)
      await delay(50); // Short wait
      expect(mockApi.ui.switchWorkspace).not.toHaveBeenCalled();
    });

    it('shortcut "enter" opens create workspace dialog', async () => {
      const mockProjects = [
        {
          id: asProjectId("test-project-12345678"),
          path: asProjectPath("/test/project"),
          name: "test-project",
          workspaces: [{ path: "/test/.worktrees/ws1", name: "ws1", branch: "main" }],
        },
      ];
      mockApi.projects.list.mockResolvedValue(mockProjects);

      render(App);

      await waitFor(() => {
        expect(projectsStore.projects.value).toHaveLength(1);
        expect(getEventCallback("shortcut:key")).toBeDefined();
      });

      // Set active workspace so we have an active project
      projectsStore.setActiveWorkspace("/test/.worktrees/ws1");

      // Enable shortcut mode
      fireEvent("ui:mode-changed", { mode: "shortcut", previousMode: "workspace" });

      // Fire shortcut:key event with "enter"
      fireEvent("shortcut:key", "enter");

      // Should open create dialog
      await waitFor(() => {
        const dialog = screen.getByRole("dialog");
        expect(dialog).toBeInTheDocument();
        expect(screen.getByText("Create Workspace")).toBeInTheDocument();
      });
    });

    it('shortcut "delete" opens remove workspace dialog', async () => {
      const mockProjects = [
        {
          id: asProjectId("test-project-12345678"),
          path: asProjectPath("/test/project"),
          name: "test-project",
          workspaces: [{ path: "/test/.worktrees/ws1", name: "ws1", branch: "main" }],
        },
      ];
      mockApi.projects.list.mockResolvedValue(mockProjects);

      render(App);

      await waitFor(() => {
        expect(projectsStore.projects.value).toHaveLength(1);
        expect(getEventCallback("shortcut:key")).toBeDefined();
      });

      // Set active workspace so we have something to delete
      projectsStore.setActiveWorkspace("/test/.worktrees/ws1");

      // Enable shortcut mode
      fireEvent("ui:mode-changed", { mode: "shortcut", previousMode: "workspace" });

      // Fire shortcut:key event with "delete"
      fireEvent("shortcut:key", "delete");

      // Should open remove dialog
      await waitFor(() => {
        const dialog = screen.getByRole("dialog");
        expect(dialog).toBeInTheDocument();
        expect(screen.getByText("Remove Workspace")).toBeInTheDocument();
      });
    });

    it('shortcut "o" opens project folder picker', async () => {
      render(App);

      await waitFor(() => {
        expect(getEventCallback("shortcut:key")).toBeDefined();
      });

      // Enable shortcut mode
      fireEvent("ui:mode-changed", { mode: "shortcut", previousMode: "workspace" });

      // Fire shortcut:key event with "o"
      fireEvent("shortcut:key", "o");

      await waitFor(() => {
        expect(mockApi.ui.selectFolder).toHaveBeenCalled();
      });
    });

    it("unsubscribes from shortcut events on unmount", async () => {
      const unsubShortcut = vi.fn();
      mockApi.onShortcut.mockReturnValue(unsubShortcut);

      const { unmount } = render(App);

      await waitFor(() => {
        expect(mockApi.onShortcut).toHaveBeenCalledWith(expect.any(Function));
      });

      unmount();

      expect(unsubShortcut).toHaveBeenCalledTimes(1);
    });

    // ============ Stage 2.6: Escape key still handled in renderer ============

    it("Escape key in shortcut mode calls api.ui.setMode('workspace')", async () => {
      render(App);

      // Wait for subscription
      await waitFor(() => {
        expect(getEventCallback("ui:mode-changed")).toBeDefined();
      });

      // Enable shortcut mode
      fireEvent("ui:mode-changed", { mode: "shortcut", previousMode: "workspace" });

      // Clear any previous setMode calls
      mockApi.ui.setMode.mockClear();

      // Press Escape - should call setMode("workspace")
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

      expect(mockApi.ui.setMode).toHaveBeenCalledWith("workspace");
    });

    it("Escape key when not in shortcut mode does not call setMode", async () => {
      render(App);

      // Wait for subscription
      await waitFor(() => {
        expect(getEventCallback("ui:mode-changed")).toBeDefined();
      });

      // Make sure we're NOT in shortcut mode (mode is workspace by default)
      mockApi.ui.setMode.mockClear();

      // Press Escape - should NOT call setMode
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

      expect(mockApi.ui.setMode).not.toHaveBeenCalled();
    });
  });

  describe("agent status handling", () => {
    it("fetches workspace statuses via v2 API after loading projects", async () => {
      // Setup mock projects with workspaces
      const mockProjects = [
        {
          id: asProjectId("test-project-12345678"),
          path: asProjectPath("/test/project"),
          name: "test-project",
          workspaces: [
            { name: "ws1", branch: "ws1", path: "/test/.worktrees/ws1" },
            { name: "ws2", branch: "ws2", path: "/test/.worktrees/ws2" },
          ],
        },
      ];
      mockApi.projects.list.mockResolvedValue(mockProjects);

      render(App);

      await waitFor(() => {
        // Should call getStatus for each workspace
        expect(mockApi.workspaces.getStatus).toHaveBeenCalledWith("test-project-12345678", "ws1");
        expect(mockApi.workspaces.getStatus).toHaveBeenCalledWith("test-project-12345678", "ws2");
      });
    });

    it("sets initial statuses from v2.workspaces.getStatus responses", async () => {
      // Setup mock projects with workspaces
      const mockProjects = [
        {
          id: asProjectId("test-project-12345678"),
          path: asProjectPath("/test/project"),
          name: "test-project",
          workspaces: [
            { name: "ws1", branch: "ws1", path: "/test/.worktrees/ws1" },
            { name: "ws2", branch: "ws2", path: "/test/.worktrees/ws2" },
          ],
        },
      ];
      mockApi.projects.list.mockResolvedValue(mockProjects);

      // Mock different statuses for each workspace
      mockApi.workspaces.getStatus.mockImplementation(
        (_projectId: string, workspaceName: string) => {
          if (workspaceName === "ws1") {
            return Promise.resolve({
              isDirty: false,
              agent: { type: "idle", counts: { idle: 2, busy: 0, total: 2 } },
            });
          } else {
            return Promise.resolve({
              isDirty: true,
              agent: { type: "busy", counts: { idle: 0, busy: 1, total: 1 } },
            });
          }
        }
      );

      render(App);

      await waitFor(() => {
        // Verify statuses were stored directly as v2 AgentStatus (no conversion)
        expect(agentStatusStore.getStatus("/test/.worktrees/ws1")).toEqual({
          type: "idle",
          counts: { idle: 2, busy: 0, total: 2 },
        });
        expect(agentStatusStore.getStatus("/test/.worktrees/ws2")).toEqual({
          type: "busy",
          counts: { idle: 0, busy: 1, total: 1 },
        });
      });
    });

    it("subscribes to workspace:status-changed via v2.on() on mount", async () => {
      render(App);

      await waitFor(() => {
        expect(mockApi.on).toHaveBeenCalledWith("workspace:status-changed", expect.any(Function));
      });
    });

    it("updates store on workspace:status-changed v2 event", async () => {
      render(App);

      await waitFor(() => {
        expect(getEventCallback("workspace:status-changed")).toBeDefined();
      });

      // Simulate v2 workspace:status-changed event (uses WorkspaceRef + WorkspaceStatus)
      fireEvent("workspace:status-changed", {
        projectId: asProjectId("test-12345678"),
        workspaceName: "feature",
        path: "/test/.worktrees/feature",
        status: {
          isDirty: false,
          agent: { type: "busy", counts: { idle: 0, busy: 3, total: 3 } },
        },
      });

      // Verify status was stored directly as v2 AgentStatus (no conversion)
      expect(agentStatusStore.getStatus("/test/.worktrees/feature")).toEqual({
        type: "busy",
        counts: { idle: 0, busy: 3, total: 3 },
      });
    });

    it("unsubscribes from workspace:status-changed v2 event on unmount", async () => {
      // Track unsubscribe functions per event
      const unsubFunctions = new Map<string, ReturnType<typeof vi.fn>>();
      mockApi.on.mockImplementation((event: string) => {
        const unsub = vi.fn();
        unsubFunctions.set(event, unsub);
        return unsub;
      });

      const { unmount } = render(App);

      await waitFor(() => {
        expect(mockApi.on).toHaveBeenCalledWith("workspace:status-changed", expect.any(Function));
      });

      unmount();

      expect(unsubFunctions.get("workspace:status-changed")).toHaveBeenCalledTimes(1);
    });
  });

  describe("setup flow handling", () => {
    it("calls lifecycle.getState on mount", async () => {
      render(App);

      await waitFor(() => {
        expect(mockApi.lifecycle.getState).toHaveBeenCalledTimes(1);
      });
    });

    it("subscribes to setup:progress events via on() on mount", async () => {
      render(App);

      await waitFor(() => {
        expect(mockApi.on).toHaveBeenCalledWith("setup:progress", expect.any(Function));
      });
    });

    it("unsubscribes from setup:progress on unmount", async () => {
      // Track unsubscribe functions per event
      const unsubFunctions = new Map<string, ReturnType<typeof vi.fn>>();
      mockApi.on.mockImplementation((event: string) => {
        const unsub = vi.fn();
        unsubFunctions.set(event, unsub);
        return unsub;
      });

      const { unmount } = render(App);

      await waitFor(() => {
        expect(mockApi.on).toHaveBeenCalledWith("setup:progress", expect.any(Function));
      });

      unmount();

      expect(unsubFunctions.get("setup:progress")).toHaveBeenCalledTimes(1);
    });

    it("shows SetupScreen when state is 'setup'", async () => {
      // Setup mode - lifecycle.getState returns "setup"
      mockApi.lifecycle.getState.mockResolvedValue("setup");
      // Keep setup running indefinitely
      mockApi.lifecycle.setup.mockReturnValue(new Promise(() => {}));

      render(App);

      // Should show setup screen
      await waitFor(() => {
        expect(screen.getByText("Setting up VSCode...")).toBeInTheDocument();
      });
    });

    it("updates setup screen on progress event via on('setup:progress')", async () => {
      // Setup mode - lifecycle.getState returns "setup"
      mockApi.lifecycle.getState.mockResolvedValue("setup");
      // Keep setup running indefinitely to see progress
      mockApi.lifecycle.setup.mockReturnValue(new Promise(() => {}));

      render(App);

      await waitFor(() => {
        expect(getEventCallback("setup:progress")).toBeDefined();
      });

      // Simulate progress event via api.on("setup:progress", ...)
      fireEvent("setup:progress", {
        step: "extensions",
        message: "Installing OpenCode extension...",
      });

      await waitFor(() => {
        expect(screen.getByText("Installing OpenCode extension...")).toBeInTheDocument();
      });
    });

    it("shows SetupComplete when lifecycle.setup() returns success", async () => {
      // Setup mode - lifecycle.getState returns "setup"
      mockApi.lifecycle.getState.mockResolvedValue("setup");
      // Setup completes successfully
      mockApi.lifecycle.setup.mockResolvedValue({ success: true });

      render(App);

      // Should show setup complete after setup() resolves
      await waitFor(() => {
        expect(screen.getByText("Setup complete!")).toBeInTheDocument();
      });
    });

    it("shows SetupError when lifecycle.setup() returns failure", async () => {
      // Setup mode - lifecycle.getState returns "setup"
      mockApi.lifecycle.getState.mockResolvedValue("setup");
      // Setup fails
      mockApi.lifecycle.setup.mockResolvedValue({
        success: false,
        message: "Network error",
        code: "NETWORK_ERROR",
      });

      render(App);

      await waitFor(() => {
        expect(screen.getByText("Setup Failed")).toBeInTheDocument();
        expect(screen.getByText("Error: Network error")).toBeInTheDocument();
      });
    });

    it("calls lifecycle.setup() when Retry button clicked on error screen", async () => {
      // Setup mode - lifecycle.getState returns "setup"
      mockApi.lifecycle.getState.mockResolvedValue("setup");
      // First setup fails, second succeeds
      mockApi.lifecycle.setup
        .mockResolvedValueOnce({
          success: false,
          message: "Failed",
          code: "NETWORK_ERROR",
        })
        .mockResolvedValueOnce({ success: true });

      render(App);

      // Wait for error screen
      await waitFor(() => {
        expect(screen.getByText("Setup Failed")).toBeInTheDocument();
      });

      // Clear mock to track retry call
      mockApi.lifecycle.setup.mockClear();
      mockApi.lifecycle.setup.mockResolvedValue({ success: true });

      // Click retry button
      const retryButton = screen.getByRole("button", { name: "Retry" });
      retryButton.click();

      await waitFor(() => {
        expect(mockApi.lifecycle.setup).toHaveBeenCalledTimes(1);
      });
    });

    it("calls lifecycle.quit() when Quit button clicked on error screen", async () => {
      // Setup mode - lifecycle.getState returns "setup"
      mockApi.lifecycle.getState.mockResolvedValue("setup");
      // Setup fails
      mockApi.lifecycle.setup.mockResolvedValue({
        success: false,
        message: "Failed",
        code: "NETWORK_ERROR",
      });

      render(App);

      // Wait for error screen
      await waitFor(() => {
        expect(screen.getByText("Setup Failed")).toBeInTheDocument();
      });

      // Click quit button
      const quitButton = screen.getByRole("button", { name: "Quit" });
      quitButton.click();

      expect(mockApi.lifecycle.quit).toHaveBeenCalledTimes(1);
    });

    it("transitions to normal app when state is 'ready'", async () => {
      // Normal mode - lifecycle.getState returns "ready"
      mockApi.lifecycle.getState.mockResolvedValue("ready");
      mockApi.projects.list.mockResolvedValue([]);

      render(App);

      // Should show Sidebar (normal app)
      await waitFor(() => {
        expect(screen.getByRole("navigation", { name: "Projects" })).toBeInTheDocument();
      });

      // Should NOT show setup screen
      expect(screen.queryByText("Setting up VSCode...")).not.toBeInTheDocument();
    });

    it("handles setup progress events during active setup", async () => {
      // Setup mode - lifecycle.getState returns "setup"
      mockApi.lifecycle.getState.mockResolvedValue("setup");
      // Keep setup running to receive progress events
      let resolveSetup: (value: { success: boolean }) => void;
      mockApi.lifecycle.setup.mockReturnValue(
        new Promise((resolve) => {
          resolveSetup = resolve;
        })
      );

      render(App);

      // Wait for setup to start and progress subscription
      await waitFor(() => {
        expect(getEventCallback("setup:progress")).toBeDefined();
      });

      // Simulate multiple progress events
      fireEvent("setup:progress", { step: "extensions", message: "Installing extensions..." });

      await waitFor(() => {
        expect(screen.getByText("Installing extensions...")).toBeInTheDocument();
      });

      fireEvent("setup:progress", { step: "settings", message: "Configuring settings..." });

      await waitFor(() => {
        expect(screen.getByText("Configuring settings...")).toBeInTheDocument();
      });

      // Complete setup
      resolveSetup!({ success: true });

      await waitFor(() => {
        expect(screen.getByText("Setup complete!")).toBeInTheDocument();
      });
    });
  });
});
