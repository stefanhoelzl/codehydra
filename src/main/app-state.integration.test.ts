// @vitest-environment node

/**
 * Integration tests for AppState workspace removal flow.
 *
 * These tests verify that workspace cleanup executes all steps in the correct order:
 * 1. Agent status removal (kills OpenCode processes)
 * 2. View destruction (navigates to about:blank, clears partition)
 *
 * Note: These tests mock external systems but verify integration order between
 * agentStatusManager and viewManager during workspace removal.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AppState } from "./app-state";
import type { IViewManager } from "./managers/view-manager.interface";
import {
  createMockPathProvider,
  createFileSystemMock,
  createMockLoggingService,
  type PathProvider,
  type ProjectStore,
  type FileSystemLayer,
  type MockLoggingService,
  Path,
} from "../services";
import type { AgentStatusManager } from "../agents/opencode/status-manager";
import type { OpenCodeServerManager } from "../agents/opencode/server-manager";
import type { WorkspacePath } from "../shared/ipc";

// =============================================================================
// Mock Factories
// =============================================================================

const WORKSPACES_DIR = "/test/workspaces";

// Mock workspace provider and git factory
const { mockProjectStore, mockWorkspaceProvider, mockCreateGitWorktreeProvider } = vi.hoisted(
  () => {
    const mockProvider = {
      projectRoot: "/project",
      discover: vi.fn(() =>
        Promise.resolve([
          { name: "feature-1", path: "/project/.worktrees/feature-1", branch: "feature-1" },
        ])
      ),
      isMainWorkspace: vi.fn(() => false),
      createWorkspace: vi.fn((name: string) =>
        Promise.resolve({
          name,
          path: `/project/.worktrees/${name}`,
          branch: name,
        })
      ),
      removeWorkspace: vi.fn(() => Promise.resolve({ workspaceRemoved: true, baseDeleted: false })),
      listBases: vi.fn(() =>
        Promise.resolve([
          { name: "main", isRemote: false },
          { name: "origin/main", isRemote: true },
        ])
      ),
      updateBases: vi.fn(() => Promise.resolve({ fetchedRemotes: ["origin"], failedRemotes: [] })),
      isDirty: vi.fn(() => Promise.resolve(false)),
      cleanupOrphanedWorkspaces: vi.fn(() => Promise.resolve({ removedCount: 0, failedPaths: [] })),
      defaultBase: vi.fn(() => Promise.resolve("main")),
    };

    const mockStore = {
      saveProject: vi.fn(() => Promise.resolve()),
      removeProject: vi.fn(() => Promise.resolve()),
      loadAllProjects: vi.fn(() => Promise.resolve([] as string[])),
    };

    return {
      mockProjectStore: mockStore,
      mockWorkspaceProvider: mockProvider,
      mockCreateGitWorktreeProvider: vi.fn(() => Promise.resolve(mockProvider)),
    };
  }
);

vi.mock("../services", async () => {
  const actual = await vi.importActual("../services");
  return {
    ...actual,
    createGitWorktreeProvider: mockCreateGitWorktreeProvider,
  };
});

function createMockViewManager(): IViewManager {
  return {
    getUIView: vi.fn(),
    createWorkspaceView: vi.fn(),
    destroyWorkspaceView: vi.fn().mockResolvedValue(undefined),
    getWorkspaceView: vi.fn(),
    updateBounds: vi.fn(),
    setActiveWorkspace: vi.fn(),
    getActiveWorkspacePath: vi.fn().mockReturnValue(null),
    focusActiveWorkspace: vi.fn(),
    focusUI: vi.fn(),
    setMode: vi.fn(),
    getMode: vi.fn().mockReturnValue("workspace"),
    onModeChange: vi.fn().mockReturnValue(() => {}),
    onWorkspaceChange: vi.fn().mockReturnValue(() => {}),
    updateCodeServerPort: vi.fn(),
    preloadWorkspaceUrl: vi.fn(),
  } as unknown as IViewManager;
}

function createMockAgentStatusManager(): AgentStatusManager {
  return {
    initWorkspace: vi.fn().mockResolvedValue(undefined),
    removeWorkspace: vi.fn(),
    clearTuiTracking: vi.fn(),
    onStatusChanged: vi.fn().mockReturnValue(() => {}),
    dispose: vi.fn(),
  } as unknown as AgentStatusManager;
}

function createMockServerManager(): OpenCodeServerManager {
  // Track callbacks to simulate real behavior
  type StoppedCallback = (path: string) => void;
  const stoppedCallbacks = new Set<StoppedCallback>();

  return {
    startServer: vi.fn().mockResolvedValue(14001),
    stopServer: vi.fn().mockImplementation(async (path: string) => {
      // Simulate callback firing when server stops
      for (const cb of stoppedCallbacks) {
        cb(path);
      }
      return { success: true };
    }),
    stopAllForProject: vi.fn().mockResolvedValue(undefined),
    getPort: vi.fn().mockReturnValue(undefined),
    onServerStarted: vi.fn().mockReturnValue(() => {}),
    onServerStopped: vi.fn().mockImplementation((cb: StoppedCallback) => {
      stoppedCallbacks.add(cb);
      return () => stoppedCallbacks.delete(cb);
    }),
    cleanupStaleEntries: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
  } as unknown as OpenCodeServerManager;
}

// =============================================================================
// Integration Tests: Workspace Removal Cleanup Flow
// =============================================================================

describe("AppState Integration: Workspace Removal Cleanup Flow", () => {
  let appState: AppState;
  let mockViewManager: IViewManager;
  let mockAgentStatusManager: AgentStatusManager;
  let mockServerManager: OpenCodeServerManager;
  let mockPathProvider: PathProvider;
  let mockFileSystemLayer: FileSystemLayer;
  let mockLoggingService: MockLoggingService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProjectStore.loadAllProjects.mockResolvedValue([]);
    mockPathProvider = createMockPathProvider({
      dataRootDir: WORKSPACES_DIR,
    });
    mockViewManager = createMockViewManager();
    mockAgentStatusManager = createMockAgentStatusManager();
    mockServerManager = createMockServerManager();
    mockFileSystemLayer = createFileSystemMock();
    mockLoggingService = createMockLoggingService();

    // Set up workspace provider mock implementations with Path objects
    // (Type assertions needed because hoisted mock types are strings but runtime uses Path)
    mockWorkspaceProvider.discover.mockResolvedValue([
      {
        name: "feature-1",
        path: new Path("/project/.worktrees/feature-1") as unknown as string,
        branch: "feature-1",
      },
    ]);
    mockWorkspaceProvider.createWorkspace.mockImplementation((name: string) =>
      Promise.resolve({
        name,
        path: new Path(`/project/.worktrees/${name}`) as unknown as string,
        branch: name,
      })
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("removeWorkspace cleanup order", () => {
    it("executes cleanup in order: serverManager.stopServer → viewManager.destroyWorkspaceView", async () => {
      appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager,
        mockPathProvider,
        8080,
        mockFileSystemLayer,
        mockLoggingService
      );
      appState.setAgentStatusManager(mockAgentStatusManager);
      appState.setServerManager(mockServerManager);

      // Open project to populate state
      await appState.openProject("/project");

      // Track execution order
      const executionOrder: string[] = [];

      // Note: With the new design, serverManager.stopServer triggers onServerStopped callback
      // which calls agentStatusManager.removeWorkspace. The order is now:
      // 1. serverManager.stopServer (which fires callback that calls agentStatusManager.removeWorkspace)
      // 2. viewManager.destroyWorkspaceView

      vi.mocked(mockServerManager.stopServer).mockImplementation(async (path: string) => {
        executionOrder.push("serverManager.stopServer");
        // Simulate callback firing (which would call agentStatusManager.removeWorkspace)
        vi.mocked(mockAgentStatusManager.removeWorkspace)(path as WorkspacePath);
        executionOrder.push("agentStatusManager.removeWorkspace");
        return { success: true };
      });

      vi.mocked(mockViewManager.destroyWorkspaceView).mockImplementation(async () => {
        executionOrder.push("viewManager.destroyWorkspaceView");
      });

      // Remove workspace
      await appState.removeWorkspace("/project", "/project/.worktrees/feature-1");

      // Verify order: server stop (with agent cleanup) happens before view destruction
      expect(executionOrder).toEqual([
        "serverManager.stopServer",
        "agentStatusManager.removeWorkspace",
        "viewManager.destroyWorkspaceView",
      ]);
    });

    it("calls viewManager.destroyWorkspaceView with workspace path", async () => {
      appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager,
        mockPathProvider,
        8080,
        mockFileSystemLayer,
        mockLoggingService
      );
      appState.setAgentStatusManager(mockAgentStatusManager);

      await appState.openProject("/project");

      await appState.removeWorkspace("/project", "/project/.worktrees/feature-1");

      expect(mockViewManager.destroyWorkspaceView).toHaveBeenCalledWith(
        "/project/.worktrees/feature-1"
      );
    });

    it("calls serverManager.stopServer with workspace path", async () => {
      appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager,
        mockPathProvider,
        8080,
        mockFileSystemLayer,
        mockLoggingService
      );
      appState.setAgentStatusManager(mockAgentStatusManager);
      appState.setServerManager(mockServerManager);

      await appState.openProject("/project");

      await appState.removeWorkspace("/project", "/project/.worktrees/feature-1");

      expect(mockServerManager.stopServer).toHaveBeenCalledWith("/project/.worktrees/feature-1");
    });

    it("continues cleanup even if agentStatusManager is not set", async () => {
      appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager,
        mockPathProvider,
        8080,
        mockFileSystemLayer,
        mockLoggingService
      );
      // Don't set agentStatusManager

      await appState.openProject("/project");

      // Should not throw
      await expect(
        appState.removeWorkspace("/project", "/project/.worktrees/feature-1")
      ).resolves.not.toThrow();

      // View should still be destroyed
      expect(mockViewManager.destroyWorkspaceView).toHaveBeenCalledWith(
        "/project/.worktrees/feature-1"
      );
    });

    it("calls serverManager.stopServer before view destruction", async () => {
      appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager,
        mockPathProvider,
        8080,
        mockFileSystemLayer,
        mockLoggingService
      );
      appState.setAgentStatusManager(mockAgentStatusManager);
      appState.setServerManager(mockServerManager);

      await appState.openProject("/project");

      // Track that server stop happens before view destruction
      let serverStopped = false;
      let viewDestroyStarted = false;

      vi.mocked(mockServerManager.stopServer).mockImplementation(async () => {
        serverStopped = true;
        return { success: true };
      });

      vi.mocked(mockViewManager.destroyWorkspaceView).mockImplementation(async () => {
        viewDestroyStarted = true;
        // Verify server was stopped before view destruction started
        expect(serverStopped).toBe(true);
      });

      await appState.removeWorkspace("/project", "/project/.worktrees/feature-1");

      expect(viewDestroyStarted).toBe(true);
    });

    it("updates project state after cleanup completes", async () => {
      appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager,
        mockPathProvider,
        8080,
        mockFileSystemLayer,
        mockLoggingService
      );
      appState.setAgentStatusManager(mockAgentStatusManager);

      await appState.openProject("/project");

      // Verify workspace exists before removal
      const projectBefore = appState.getProject("/project");
      expect(projectBefore?.workspaces).toHaveLength(1);
      expect(projectBefore?.workspaces[0]?.path).toBe("/project/.worktrees/feature-1");

      await appState.removeWorkspace("/project", "/project/.worktrees/feature-1");

      // Verify workspace removed from project state
      const projectAfter = appState.getProject("/project");
      expect(projectAfter?.workspaces).toHaveLength(0);
    });

    it("is idempotent - does not error on double removal", async () => {
      appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager,
        mockPathProvider,
        8080,
        mockFileSystemLayer,
        mockLoggingService
      );
      appState.setAgentStatusManager(mockAgentStatusManager);

      await appState.openProject("/project");

      // First removal
      await appState.removeWorkspace("/project", "/project/.worktrees/feature-1");

      // Reset mocks to track second call
      vi.clearAllMocks();

      // Second removal should not throw (workspace already gone from state)
      await expect(
        appState.removeWorkspace("/project", "/project/.worktrees/feature-1")
      ).resolves.not.toThrow();
    });

    it("handles non-existent project gracefully", async () => {
      appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager,
        mockPathProvider,
        8080,
        mockFileSystemLayer,
        mockLoggingService
      );
      appState.setAgentStatusManager(mockAgentStatusManager);

      // Don't open any project, try to remove workspace from non-existent project
      await expect(
        appState.removeWorkspace("/nonexistent", "/nonexistent/.worktrees/feature-1")
      ).resolves.not.toThrow();

      // Neither cleanup step should be called
      expect(mockAgentStatusManager.removeWorkspace).not.toHaveBeenCalled();
      expect(mockViewManager.destroyWorkspaceView).not.toHaveBeenCalled();
    });
  });

  describe("removeWorkspace with multiple workspaces", () => {
    beforeEach(() => {
      // Configure mock to return two workspaces (with Path objects for runtime compatibility)
      mockWorkspaceProvider.discover.mockResolvedValue([
        {
          name: "feature-1",
          path: new Path("/project/.worktrees/feature-1") as unknown as string,
          branch: "feature-1",
        },
        {
          name: "feature-2",
          path: new Path("/project/.worktrees/feature-2") as unknown as string,
          branch: "feature-2",
        },
      ]);
    });

    it("only removes the specified workspace, leaves others intact", async () => {
      appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager,
        mockPathProvider,
        8080,
        mockFileSystemLayer,
        mockLoggingService
      );
      appState.setAgentStatusManager(mockAgentStatusManager);
      appState.setServerManager(mockServerManager);

      await appState.openProject("/project");

      // Verify both workspaces exist
      const projectBefore = appState.getProject("/project");
      expect(projectBefore?.workspaces).toHaveLength(2);

      // Remove only feature-1
      await appState.removeWorkspace("/project", "/project/.worktrees/feature-1");

      // Verify only feature-1 was removed, feature-2 remains
      const projectAfter = appState.getProject("/project");
      expect(projectAfter?.workspaces).toHaveLength(1);
      expect(projectAfter?.workspaces[0]?.name).toBe("feature-2");

      // Verify cleanup was only called for feature-1
      expect(mockServerManager.stopServer).toHaveBeenCalledTimes(1);
      expect(mockServerManager.stopServer).toHaveBeenCalledWith("/project/.worktrees/feature-1");
      expect(mockViewManager.destroyWorkspaceView).toHaveBeenCalledTimes(1);
      expect(mockViewManager.destroyWorkspaceView).toHaveBeenCalledWith(
        "/project/.worktrees/feature-1"
      );
    });
  });

  describe("workspace:switched event via onWorkspaceChange callback", () => {
    it("opening empty project does not change active workspace", async () => {
      // Configure mock to return empty workspace list
      mockWorkspaceProvider.discover.mockResolvedValue([]);

      appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager,
        mockPathProvider,
        8080,
        mockFileSystemLayer,
        mockLoggingService
      );

      await appState.openProject("/project");

      // Verify setActiveWorkspace was NOT called for empty project
      // This preserves the currently active workspace from another project
      expect(mockViewManager.setActiveWorkspace).not.toHaveBeenCalled();
    });

    it("opening project with workspaces sets first workspace active", async () => {
      // Configure mock to return workspaces
      mockWorkspaceProvider.discover.mockResolvedValue([
        {
          name: "feature-1",
          path: "/project/.worktrees/feature-1",
          branch: "feature-1",
        },
        {
          name: "feature-2",
          path: "/project/.worktrees/feature-2",
          branch: "feature-2",
        },
      ]);

      appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager,
        mockPathProvider,
        8080,
        mockFileSystemLayer,
        mockLoggingService
      );

      await appState.openProject("/project");

      // Verify setActiveWorkspace was called with first workspace path
      expect(mockViewManager.setActiveWorkspace).toHaveBeenCalledWith(
        "/project/.worktrees/feature-1"
      );
    });

    it("opening empty project AFTER non-empty project preserves active workspace", async () => {
      const workspaceChanges: Array<string | null> = [];

      // Mock setActiveWorkspace to track calls
      vi.mocked(mockViewManager.setActiveWorkspace).mockImplementation((path: string | null) => {
        workspaceChanges.push(path);
      });

      appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager,
        mockPathProvider,
        8080,
        mockFileSystemLayer,
        mockLoggingService
      );

      // First: open project A with workspaces
      mockWorkspaceProvider.discover.mockResolvedValue([
        {
          name: "feature-1",
          path: "/projectA/.worktrees/feature-1",
          branch: "feature-1",
        },
      ]);
      mockWorkspaceProvider.projectRoot = "/projectA";
      await appState.openProject("/projectA");

      // Second: open project B with no workspaces (empty)
      mockWorkspaceProvider.discover.mockResolvedValue([]);
      mockWorkspaceProvider.projectRoot = "/projectB";
      await appState.openProject("/projectB");

      // Verify only first project changed active workspace
      // Empty project should NOT call setActiveWorkspace, preserving the current active workspace
      expect(workspaceChanges).toEqual(["/projectA/.worktrees/feature-1"]);
    });
  });
});
