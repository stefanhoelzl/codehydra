/**
 * Tests for the shortcuts store.
 * Tests shortcut mode state and handlers.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Create mock API functions with vi.hoisted for proper hoisting
// Uses flat API namespace (no longer nested under v2)
const mockApi = vi.hoisted(() => ({
  ui: {
    switchWorkspace: vi.fn().mockResolvedValue(undefined),
    setMode: vi.fn().mockResolvedValue(undefined),
  },
  projects: {
    open: vi.fn().mockResolvedValue(undefined),
  },
  workspaces: {
    hibernate: vi.fn().mockResolvedValue(undefined),
    wake: vi.fn().mockResolvedValue(undefined),
    reopen: vi.fn().mockResolvedValue(undefined),
  },
}));

// Create mock dialog state with vi.hoisted
// Using Record<string, unknown> to allow flexible reassignment in tests
const mockDialogState = vi.hoisted(() => ({
  dialogState: {
    value: { type: "closed" } as Record<string, unknown>,
  },
  openRemoveDialog: vi.fn(),
}));

// Mock the New workspace view store
const mockNewWorkspaceView = vi.hoisted(() => ({
  newWorkspaceView: { isOpen: false as boolean },
  openNewWorkspaceView: vi.fn(),
  closeNewWorkspaceView: vi.fn(),
}));

// Create mock workspace type for testing
interface MockWorkspace {
  path: string;
  name: string;
  branch: string | null;
}

// WorkspaceRef type for mocking
interface MockWorkspaceRef {
  projectId: string;
  workspaceName: string;
  path: string;
}

// Create mock projects store functions
const mockProjectsStore = vi.hoisted(() => ({
  getAllWorkspaces: vi.fn((): MockWorkspace[] => []),
  getWorkspaceRefByIndex: vi.fn((index: number): MockWorkspaceRef | undefined => {
    void index;
    return undefined;
  }),
  getAwakeWorkspaceRefByIndex: vi.fn((index: number): MockWorkspaceRef | undefined => {
    void index;
    return undefined;
  }),
  findWorkspaceIndex: vi.fn((path: string | null): number => {
    void path;
    return -1;
  }),
  wrapIndex: vi.fn((i: number, l: number) => ((i % l) + l) % l),
  activeWorkspacePath: { value: null as string | null },
  activeProject: { value: null as { id: string; path: string } | null },
  // activeWorkspace is now used for remove dialog
  activeWorkspace: { value: null as MockWorkspaceRef | null },
  // projects list for fallback when activeProject is null
  projects: { value: [] as { id: string; path: string }[] },
  // Eager set used by navigation handlers to avoid empty-backdrop flicker
  // after the New workspace view cleared the active workspace on open.
  setActiveWorkspace: vi.fn(),
}));

// Mock the API module before any imports use it
vi.mock("$lib/api", () => mockApi);

// Mock the dialogs store
vi.mock("./dialogs.svelte", () => mockDialogState);

// Mock the New workspace view store
vi.mock("./new-workspace-view.svelte", () => mockNewWorkspaceView);

// Mock the projects store
vi.mock("./projects.svelte", () => mockProjectsStore);

// Create mock workspace lifecycle store with vi.hoisted
const mockLifecycleStore = vi.hoisted(() => ({
  getLifecycle: vi.fn(() => "none" as "none" | "creating" | "deleting" | "delete-failed"),
}));

// Mock the workspace lifecycle store
vi.mock("./workspace-lifecycle.svelte", () => mockLifecycleStore);

// AgentStatus type for mock return values
type AgentStatus =
  | { type: "none" }
  | { type: "idle"; counts: { idle: number; busy: number; total: number } }
  | { type: "busy"; counts: { idle: number; busy: number; total: number } }
  | { type: "mixed"; counts: { idle: number; busy: number; total: number } };

// Create mock agent status store with vi.hoisted
const mockAgentStatusStore = vi.hoisted(() => ({
  getStatus: vi.fn().mockReturnValue({ type: "none" } as AgentStatus),
}));

// Mock the agent status store
vi.mock("./agent-status.svelte", () => mockAgentStatusStore);

// Import after mock setup
import {
  handleModeChange,
  handleKeyDown,
  handleWindowBlur,
  handleShortcutKey,
  reset,
} from "./shortcuts.svelte";
import { shortcutModeActive, uiMode } from "./ui-mode.svelte";

// Helper to enable shortcut mode via ui:mode-changed event
function enableShortcutMode(): void {
  handleModeChange({ mode: "shortcut", previousMode: "workspace" });
}

// Helper to disable shortcut mode via ui:mode-changed event
function disableShortcutMode(): void {
  handleModeChange({ mode: "workspace", previousMode: "shortcut" });
}

describe("shortcuts store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reset(); // Reset store state between tests
    // Reset dialog state to closed
    mockDialogState.dialogState.value = { type: "closed" };
    // Reset New workspace view to closed
    mockNewWorkspaceView.newWorkspaceView.isOpen = false;
    // Reset lifecycle status to "none"
    mockLifecycleStore.getLifecycle.mockReturnValue("none");
  });

  describe("initial state", () => {
    it("should-have-inactive-state-initially: shortcutModeActive.value is false initially", () => {
      expect(shortcutModeActive.value).toBe(false);
    });

    it("should-have-workspace-uiMode-initially: uiMode.value is 'workspace' initially", () => {
      expect(uiMode.value).toBe("workspace");
    });
  });

  describe("uiMode", () => {
    it("uiMode tracks mode from handleModeChange event", () => {
      // Initially workspace
      expect(uiMode.value).toBe("workspace");

      // Change to shortcut
      handleModeChange({ mode: "shortcut", previousMode: "workspace" });
      expect(uiMode.value).toBe("shortcut");

      // Change to dialog
      handleModeChange({ mode: "dialog", previousMode: "shortcut" });
      expect(uiMode.value).toBe("dialog");

      // Change back to workspace
      handleModeChange({ mode: "workspace", previousMode: "dialog" });
      expect(uiMode.value).toBe("workspace");
    });

    it("shortcutModeActive derives correctly from uiMode", () => {
      // workspace mode
      handleModeChange({ mode: "workspace", previousMode: "workspace" });
      expect(shortcutModeActive.value).toBe(false);
      expect(uiMode.value).toBe("workspace");

      // shortcut mode
      handleModeChange({ mode: "shortcut", previousMode: "workspace" });
      expect(shortcutModeActive.value).toBe(true);
      expect(uiMode.value).toBe("shortcut");

      // dialog mode
      handleModeChange({ mode: "dialog", previousMode: "shortcut" });
      expect(shortcutModeActive.value).toBe(false);
      expect(uiMode.value).toBe("dialog");
    });
  });

  describe("handleModeChange", () => {
    it("should-enable-shortcut-mode-on-mode-change: handleModeChange with shortcut mode sets active to true", () => {
      enableShortcutMode();
      expect(shortcutModeActive.value).toBe(true);
    });

    it("should-disable-shortcut-mode-on-workspace-mode: handleModeChange with workspace mode sets active to false", () => {
      // First enable shortcut mode
      enableShortcutMode();
      expect(shortcutModeActive.value).toBe(true);

      disableShortcutMode();

      expect(shortcutModeActive.value).toBe(false);
    });

    it("should-set-inactive-for-dialog-mode: handleModeChange with dialog mode sets active to false", () => {
      // First enable shortcut mode
      enableShortcutMode();
      expect(shortcutModeActive.value).toBe(true);

      // Dialog mode from main process sets active to false
      handleModeChange({ mode: "dialog", previousMode: "shortcut" });

      expect(shortcutModeActive.value).toBe(false);
    });
  });

  describe("handleWindowBlur", () => {
    it("should-exit-shortcut-mode-on-window-blur: handleWindowBlur calls setMode('workspace')", () => {
      // First enable shortcut mode
      enableShortcutMode();
      expect(shortcutModeActive.value).toBe(true);

      handleWindowBlur();

      expect(shortcutModeActive.value).toBe(false);
      expect(mockApi.ui.setMode).toHaveBeenCalledWith("workspace");
    });

    it("handleWindowBlur when inactive is no-op", () => {
      handleWindowBlur();

      expect(shortcutModeActive.value).toBe(false);
      expect(mockApi.ui.setMode).not.toHaveBeenCalled();
    });

    // NOTE: These tests use handleShortcutKey to trigger navigation/jump which sets _switchingWorkspace
    it("should-not-exit-shortcut-mode-on-blur-during-navigation", async () => {
      // Setup workspaces for navigation
      const workspaces = [
        { path: "/ws1", name: "ws1", branch: null },
        { path: "/ws2", name: "ws2", branch: null },
      ];
      const workspaceRefs: MockWorkspaceRef[] = [
        { projectId: "test-project-12345678", workspaceName: "ws1", path: "/ws1" },
        { projectId: "test-project-12345678", workspaceName: "ws2", path: "/ws2" },
      ];
      mockProjectsStore.getAllWorkspaces.mockReturnValue(workspaces);
      mockProjectsStore.getWorkspaceRefByIndex.mockImplementation((i: number) => workspaceRefs[i]);
      mockProjectsStore.findWorkspaceIndex.mockReturnValue(0);
      mockProjectsStore.activeWorkspacePath.value = "/ws1";

      // Make switchWorkspace slow so we can test blur during switch
      let resolveSwitch: () => void;
      mockApi.ui.switchWorkspace.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolveSwitch = resolve;
          })
      );

      enableShortcutMode();
      expect(shortcutModeActive.value).toBe(true);

      // Start navigation (this sets _switchingWorkspace = true)
      handleShortcutKey("down");

      // Simulate blur event during workspace switch (Electron triggers this)
      handleWindowBlur();

      // Should NOT exit shortcut mode because we're switching workspaces
      expect(shortcutModeActive.value).toBe(true);
      expect(mockApi.ui.setMode).not.toHaveBeenCalled();

      // Complete the switch
      resolveSwitch!();
      await Promise.resolve();
    });

    it("should-not-exit-shortcut-mode-on-blur-during-jump", async () => {
      // Setup workspaces for jump
      const workspaces = [
        { path: "/ws1", name: "ws1", branch: null },
        { path: "/ws2", name: "ws2", branch: null },
      ];
      const workspaceRefs: MockWorkspaceRef[] = [
        { projectId: "test-project-12345678", workspaceName: "ws1", path: "/ws1" },
        { projectId: "test-project-12345678", workspaceName: "ws2", path: "/ws2" },
      ];
      mockProjectsStore.getAllWorkspaces.mockReturnValue(workspaces);
      mockProjectsStore.getAwakeWorkspaceRefByIndex.mockImplementation(
        (i: number) => workspaceRefs[i]
      );

      // Make switchWorkspace slow so we can test blur during switch
      let resolveSwitch: () => void;
      mockApi.ui.switchWorkspace.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolveSwitch = resolve;
          })
      );

      enableShortcutMode();
      expect(shortcutModeActive.value).toBe(true);

      // Start jump (this sets _switchingWorkspace = true)
      handleShortcutKey("2");

      // Simulate blur event during workspace switch (Electron triggers this)
      handleWindowBlur();

      // Should NOT exit shortcut mode because we're switching workspaces
      expect(shortcutModeActive.value).toBe(true);
      expect(mockApi.ui.setMode).not.toHaveBeenCalled();

      // Complete the switch
      resolveSwitch!();
      await Promise.resolve();
    });

    it("should-exit-shortcut-mode-on-blur-when-not-switching", () => {
      enableShortcutMode();
      expect(shortcutModeActive.value).toBe(true);

      // Blur without any navigation/jump in progress
      handleWindowBlur();

      // Should exit shortcut mode normally
      expect(shortcutModeActive.value).toBe(false);
      expect(mockApi.ui.setMode).toHaveBeenCalledWith("workspace");
    });
  });

  describe("exitShortcutMode API calls", () => {
    it("should-call-setMode-workspace-on-exit: exitShortcutMode calls api.ui.setMode('workspace')", () => {
      enableShortcutMode();
      handleWindowBlur(); // Uses exitShortcutMode internally

      expect(mockApi.ui.setMode).toHaveBeenCalledWith("workspace");
    });
  });

  describe("edge cases", () => {
    it("should-handle-rapid-mode-toggle: rapid state changes remain consistent", () => {
      enableShortcutMode();
      expect(shortcutModeActive.value).toBe(true);

      disableShortcutMode();
      expect(shortcutModeActive.value).toBe(false);

      enableShortcutMode();
      expect(shortcutModeActive.value).toBe(true);

      disableShortcutMode();
      expect(shortcutModeActive.value).toBe(false);

      // After all toggles, state should be consistent (mode changes don't call setMode since they're events from main process)
    });

    it("should-reset-state-for-testing: reset() sets state to false", () => {
      enableShortcutMode();
      expect(shortcutModeActive.value).toBe(true);

      reset();
      expect(shortcutModeActive.value).toBe(false);
    });
  });

  describe("handleKeyDown", () => {
    // NOTE: handleKeyDown now ONLY handles Escape key. All other action keys
    // come via handleShortcutKey from main process events (Stage 2).
    beforeEach(() => {
      // Reset projects store mocks
      mockProjectsStore.getAllWorkspaces.mockReturnValue([]);
      mockProjectsStore.getWorkspaceRefByIndex.mockReturnValue(undefined);
      mockProjectsStore.findWorkspaceIndex.mockReturnValue(-1);
      mockProjectsStore.activeWorkspacePath.value = null;
      mockProjectsStore.activeProject.value = null;
      mockProjectsStore.projects.value = [];
    });

    it("should-ignore-keydown-when-shortcut-mode-inactive", () => {
      const event = new KeyboardEvent("keydown", { key: "Escape" });
      const preventDefaultSpy = vi.spyOn(event, "preventDefault");

      handleKeyDown(event);

      // Should not do anything when shortcut mode is inactive
      expect(preventDefaultSpy).not.toHaveBeenCalled();
      expect(mockApi.ui.setMode).not.toHaveBeenCalled();
    });

    it("should-only-handle-escape-key", () => {
      enableShortcutMode();
      // Non-Escape keys are ignored by handleKeyDown (they come via handleShortcutKey)
      const event = new KeyboardEvent("keydown", { key: "ArrowDown" });
      const preventDefaultSpy = vi.spyOn(event, "preventDefault");

      handleKeyDown(event);

      expect(preventDefaultSpy).not.toHaveBeenCalled();
    });

    it("should-exit-shortcut-mode-on-escape", () => {
      enableShortcutMode();
      expect(shortcutModeActive.value).toBe(true);

      const event = new KeyboardEvent("keydown", { key: "Escape" });
      handleKeyDown(event);

      expect(shortcutModeActive.value).toBe(false);
      expect(mockApi.ui.setMode).toHaveBeenCalledWith("workspace");
    });

    describe("navigation actions", () => {
      const createWorkspaces = () => [
        { path: "/ws1", name: "ws1", branch: null },
        { path: "/ws2", name: "ws2", branch: null },
        { path: "/ws3", name: "ws3", branch: null },
      ];

      const createWorkspaceRefs = (): MockWorkspaceRef[] => [
        { projectId: "test-project-12345678", workspaceName: "ws1", path: "/ws1" },
        { projectId: "test-project-12345678", workspaceName: "ws2", path: "/ws2" },
        { projectId: "test-project-12345678", workspaceName: "ws3", path: "/ws3" },
      ];

      it("should-navigate-from-no-active-workspace-down → first (panel open)", async () => {
        // When the New workspace view is the current tab, activeWorkspacePath is null.
        const workspaces = createWorkspaces();
        const workspaceRefs = createWorkspaceRefs();
        mockProjectsStore.getAllWorkspaces.mockReturnValue(workspaces);
        mockProjectsStore.getWorkspaceRefByIndex.mockImplementation(
          (i: number) => workspaceRefs[i]
        );
        mockProjectsStore.findWorkspaceIndex.mockReturnValue(-1);
        mockProjectsStore.activeWorkspacePath.value = null;

        enableShortcutMode();
        handleShortcutKey("down");

        await vi.waitFor(() => {
          expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith("/ws1", false);
        });
      });

      it("should-navigate-from-no-active-workspace-up → last (panel open)", async () => {
        const workspaces = createWorkspaces();
        const workspaceRefs = createWorkspaceRefs();
        mockProjectsStore.getAllWorkspaces.mockReturnValue(workspaces);
        mockProjectsStore.getWorkspaceRefByIndex.mockImplementation(
          (i: number) => workspaceRefs[i]
        );
        mockProjectsStore.findWorkspaceIndex.mockReturnValue(-1);
        mockProjectsStore.activeWorkspacePath.value = null;

        enableShortcutMode();
        handleShortcutKey("up");

        await vi.waitFor(() => {
          expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith("/ws3", false);
        });
      });

      it("should-navigate-to-next-workspace-on-down", async () => {
        const workspaces = createWorkspaces();
        const workspaceRefs = createWorkspaceRefs();
        mockProjectsStore.getAllWorkspaces.mockReturnValue(workspaces);
        mockProjectsStore.getWorkspaceRefByIndex.mockImplementation(
          (i: number) => workspaceRefs[i]
        );
        mockProjectsStore.findWorkspaceIndex.mockReturnValue(0);
        mockProjectsStore.activeWorkspacePath.value = "/ws1";

        enableShortcutMode();
        handleShortcutKey("down");

        // Wait for async action to complete
        await vi.waitFor(() => {
          // Should pass workspacePath and false to keep shortcut mode active
          expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith("/ws2", false);
        });
      });

      // NOTE: Navigation tests use handleShortcutKey with normalized keys ("up", "down")
      // since key normalization happens in main process before event is sent.
      it("should-navigate-to-previous-workspace-on-arrow-up", async () => {
        const workspaces = createWorkspaces();
        const workspaceRefs = createWorkspaceRefs();
        mockProjectsStore.getAllWorkspaces.mockReturnValue(workspaces);
        mockProjectsStore.getWorkspaceRefByIndex.mockImplementation(
          (i: number) => workspaceRefs[i]
        );
        mockProjectsStore.findWorkspaceIndex.mockReturnValue(1);
        mockProjectsStore.activeWorkspacePath.value = "/ws2";

        enableShortcutMode();
        handleShortcutKey("up");

        await vi.waitFor(() => {
          // Should pass workspacePath and false to keep shortcut mode active
          expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith("/ws1", false);
        });
      });

      it("should-wrap-to-last-workspace-when-navigating-up-from-first", async () => {
        const workspaces = createWorkspaces();
        const workspaceRefs = createWorkspaceRefs();
        mockProjectsStore.getAllWorkspaces.mockReturnValue(workspaces);
        mockProjectsStore.getWorkspaceRefByIndex.mockImplementation(
          (i: number) => workspaceRefs[i]
        );
        mockProjectsStore.findWorkspaceIndex.mockReturnValue(0);
        mockProjectsStore.activeWorkspacePath.value = "/ws1";

        enableShortcutMode();
        handleShortcutKey("up");

        await vi.waitFor(() => {
          // Should pass workspacePath and false to keep shortcut mode active
          expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith("/ws3", false);
        });
      });

      it("should-wrap-to-first-workspace-when-navigating-down-from-last", async () => {
        const workspaces = createWorkspaces();
        const workspaceRefs = createWorkspaceRefs();
        mockProjectsStore.getAllWorkspaces.mockReturnValue(workspaces);
        mockProjectsStore.getWorkspaceRefByIndex.mockImplementation(
          (i: number) => workspaceRefs[i]
        );
        mockProjectsStore.findWorkspaceIndex.mockReturnValue(2);
        mockProjectsStore.activeWorkspacePath.value = "/ws3";

        enableShortcutMode();
        handleShortcutKey("down");

        await vi.waitFor(() => {
          // Should pass workspacePath and false to keep shortcut mode active
          expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith("/ws1", false);
        });
      });

      it("should-not-navigate-when-no-workspaces", () => {
        mockProjectsStore.getAllWorkspaces.mockReturnValue([]);

        enableShortcutMode();
        handleShortcutKey("down");

        expect(mockApi.ui.switchWorkspace).not.toHaveBeenCalled();
      });

      it("should-not-navigate-when-single-workspace", () => {
        mockProjectsStore.getAllWorkspaces.mockReturnValue([
          { path: "/ws1", name: "ws1", branch: null },
        ]);

        enableShortcutMode();
        handleShortcutKey("down");

        expect(mockApi.ui.switchWorkspace).not.toHaveBeenCalled();
      });

      it("should-navigate-to-idle-workspace-on-left-arrow", async () => {
        const workspaces = createWorkspaces();
        const workspaceRefs = createWorkspaceRefs();
        mockProjectsStore.getAllWorkspaces.mockReturnValue(workspaces);
        mockProjectsStore.getWorkspaceRefByIndex.mockImplementation(
          (i: number) => workspaceRefs[i]
        );
        mockProjectsStore.findWorkspaceIndex.mockReturnValue(1);
        mockProjectsStore.activeWorkspacePath.value = "/ws2";

        // ws1 is idle, ws2 is current, ws3 is busy
        mockAgentStatusStore.getStatus.mockImplementation((path: string) => {
          if (path === "/ws1") return { type: "idle", counts: { idle: 1, busy: 0, total: 1 } };
          if (path === "/ws3") return { type: "busy", counts: { idle: 0, busy: 1, total: 1 } };
          return { type: "none" };
        });

        enableShortcutMode();
        handleShortcutKey("left");

        await vi.waitFor(() => {
          expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith("/ws1", false);
        });
      });

      it("should-navigate-to-idle-workspace-on-right-arrow", async () => {
        const workspaces = createWorkspaces();
        const workspaceRefs = createWorkspaceRefs();
        mockProjectsStore.getAllWorkspaces.mockReturnValue(workspaces);
        mockProjectsStore.getWorkspaceRefByIndex.mockImplementation(
          (i: number) => workspaceRefs[i]
        );
        mockProjectsStore.findWorkspaceIndex.mockReturnValue(0);
        mockProjectsStore.activeWorkspacePath.value = "/ws1";

        // ws1 is current, ws2 is busy, ws3 is idle
        mockAgentStatusStore.getStatus.mockImplementation((path: string) => {
          if (path === "/ws2") return { type: "busy", counts: { idle: 0, busy: 1, total: 1 } };
          if (path === "/ws3") return { type: "idle", counts: { idle: 1, busy: 0, total: 1 } };
          return { type: "none" };
        });

        enableShortcutMode();
        handleShortcutKey("right");

        await vi.waitFor(() => {
          // Should skip ws2 (busy) and go to ws3 (idle)
          expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith("/ws3", false);
        });
      });

      it("should-navigate-to-busy-workspace-when-no-idle-exist", async () => {
        const workspaces = createWorkspaces();
        const workspaceRefs = createWorkspaceRefs();
        mockProjectsStore.getAllWorkspaces.mockReturnValue(workspaces);
        mockProjectsStore.getWorkspaceRefByIndex.mockImplementation(
          (i: number) => workspaceRefs[i]
        );
        mockProjectsStore.findWorkspaceIndex.mockReturnValue(0);
        mockProjectsStore.activeWorkspacePath.value = "/ws1";

        // All other workspaces are busy - should fall back to busy navigation
        mockAgentStatusStore.getStatus.mockImplementation((path: string) => {
          if (path === "/ws2" || path === "/ws3") {
            return { type: "busy", counts: { idle: 0, busy: 1, total: 1 } };
          }
          return { type: "none" };
        });

        enableShortcutMode();
        handleShortcutKey("left");

        await vi.waitFor(() => {
          // Left from ws1 wraps to ws3 (busy)
          expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith("/ws3", false);
        });
      });

      it("should-prefer-idle-over-busy-when-both-exist", async () => {
        const workspaces = createWorkspaces();
        const workspaceRefs = createWorkspaceRefs();
        mockProjectsStore.getAllWorkspaces.mockReturnValue(workspaces);
        mockProjectsStore.getWorkspaceRefByIndex.mockImplementation(
          (i: number) => workspaceRefs[i]
        );
        mockProjectsStore.findWorkspaceIndex.mockReturnValue(0);
        mockProjectsStore.activeWorkspacePath.value = "/ws1";

        // ws2 is busy, ws3 is idle - should navigate to idle ws3
        mockAgentStatusStore.getStatus.mockImplementation((path: string) => {
          if (path === "/ws2") return { type: "busy", counts: { idle: 0, busy: 1, total: 1 } };
          if (path === "/ws3") return { type: "idle", counts: { idle: 1, busy: 0, total: 1 } };
          return { type: "none" };
        });

        enableShortcutMode();
        handleShortcutKey("right");

        await vi.waitFor(() => {
          // Should skip ws2 (busy) and go to ws3 (idle)
          expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith("/ws3", false);
        });
      });

      it("should-not-fall-back-to-busy-when-current-workspace-is-idle", () => {
        const workspaces = createWorkspaces();
        const workspaceRefs = createWorkspaceRefs();
        mockProjectsStore.getAllWorkspaces.mockReturnValue(workspaces);
        mockProjectsStore.getWorkspaceRefByIndex.mockImplementation(
          (i: number) => workspaceRefs[i]
        );
        mockProjectsStore.findWorkspaceIndex.mockReturnValue(0);
        mockProjectsStore.activeWorkspacePath.value = "/ws1";

        // ws1 (current) is idle, others are busy - should NOT jump to busy
        mockAgentStatusStore.getStatus.mockImplementation((path: string) => {
          if (path === "/ws1") return { type: "idle", counts: { idle: 1, busy: 0, total: 1 } };
          return { type: "busy", counts: { idle: 0, busy: 1, total: 1 } };
        });

        enableShortcutMode();
        handleShortcutKey("right");

        expect(mockApi.ui.switchWorkspace).not.toHaveBeenCalled();
      });

      it("should-not-navigate-when-all-workspaces-are-none", () => {
        const workspaces = createWorkspaces();
        const workspaceRefs = createWorkspaceRefs();
        mockProjectsStore.getAllWorkspaces.mockReturnValue(workspaces);
        mockProjectsStore.getWorkspaceRefByIndex.mockImplementation(
          (i: number) => workspaceRefs[i]
        );
        mockProjectsStore.findWorkspaceIndex.mockReturnValue(0);
        mockProjectsStore.activeWorkspacePath.value = "/ws1";

        // All workspaces have no agent status
        mockAgentStatusStore.getStatus.mockReturnValue({ type: "none" });

        enableShortcutMode();
        handleShortcutKey("left");

        expect(mockApi.ui.switchWorkspace).not.toHaveBeenCalled();
      });

      it("should-find-newly-idle-workspace-after-status-change", async () => {
        const workspaces = createWorkspaces();
        const workspaceRefs = createWorkspaceRefs();
        mockProjectsStore.getAllWorkspaces.mockReturnValue(workspaces);
        mockProjectsStore.getWorkspaceRefByIndex.mockImplementation(
          (i: number) => workspaceRefs[i]
        );
        mockProjectsStore.findWorkspaceIndex.mockReturnValue(0);
        mockProjectsStore.activeWorkspacePath.value = "/ws1";

        // Initially all workspaces have no agents
        mockAgentStatusStore.getStatus.mockReturnValue({ type: "none" });

        enableShortcutMode();
        handleShortcutKey("right");

        // No idle or busy workspaces, so no navigation
        expect(mockApi.ui.switchWorkspace).not.toHaveBeenCalled();

        // Now ws2 becomes idle (simulate status change)
        mockAgentStatusStore.getStatus.mockImplementation((path: string) => {
          if (path === "/ws2") return { type: "idle", counts: { idle: 1, busy: 0, total: 1 } };
          return { type: "none" };
        });

        // Press right again - should now find ws2
        handleShortcutKey("right");

        await vi.waitFor(() => {
          expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith("/ws2", false);
        });
      });

      it("should-prevent-concurrent-navigation-during-rapid-keypresses", async () => {
        const workspaces = createWorkspaces();
        const workspaceRefs = createWorkspaceRefs();
        mockProjectsStore.getAllWorkspaces.mockReturnValue(workspaces);
        mockProjectsStore.getWorkspaceRefByIndex.mockImplementation(
          (i: number) => workspaceRefs[i]
        );
        mockProjectsStore.findWorkspaceIndex.mockReturnValue(0);
        mockProjectsStore.activeWorkspacePath.value = "/ws1";

        // Make switchWorkspace slow
        let resolveSwitch: () => void;
        mockApi.ui.switchWorkspace.mockImplementation(
          () =>
            new Promise<void>((resolve) => {
              resolveSwitch = resolve;
            })
        );

        enableShortcutMode();

        // Fire rapid keypresses (now via handleShortcutKey)
        handleShortcutKey("down");
        handleShortcutKey("down");
        handleShortcutKey("down");

        // Only first should have been called
        expect(mockApi.ui.switchWorkspace).toHaveBeenCalledTimes(1);

        // Complete the switch
        resolveSwitch!();
        await Promise.resolve();
      });
    });

    describe("jump actions", () => {
      // NOTE: Jump tests use handleShortcutKey with digit keys ("0"-"9")
      // since these come from main process events.
      const createWorkspaces = (count: number) =>
        Array.from({ length: count }, (_, i) => ({
          path: `/ws${i + 1}`,
          name: `ws${i + 1}`,
          branch: null,
        }));

      const createWorkspaceRefs = (count: number): MockWorkspaceRef[] =>
        Array.from({ length: count }, (_, i) => ({
          projectId: "test-project-12345678",
          workspaceName: `ws${i + 1}`,
          path: `/ws${i + 1}`,
        }));

      it("should-jump-to-workspace-1-through-9", async () => {
        const workspaces = createWorkspaces(9);
        const workspaceRefs = createWorkspaceRefs(9);
        mockProjectsStore.getAllWorkspaces.mockReturnValue(workspaces);
        mockProjectsStore.getAwakeWorkspaceRefByIndex.mockImplementation(
          (i: number) => workspaceRefs[i]
        );

        enableShortcutMode();

        // Test key "5" -> index 4 -> workspace 5
        handleShortcutKey("5");

        await vi.waitFor(() => {
          // Should pass workspacePath and false to keep shortcut mode active
          expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith("/ws5", false);
        });
      });

      it("should-jump-to-workspace-10-on-key-0", async () => {
        const workspaces = createWorkspaces(10);
        const workspaceRefs = createWorkspaceRefs(10);
        mockProjectsStore.getAllWorkspaces.mockReturnValue(workspaces);
        mockProjectsStore.getAwakeWorkspaceRefByIndex.mockImplementation(
          (i: number) => workspaceRefs[i]
        );

        enableShortcutMode();
        handleShortcutKey("0");

        await vi.waitFor(() => {
          // Should pass workspacePath and false to keep shortcut mode active
          expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith("/ws10", false);
        });
      });

      it("should-not-jump-when-index-out-of-range", () => {
        const workspaces = createWorkspaces(3);
        const workspaceRefs = createWorkspaceRefs(3);
        mockProjectsStore.getAllWorkspaces.mockReturnValue(workspaces);
        mockProjectsStore.getAwakeWorkspaceRefByIndex.mockImplementation(
          (i: number) => workspaceRefs[i]
        );

        enableShortcutMode();
        // Try to jump to workspace 5 when only 3 exist
        handleShortcutKey("5");

        expect(mockApi.ui.switchWorkspace).not.toHaveBeenCalled();
      });

      it("should-target-awake-list-skipping-hibernated", async () => {
        // 4 workspaces in list; getAwakeWorkspaceRefByIndex resolves index 1
        // to ws3 (the second awake workspace) — proves jump uses the awake-only mapping.
        const workspaces = createWorkspaces(4);
        const workspaceRefs = createWorkspaceRefs(4);
        mockProjectsStore.getAllWorkspaces.mockReturnValue(workspaces);
        mockProjectsStore.getAwakeWorkspaceRefByIndex.mockImplementation((i: number) => {
          // index 0 -> ws1, index 1 -> ws3 (skipping hibernated ws2)
          if (i === 0) return workspaceRefs[0];
          if (i === 1) return workspaceRefs[2];
          return undefined;
        });

        enableShortcutMode();
        handleShortcutKey("2");

        await vi.waitFor(() => {
          expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith("/ws3", false);
        });
      });
    });

    describe("dialog actions", () => {
      // NOTE: Dialog tests use handleShortcutKey with normalized keys ("enter", "delete")
      // since these come from main process events. Backspace is normalized to "delete" by main process.
      it("should-open-new-workspace-view-on-enter (no project pre-fill)", () => {
        mockProjectsStore.activeProject.value = { id: "project-12345678", path: "/project" };
        mockNewWorkspaceView.newWorkspaceView.isOpen = false;

        enableShortcutMode();
        expect(shortcutModeActive.value).toBe(true);

        handleShortcutKey("enter");

        // Opens the New workspace view with no project pre-fill (no args).
        expect(mockNewWorkspaceView.openNewWorkspaceView).toHaveBeenCalledWith();
        expect(shortcutModeActive.value).toBe(false);
      });

      it("should-do-nothing-on-enter-when-view-already-open", () => {
        // Already on the New workspace view: keyboard submit is Cmd/Ctrl+Enter
        // (owned by the form), not Alt+X+Enter.
        mockNewWorkspaceView.newWorkspaceView.isOpen = true;

        enableShortcutMode();
        handleShortcutKey("enter");

        expect(mockNewWorkspaceView.openNewWorkspaceView).not.toHaveBeenCalled();
      });

      it("should-open-remove-dialog-on-delete", () => {
        // Now uses activeWorkspace (WorkspaceRef) instead of activeWorkspacePath
        const workspaceRef = {
          projectId: "project-12345678",
          workspaceName: "feature",
          path: "/workspace",
        };
        mockProjectsStore.activeWorkspace.value = workspaceRef;

        enableShortcutMode();
        expect(shortcutModeActive.value).toBe(true);

        handleShortcutKey("delete");

        // Now passes WorkspaceRef instead of path
        expect(mockDialogState.openRemoveDialog).toHaveBeenCalledWith(workspaceRef);
        expect(shortcutModeActive.value).toBe(false);
      });

      it("should-not-open-remove-dialog-when-no-active-workspace", () => {
        mockProjectsStore.activeWorkspace.value = null;

        enableShortcutMode();
        handleShortcutKey("delete");

        expect(mockDialogState.openRemoveDialog).not.toHaveBeenCalled();
      });

      it("should-not-open-remove-dialog-when-deletion-in-progress", () => {
        const workspaceRef = {
          projectId: "project-12345678",
          workspaceName: "feature",
          path: "/workspace",
        };
        mockProjectsStore.activeWorkspace.value = workspaceRef;
        // Mock getLifecycle to return "deleting"
        mockLifecycleStore.getLifecycle.mockReturnValue("deleting");

        enableShortcutMode();
        expect(shortcutModeActive.value).toBe(true);

        handleShortcutKey("delete");

        // Dialog should NOT be opened when deletion is in progress
        expect(mockDialogState.openRemoveDialog).not.toHaveBeenCalled();
        // Shortcut mode should still be active (no action taken)
        expect(shortcutModeActive.value).toBe(true);
      });

      it("should-not-open-remove-dialog-while-workspace-is-creating", () => {
        const workspaceRef = {
          projectId: "project-12345678",
          workspaceName: "feature",
          path: "__pending__//project/feature",
        };
        mockProjectsStore.activeWorkspace.value = workspaceRef;
        mockLifecycleStore.getLifecycle.mockReturnValue("creating");

        enableShortcutMode();
        handleShortcutKey("delete");

        // Dialog should NOT be opened for an optimistic creating placeholder
        expect(mockDialogState.openRemoveDialog).not.toHaveBeenCalled();
        expect(shortcutModeActive.value).toBe(true);
      });

      it("should-open-remove-dialog-when-previous-deletion-failed", () => {
        const workspaceRef = {
          projectId: "project-12345678",
          workspaceName: "feature",
          path: "/workspace",
        };
        mockProjectsStore.activeWorkspace.value = workspaceRef;
        mockLifecycleStore.getLifecycle.mockReturnValue("delete-failed");

        enableShortcutMode();
        handleShortcutKey("delete");

        // Retry must stay possible after a failed deletion
        expect(mockDialogState.openRemoveDialog).toHaveBeenCalledWith(workspaceRef);
      });

      it("should-deactivate-shortcut-mode-before-opening-dialog", () => {
        mockProjectsStore.activeProject.value = {
          id: "test-project-12345678",
          path: "/project",
        };

        enableShortcutMode();
        expect(shortcutModeActive.value).toBe(true);

        handleShortcutKey("enter");

        expect(shortcutModeActive.value).toBe(false);
      });
    });

    describe("error handling", () => {
      // NOTE: Uses handleShortcutKey with normalized key "down" (not "ArrowDown")
      // since key normalization happens in main process before event is sent.
      it("handles workspace switch failure gracefully", async () => {
        const workspaces = [
          { path: "/ws1", name: "ws1", branch: null },
          { path: "/ws2", name: "ws2", branch: null },
        ];
        const workspaceRefs: MockWorkspaceRef[] = [
          { projectId: "test-project-12345678", workspaceName: "ws1", path: "/ws1" },
          { projectId: "test-project-12345678", workspaceName: "ws2", path: "/ws2" },
        ];
        mockProjectsStore.getAllWorkspaces.mockReturnValue(workspaces);
        mockProjectsStore.getWorkspaceRefByIndex.mockImplementation(
          (i: number) => workspaceRefs[i]
        );
        mockProjectsStore.findWorkspaceIndex.mockReturnValue(0);
        mockProjectsStore.activeWorkspacePath.value = "/ws1";
        mockApi.ui.switchWorkspace.mockRejectedValue(new Error("Switch failed"));

        enableShortcutMode();
        handleShortcutKey("down");

        // Verify the call was attempted with correct parameters
        await vi.waitFor(() => {
          expect(mockApi.ui.switchWorkspace).toHaveBeenCalledWith("/ws2", false);
        });
        // Logging is an implementation detail - we just verify the call was made
        // and no unhandled rejection occurs
      });
    });
  });
});
