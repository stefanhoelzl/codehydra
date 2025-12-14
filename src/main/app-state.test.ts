// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { IViewManager } from "./managers/view-manager.interface";
import { createMockPathProvider, type PathProvider } from "../services";

// WORKSPACES_DIR used in mock pathProvider for workspace creation
const WORKSPACES_DIR = "/test/workspaces";

// Mock PathProvider - created fresh in beforeEach
let mockPathProvider: PathProvider;

// Mock services
const { mockProjectStore, mockWorkspaceProvider, mockViewManager, mockCreateGitWorktreeProvider } =
  vi.hoisted(() => {
    const mockProvider: {
      discover: ReturnType<typeof vi.fn>;
      createWorkspace: ReturnType<typeof vi.fn>;
      removeWorkspace: ReturnType<typeof vi.fn>;
      listBases: ReturnType<typeof vi.fn>;
      updateBases: ReturnType<typeof vi.fn>;
      isDirty: ReturnType<typeof vi.fn>;
      projectRoot: string;
      isMainWorkspace: ReturnType<typeof vi.fn>;
      cleanupOrphanedWorkspaces: ReturnType<typeof vi.fn>;
      defaultBase: ReturnType<typeof vi.fn>;
    } = {
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

    const mockView: {
      getUIView: ReturnType<typeof vi.fn>;
      createWorkspaceView: ReturnType<typeof vi.fn>;
      destroyWorkspaceView: ReturnType<typeof vi.fn>;
      getWorkspaceView: ReturnType<typeof vi.fn>;
      updateBounds: ReturnType<typeof vi.fn>;
      setActiveWorkspace: ReturnType<typeof vi.fn>;
      focusActiveWorkspace: ReturnType<typeof vi.fn>;
      focusUI: ReturnType<typeof vi.fn>;
    } = {
      getUIView: vi.fn(),
      createWorkspaceView: vi.fn(),
      destroyWorkspaceView: vi.fn(),
      getWorkspaceView: vi.fn(),
      updateBounds: vi.fn(),
      setActiveWorkspace: vi.fn(),
      focusActiveWorkspace: vi.fn(),
      focusUI: vi.fn(),
    };

    return {
      mockProjectStore: mockStore,
      mockWorkspaceProvider: mockProvider,
      mockViewManager: mockView,
      mockCreateGitWorktreeProvider: vi.fn(() => Promise.resolve(mockProvider)),
    };
  });

vi.mock("../services", async () => {
  const actual = await vi.importActual("../services");
  return {
    ...actual,
    createGitWorktreeProvider: mockCreateGitWorktreeProvider,
  };
});

import { AppState } from "./app-state";
import type { ProjectStore } from "../services";

describe("AppState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProjectStore.loadAllProjects.mockResolvedValue([]);
    // Create mock PathProvider with getProjectWorkspacesDir returning consistent path
    mockPathProvider = createMockPathProvider({
      dataRootDir: WORKSPACES_DIR,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("constructor", () => {
    it("creates an AppState instance", () => {
      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080
      );

      expect(appState).toBeInstanceOf(AppState);
    });
  });

  describe("openProject", () => {
    it("validates path is a git repository", async () => {
      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080
      );

      await appState.openProject("/project");

      // createGitWorktreeProvider is called with projectPath, workspacesDir, and fileSystemLayer
      expect(mockCreateGitWorktreeProvider).toHaveBeenCalledWith(
        "/project",
        mockPathProvider.getProjectWorkspacesDir("/project"),
        expect.any(Object) // FileSystemLayer
      );
    });

    it("discovers workspaces from git worktrees", async () => {
      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080
      );

      await appState.openProject("/project");

      expect(mockWorkspaceProvider.discover).toHaveBeenCalled();
    });

    it("creates WebContentsView for each workspace", async () => {
      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080
      );

      await appState.openProject("/project");

      expect(mockViewManager.createWorkspaceView).toHaveBeenCalledWith(
        "/project/.worktrees/feature-1",
        expect.stringContaining("http://localhost:8080")
      );
    });

    it("sets first workspace as active", async () => {
      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080
      );

      await appState.openProject("/project");

      expect(mockViewManager.setActiveWorkspace).toHaveBeenCalledWith(
        "/project/.worktrees/feature-1"
      );
    });

    it("persists project via ProjectStore", async () => {
      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080
      );

      await appState.openProject("/project");

      expect(mockProjectStore.saveProject).toHaveBeenCalledWith("/project");
    });

    it("returns Project object", async () => {
      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080
      );

      const project = await appState.openProject("/project");

      expect(project).toEqual({
        path: "/project",
        name: "project",
        workspaces: [
          { name: "feature-1", path: "/project/.worktrees/feature-1", branch: "feature-1" },
        ],
        defaultBaseBranch: "main",
      });
    });

    it("handles project with zero workspaces", async () => {
      mockWorkspaceProvider.discover.mockResolvedValueOnce([]);

      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080
      );

      const project = await appState.openProject("/project");

      expect(project.workspaces).toEqual([]);
      expect(mockViewManager.setActiveWorkspace).toHaveBeenCalledWith(null);
    });
  });

  describe("closeProject", () => {
    it("destroys all workspace views", async () => {
      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080
      );

      await appState.openProject("/project");
      await appState.closeProject("/project");

      expect(mockViewManager.destroyWorkspaceView).toHaveBeenCalledWith(
        "/project/.worktrees/feature-1"
      );
    });

    it("removes project from internal state", async () => {
      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080
      );

      await appState.openProject("/project");
      await appState.closeProject("/project");

      expect(appState.getProject("/project")).toBeUndefined();
    });

    it("removes project from persistent storage", async () => {
      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080
      );

      await appState.openProject("/project");
      await appState.closeProject("/project");

      expect(mockProjectStore.removeProject).toHaveBeenCalledWith("/project");
    });

    it("does nothing for non-existent project", async () => {
      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080
      );

      await appState.closeProject("/nonexistent");

      expect(mockViewManager.destroyWorkspaceView).not.toHaveBeenCalled();
      expect(mockProjectStore.removeProject).not.toHaveBeenCalled();
    });
  });

  describe("getProject", () => {
    it("returns project for open path", async () => {
      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080
      );

      await appState.openProject("/project");
      const project = appState.getProject("/project");

      expect(project?.path).toBe("/project");
    });

    it("returns undefined for non-existent path", () => {
      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080
      );

      expect(appState.getProject("/nonexistent")).toBeUndefined();
    });
  });

  describe("getAllProjects", () => {
    it("returns all open projects", async () => {
      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080
      );

      await appState.openProject("/project");
      const projects = await appState.getAllProjects();

      expect(projects).toHaveLength(1);
      expect(projects[0]?.path).toBe("/project");
    });
  });

  describe("getWorkspaceProvider", () => {
    it("returns cached provider for open project", async () => {
      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080
      );

      await appState.openProject("/project");
      const provider = appState.getWorkspaceProvider("/project");

      expect(provider).toBe(mockWorkspaceProvider);
    });

    it("returns undefined for non-existent project", () => {
      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080
      );

      expect(appState.getWorkspaceProvider("/nonexistent")).toBeUndefined();
    });
  });

  describe("getWorkspaceUrl", () => {
    it("generates code-server URL with folder parameter", () => {
      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080
      );

      const url = appState.getWorkspaceUrl("/path/to/workspace");

      expect(url).toContain("http://localhost:8080");
      expect(url).toContain("folder=");
    });
  });

  describe("loadPersistedProjects", () => {
    it("loads projects from ProjectStore", async () => {
      const projectPaths = ["/project"];
      mockProjectStore.loadAllProjects.mockResolvedValue(projectPaths);

      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080
      );

      await appState.loadPersistedProjects();

      expect(mockProjectStore.loadAllProjects).toHaveBeenCalled();
      // createGitWorktreeProvider is called with projectPath, workspacesDir, and fileSystemLayer
      expect(mockCreateGitWorktreeProvider).toHaveBeenCalledWith(
        "/project",
        mockPathProvider.getProjectWorkspacesDir("/project"),
        expect.any(Object) // FileSystemLayer
      );
    });

    it("skips invalid projects", async () => {
      const projectPaths = ["/invalid"];
      mockProjectStore.loadAllProjects.mockResolvedValue(projectPaths);
      mockCreateGitWorktreeProvider.mockRejectedValueOnce(new Error("Not a git repo"));

      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080
      );

      // Should not throw
      await appState.loadPersistedProjects();

      expect(await appState.getAllProjects()).toHaveLength(0);
    });
  });

  describe("findProjectForWorkspace", () => {
    it("finds project containing workspace", async () => {
      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080
      );

      await appState.openProject("/project");
      const project = appState.findProjectForWorkspace("/project/.worktrees/feature-1");

      expect(project?.path).toBe("/project");
    });

    it("returns undefined for unknown workspace", async () => {
      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080
      );

      await appState.openProject("/project");
      const project = appState.findProjectForWorkspace("/other/.worktrees/unknown");

      expect(project).toBeUndefined();
    });
  });

  describe("openProject agent status integration", () => {
    it("calls initWorkspace on agentStatusManager for each discovered workspace", async () => {
      const mockAgentStatusManager = {
        initWorkspace: vi.fn(),
        removeWorkspace: vi.fn(),
      };

      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080
      );
      appState.setAgentStatusManager(
        mockAgentStatusManager as unknown as Parameters<typeof appState.setAgentStatusManager>[0]
      );

      await appState.openProject("/project");

      expect(mockAgentStatusManager.initWorkspace).toHaveBeenCalledWith(
        "/project/.worktrees/feature-1"
      );
    });

    it("calls initWorkspace for each workspace when multiple exist", async () => {
      mockWorkspaceProvider.discover.mockResolvedValueOnce([
        { name: "feature-1", path: "/project/.worktrees/feature-1", branch: "feature-1" },
        { name: "feature-2", path: "/project/.worktrees/feature-2", branch: "feature-2" },
      ]);

      const mockAgentStatusManager = {
        initWorkspace: vi.fn(),
        removeWorkspace: vi.fn(),
      };

      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080
      );
      appState.setAgentStatusManager(
        mockAgentStatusManager as unknown as Parameters<typeof appState.setAgentStatusManager>[0]
      );

      await appState.openProject("/project");

      expect(mockAgentStatusManager.initWorkspace).toHaveBeenCalledTimes(2);
      expect(mockAgentStatusManager.initWorkspace).toHaveBeenCalledWith(
        "/project/.worktrees/feature-1"
      );
      expect(mockAgentStatusManager.initWorkspace).toHaveBeenCalledWith(
        "/project/.worktrees/feature-2"
      );
    });

    it("does not fail when agentStatusManager is not set", async () => {
      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080
      );

      // Should not throw even without agentStatusManager
      await expect(appState.openProject("/project")).resolves.toBeDefined();
    });
  });

  describe("workspace cleanup", () => {
    it("continues if cleanupOrphanedWorkspaces fails", async () => {
      // Make cleanup throw an error
      mockWorkspaceProvider.cleanupOrphanedWorkspaces.mockRejectedValueOnce(
        new Error("Cleanup failed")
      );
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080
      );

      // openProject should still succeed despite cleanup failure
      const project = await appState.openProject("/project");

      expect(project.path).toBe("/project");
      // Give the async cleanup a chance to complete
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(errorSpy).toHaveBeenCalledWith("Workspace cleanup failed:", expect.any(Error));
      errorSpy.mockRestore();
    });

    it("calls cleanupOrphanedWorkspaces on openProject", async () => {
      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080
      );

      await appState.openProject("/project");

      // Give the async cleanup a chance to be called
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(mockWorkspaceProvider.cleanupOrphanedWorkspaces).toHaveBeenCalled();
    });
  });

  describe("setLastBaseBranch", () => {
    it("stores branch in runtime map", async () => {
      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080
      );

      await appState.openProject("/project");
      appState.setLastBaseBranch("/project", "feature-branch");

      // Verify it's stored by getting the default which should return the set value
      const defaultBranch = await appState.getDefaultBaseBranch("/project");
      expect(defaultBranch).toBe("feature-branch");
    });

    it("with same branch twice is idempotent", async () => {
      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080
      );

      await appState.openProject("/project");
      appState.setLastBaseBranch("/project", "feature-branch");
      appState.setLastBaseBranch("/project", "feature-branch");

      const defaultBranch = await appState.getDefaultBaseBranch("/project");
      expect(defaultBranch).toBe("feature-branch");
    });
  });

  describe("getDefaultBaseBranch", () => {
    it("returns runtime value when set", async () => {
      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080
      );

      await appState.openProject("/project");
      appState.setLastBaseBranch("/project", "develop");

      const result = await appState.getDefaultBaseBranch("/project");
      expect(result).toBe("develop");
    });

    it("falls back to provider.defaultBase() when not set", async () => {
      mockWorkspaceProvider.defaultBase.mockResolvedValueOnce("main");

      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080
      );

      await appState.openProject("/project");

      const result = await appState.getDefaultBaseBranch("/project");
      expect(result).toBe("main");
      expect(mockWorkspaceProvider.defaultBase).toHaveBeenCalled();
    });

    it("returns undefined when provider not found", async () => {
      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080
      );

      // Don't open any project
      const result = await appState.getDefaultBaseBranch("/nonexistent");
      expect(result).toBeUndefined();
    });

    it("returns undefined when provider.defaultBase() throws", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080
      );

      await appState.openProject("/project");

      // Now make defaultBase throw for the next call
      mockWorkspaceProvider.defaultBase.mockRejectedValueOnce(new Error("Git error"));

      const result = await appState.getDefaultBaseBranch("/project");
      expect(result).toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe("openProject with defaultBaseBranch", () => {
    it("includes defaultBaseBranch in returned Project", async () => {
      mockWorkspaceProvider.defaultBase.mockResolvedValueOnce("main");

      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080
      );

      const project = await appState.openProject("/project");

      expect(project.defaultBaseBranch).toBe("main");
    });

    it("includes runtime branch when previously set", async () => {
      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080
      );

      // Set a branch before opening the project
      appState.setLastBaseBranch("/project", "develop");

      const project = await appState.openProject("/project");

      expect(project.defaultBaseBranch).toBe("develop");
    });
  });

  describe("getAllProjects with defaultBaseBranch", () => {
    it("includes current defaultBaseBranch for each project", async () => {
      mockWorkspaceProvider.defaultBase.mockResolvedValue("main");

      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080
      );

      await appState.openProject("/project");
      appState.setLastBaseBranch("/project", "feature-x");

      const projects = await appState.getAllProjects();

      expect(projects[0]?.defaultBaseBranch).toBe("feature-x");
    });
  });

  describe("getDefaultBaseBranch integration", () => {
    it("integration - cached value takes precedence over provider fallback", async () => {
      // Set up provider to return "main" as the default
      mockWorkspaceProvider.defaultBase.mockResolvedValue("main");

      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080
      );

      await appState.openProject("/project");

      // Without setLastBaseBranch, should fall back to provider
      const initialDefault = await appState.getDefaultBaseBranch("/project");
      expect(initialDefault).toBe("main");
      expect(mockWorkspaceProvider.defaultBase).toHaveBeenCalled();

      // Clear mock to verify next call behavior
      mockWorkspaceProvider.defaultBase.mockClear();

      // After setLastBaseBranch, should return cached value
      appState.setLastBaseBranch("/project", "develop");
      const cachedDefault = await appState.getDefaultBaseBranch("/project");
      expect(cachedDefault).toBe("develop");

      // Provider should NOT be called when cached value exists
      expect(mockWorkspaceProvider.defaultBase).not.toHaveBeenCalled();
    });
  });
});
