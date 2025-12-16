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
import { createMockPathProvider, type PathProvider, type ProjectStore } from "../services";
import type { AgentStatusManager } from "../services/opencode/agent-status-manager";
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
    updateCodeServerPort: vi.fn(),
  } as unknown as IViewManager;
}

function createMockAgentStatusManager(): AgentStatusManager {
  return {
    initWorkspace: vi.fn().mockResolvedValue(undefined),
    removeWorkspace: vi.fn(),
    onStatusChanged: vi.fn().mockReturnValue(() => {}),
    dispose: vi.fn(),
  } as unknown as AgentStatusManager;
}

// =============================================================================
// Integration Tests: Workspace Removal Cleanup Flow
// =============================================================================

describe("AppState Integration: Workspace Removal Cleanup Flow", () => {
  let appState: AppState;
  let mockViewManager: IViewManager;
  let mockAgentStatusManager: AgentStatusManager;
  let mockPathProvider: PathProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProjectStore.loadAllProjects.mockResolvedValue([]);
    mockPathProvider = createMockPathProvider({
      dataRootDir: WORKSPACES_DIR,
    });
    mockViewManager = createMockViewManager();
    mockAgentStatusManager = createMockAgentStatusManager();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("removeWorkspace cleanup order", () => {
    it("executes cleanup in order: agentStatusManager.removeWorkspace → viewManager.destroyWorkspaceView", async () => {
      appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager,
        mockPathProvider,
        8080
      );
      appState.setAgentStatusManager(mockAgentStatusManager);

      // Open project to populate state
      await appState.openProject("/project");

      // Track execution order
      const executionOrder: string[] = [];

      vi.mocked(mockAgentStatusManager.removeWorkspace).mockImplementation(() => {
        executionOrder.push("agentStatusManager.removeWorkspace");
      });

      vi.mocked(mockViewManager.destroyWorkspaceView).mockImplementation(async () => {
        executionOrder.push("viewManager.destroyWorkspaceView");
      });

      // Remove workspace
      await appState.removeWorkspace("/project", "/project/.worktrees/feature-1");

      // Verify order: agent cleanup MUST happen before view destruction
      expect(executionOrder).toEqual([
        "agentStatusManager.removeWorkspace",
        "viewManager.destroyWorkspaceView",
      ]);
    });

    it("calls viewManager.destroyWorkspaceView with workspace path", async () => {
      appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager,
        mockPathProvider,
        8080
      );
      appState.setAgentStatusManager(mockAgentStatusManager);

      await appState.openProject("/project");

      await appState.removeWorkspace("/project", "/project/.worktrees/feature-1");

      expect(mockViewManager.destroyWorkspaceView).toHaveBeenCalledWith(
        "/project/.worktrees/feature-1"
      );
    });

    it("calls agentStatusManager.removeWorkspace with WorkspacePath", async () => {
      appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager,
        mockPathProvider,
        8080
      );
      appState.setAgentStatusManager(mockAgentStatusManager);

      await appState.openProject("/project");

      await appState.removeWorkspace("/project", "/project/.worktrees/feature-1");

      expect(mockAgentStatusManager.removeWorkspace).toHaveBeenCalledWith(
        "/project/.worktrees/feature-1" as WorkspacePath
      );
    });

    it("continues cleanup even if agentStatusManager is not set", async () => {
      appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager,
        mockPathProvider,
        8080
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

    it("calls agentStatusManager.removeWorkspace synchronously before view destruction", async () => {
      appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager,
        mockPathProvider,
        8080
      );
      appState.setAgentStatusManager(mockAgentStatusManager);

      await appState.openProject("/project");

      // Track that agent removal happens before view destruction
      let agentRemoveCalled = false;
      let viewDestroyStarted = false;

      vi.mocked(mockAgentStatusManager.removeWorkspace).mockImplementation(() => {
        agentRemoveCalled = true;
      });

      vi.mocked(mockViewManager.destroyWorkspaceView).mockImplementation(async () => {
        viewDestroyStarted = true;
        // Verify agent removal was called before view destruction started
        expect(agentRemoveCalled).toBe(true);
      });

      await appState.removeWorkspace("/project", "/project/.worktrees/feature-1");

      expect(viewDestroyStarted).toBe(true);
    });

    it("updates project state after cleanup completes", async () => {
      appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager,
        mockPathProvider,
        8080
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
        8080
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
        8080
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
      // Configure mock to return two workspaces
      mockWorkspaceProvider.discover.mockResolvedValue([
        { name: "feature-1", path: "/project/.worktrees/feature-1", branch: "feature-1" },
        { name: "feature-2", path: "/project/.worktrees/feature-2", branch: "feature-2" },
      ]);
    });

    it("only removes the specified workspace, leaves others intact", async () => {
      appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager,
        mockPathProvider,
        8080
      );
      appState.setAgentStatusManager(mockAgentStatusManager);

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
      expect(mockAgentStatusManager.removeWorkspace).toHaveBeenCalledTimes(1);
      expect(mockAgentStatusManager.removeWorkspace).toHaveBeenCalledWith(
        "/project/.worktrees/feature-1"
      );
      expect(mockViewManager.destroyWorkspaceView).toHaveBeenCalledTimes(1);
      expect(mockViewManager.destroyWorkspaceView).toHaveBeenCalledWith(
        "/project/.worktrees/feature-1"
      );
    });
  });
});
