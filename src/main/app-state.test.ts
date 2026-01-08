// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { delay } from "@shared/test-fixtures";
import type { IViewManager } from "./managers/view-manager.interface";
import {
  createMockPathProvider,
  createFileSystemMock,
  createMockLoggingService,
  type PathProvider,
  type FileSystemLayer,
  type MockLoggingService,
  Path,
} from "../services";

// WORKSPACES_DIR used in mock pathProvider for workspace creation
const WORKSPACES_DIR = "/test/workspaces";

// Mock PathProvider, FileSystemLayer, and LoggingService - created fresh in beforeEach
let mockPathProvider: PathProvider;
let mockFileSystemLayer: FileSystemLayer;
let mockLoggingService: MockLoggingService;

// Mock wrapper path for Claude wrapper
const MOCK_WRAPPER_PATH = "/mock/bin/claude";

// Mock services
const {
  mockProjectStore,
  mockWorkspaceProvider,
  mockViewManager,
  mockCreateGitWorktreeProvider,
  mockWorkspaceFileService,
} = vi.hoisted(() => {
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
    discover: vi.fn(),
    isMainWorkspace: vi.fn(() => false),
    createWorkspace: vi.fn(),
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
    preloadWorkspaceUrl: ReturnType<typeof vi.fn>;
  } = {
    getUIView: vi.fn(),
    createWorkspaceView: vi.fn(),
    destroyWorkspaceView: vi.fn(),
    getWorkspaceView: vi.fn(),
    updateBounds: vi.fn(),
    setActiveWorkspace: vi.fn(),
    focusActiveWorkspace: vi.fn(),
    focusUI: vi.fn(),
    preloadWorkspaceUrl: vi.fn(),
  };

  // Mock WorkspaceFileService
  const mockWsFileService = {
    ensureWorkspaceFile: vi.fn(),
    createWorkspaceFile: vi.fn(),
    getWorkspaceFilePath: vi.fn(),
  };

  return {
    mockProjectStore: mockStore,
    mockWorkspaceProvider: mockProvider,
    mockViewManager: mockView,
    mockCreateGitWorktreeProvider: vi.fn(() => Promise.resolve(mockProvider)),
    mockWorkspaceFileService: mockWsFileService,
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
    // Create mock FileSystemLayer and LoggingService
    mockFileSystemLayer = createFileSystemMock();
    mockLoggingService = createMockLoggingService();

    // Set up workspace provider mock implementations with Path objects
    mockWorkspaceProvider.discover.mockResolvedValue([
      {
        name: "feature-1",
        path: new Path("/project/.worktrees/feature-1"),
        branch: "feature-1",
      },
    ]);
    mockWorkspaceProvider.createWorkspace.mockImplementation((name: string) =>
      Promise.resolve({
        name,
        path: new Path(`/project/.worktrees/${name}`),
        branch: name,
      })
    );
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
        8080,
        mockFileSystemLayer,
        mockLoggingService,
        "claude-code",
        mockWorkspaceFileService,
        MOCK_WRAPPER_PATH
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
        8080,
        mockFileSystemLayer,
        mockLoggingService,
        "claude-code",
        mockWorkspaceFileService,
        MOCK_WRAPPER_PATH
      );

      await appState.openProject("/project");

      // createGitWorktreeProvider is called with projectPath (Path), workspacesDir (Path), fileSystemLayer, loggers, and options
      expect(mockCreateGitWorktreeProvider).toHaveBeenCalledWith(
        expect.any(Path), // projectPath as Path
        expect.any(Path), // workspacesDir as Path
        expect.any(Object), // FileSystemLayer
        expect.any(Object), // Git Logger
        expect.any(Object), // Worktree Logger
        expect.objectContaining({ keepFilesService: expect.any(Object) }) // Options with KeepFilesService
      );
    });

    it("discovers workspaces from git worktrees", async () => {
      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080,
        mockFileSystemLayer,
        mockLoggingService,
        "claude-code",
        mockWorkspaceFileService,
        MOCK_WRAPPER_PATH
      );

      await appState.openProject("/project");

      expect(mockWorkspaceProvider.discover).toHaveBeenCalled();
    });

    it("creates WebContentsView for each workspace", async () => {
      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080,
        mockFileSystemLayer,
        mockLoggingService,
        "claude-code",
        mockWorkspaceFileService,
        MOCK_WRAPPER_PATH
      );

      await appState.openProject("/project");

      expect(mockViewManager.createWorkspaceView).toHaveBeenCalledWith(
        "/project/.worktrees/feature-1",
        expect.stringContaining("http://127.0.0.1:8080"),
        "/project",
        true
      );
    });

    it("sets first workspace as active", async () => {
      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080,
        mockFileSystemLayer,
        mockLoggingService,
        "claude-code",
        mockWorkspaceFileService,
        MOCK_WRAPPER_PATH
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
        8080,
        mockFileSystemLayer,
        mockLoggingService,
        "claude-code",
        mockWorkspaceFileService,
        MOCK_WRAPPER_PATH
      );

      await appState.openProject("/project");

      expect(mockProjectStore.saveProject).toHaveBeenCalledWith("/project");
    });

    it("returns Project object", async () => {
      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080,
        mockFileSystemLayer,
        mockLoggingService,
        "claude-code",
        mockWorkspaceFileService,
        MOCK_WRAPPER_PATH
      );

      const project = await appState.openProject("/project");

      expect(project).toMatchObject({
        path: "/project",
        name: "project",
        workspaces: [
          expect.objectContaining({
            name: "feature-1",
            path: "/project/.worktrees/feature-1",
            branch: "feature-1",
          }),
        ],
        defaultBaseBranch: "main",
      });
    });

    it("handles project with zero workspaces without changing active workspace", async () => {
      mockWorkspaceProvider.discover.mockResolvedValueOnce([]);

      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080,
        mockFileSystemLayer,
        mockLoggingService,
        "claude-code",
        mockWorkspaceFileService,
        MOCK_WRAPPER_PATH
      );

      const project = await appState.openProject("/project");

      expect(project.workspaces).toEqual([]);
      // Empty project should NOT call setActiveWorkspace
      // This preserves the currently active workspace from another project
      expect(mockViewManager.setActiveWorkspace).not.toHaveBeenCalled();
    });

    it("preloads remaining workspace URLs after activating first", async () => {
      // Set up multiple workspaces
      mockWorkspaceProvider.discover.mockResolvedValueOnce([
        { name: "workspace-1", path: new Path("/project/.worktrees/workspace-1"), branch: "ws-1" },
        { name: "workspace-2", path: new Path("/project/.worktrees/workspace-2"), branch: "ws-2" },
        { name: "workspace-3", path: new Path("/project/.worktrees/workspace-3"), branch: "ws-3" },
      ]);

      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080,
        mockFileSystemLayer,
        mockLoggingService,
        "claude-code",
        mockWorkspaceFileService,
        MOCK_WRAPPER_PATH
      );

      await appState.openProject("/project");

      // First workspace should be set as active
      expect(mockViewManager.setActiveWorkspace).toHaveBeenCalledWith(
        "/project/.worktrees/workspace-1"
      );

      // Remaining workspaces (2 and 3) should be preloaded
      expect(mockViewManager.preloadWorkspaceUrl).toHaveBeenCalledTimes(2);
      expect(mockViewManager.preloadWorkspaceUrl).toHaveBeenCalledWith(
        "/project/.worktrees/workspace-2"
      );
      expect(mockViewManager.preloadWorkspaceUrl).toHaveBeenCalledWith(
        "/project/.worktrees/workspace-3"
      );
    });

    it("does not preload when only one workspace exists", async () => {
      // Set up single workspace (default mock setup)
      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080,
        mockFileSystemLayer,
        mockLoggingService,
        "claude-code",
        mockWorkspaceFileService,
        MOCK_WRAPPER_PATH
      );

      await appState.openProject("/project");

      // First workspace set as active
      expect(mockViewManager.setActiveWorkspace).toHaveBeenCalled();

      // No preload calls (only one workspace, nothing to preload)
      expect(mockViewManager.preloadWorkspaceUrl).not.toHaveBeenCalled();
    });

    it("does not preload when zero workspaces exist", async () => {
      mockWorkspaceProvider.discover.mockResolvedValueOnce([]);

      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080,
        mockFileSystemLayer,
        mockLoggingService,
        "claude-code",
        mockWorkspaceFileService,
        MOCK_WRAPPER_PATH
      );

      await appState.openProject("/project");

      // No setActiveWorkspace or preload calls
      expect(mockViewManager.setActiveWorkspace).not.toHaveBeenCalled();
      expect(mockViewManager.preloadWorkspaceUrl).not.toHaveBeenCalled();
    });

    it("preloads remaining workspaces using fire-and-forget pattern", async () => {
      // Set up multiple workspaces
      mockWorkspaceProvider.discover.mockResolvedValueOnce([
        { name: "workspace-1", path: new Path("/project/.worktrees/workspace-1"), branch: "ws-1" },
        { name: "workspace-2", path: new Path("/project/.worktrees/workspace-2"), branch: "ws-2" },
        { name: "workspace-3", path: new Path("/project/.worktrees/workspace-3"), branch: "ws-3" },
      ]);

      // Track call order to verify fire-and-forget pattern
      const preloadCallOrder: string[] = [];
      mockViewManager.preloadWorkspaceUrl.mockImplementation((path: string) => {
        preloadCallOrder.push(path);
        // Fire-and-forget: method returns void, no await, no errors propagate
        // This simulates the real ViewManager behavior where loadURL Promise is ignored
      });

      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080,
        mockFileSystemLayer,
        mockLoggingService,
        "claude-code",
        mockWorkspaceFileService,
        MOCK_WRAPPER_PATH
      );

      const project = await appState.openProject("/project");

      // Project opens successfully
      expect(project.workspaces).toHaveLength(3);

      // First workspace is set as active (loads URL via setActiveWorkspace)
      expect(mockViewManager.setActiveWorkspace).toHaveBeenCalledWith(
        "/project/.worktrees/workspace-1"
      );

      // Fire-and-forget pattern: all remaining workspaces are preloaded in sequence
      // (not awaited, so project:open completes without waiting for URL loads)
      expect(preloadCallOrder).toEqual([
        "/project/.worktrees/workspace-2",
        "/project/.worktrees/workspace-3",
      ]);
    });
  });

  describe("closeProject", () => {
    it("destroys all workspace views", async () => {
      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080,
        mockFileSystemLayer,
        mockLoggingService,
        "claude-code",
        mockWorkspaceFileService,
        MOCK_WRAPPER_PATH
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
        8080,
        mockFileSystemLayer,
        mockLoggingService,
        "claude-code",
        mockWorkspaceFileService,
        MOCK_WRAPPER_PATH
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
        8080,
        mockFileSystemLayer,
        mockLoggingService,
        "claude-code",
        mockWorkspaceFileService,
        MOCK_WRAPPER_PATH
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
        8080,
        mockFileSystemLayer,
        mockLoggingService,
        "claude-code",
        mockWorkspaceFileService,
        MOCK_WRAPPER_PATH
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
        8080,
        mockFileSystemLayer,
        mockLoggingService,
        "claude-code",
        mockWorkspaceFileService,
        MOCK_WRAPPER_PATH
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
        8080,
        mockFileSystemLayer,
        mockLoggingService,
        "claude-code",
        mockWorkspaceFileService,
        MOCK_WRAPPER_PATH
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
        8080,
        mockFileSystemLayer,
        mockLoggingService,
        "claude-code",
        mockWorkspaceFileService,
        MOCK_WRAPPER_PATH
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
        8080,
        mockFileSystemLayer,
        mockLoggingService,
        "claude-code",
        mockWorkspaceFileService,
        MOCK_WRAPPER_PATH
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
        8080,
        mockFileSystemLayer,
        mockLoggingService,
        "claude-code",
        mockWorkspaceFileService,
        MOCK_WRAPPER_PATH
      );

      expect(appState.getWorkspaceProvider("/nonexistent")).toBeUndefined();
    });
  });

  describe("getWorkspaceUrl", () => {
    it("generates code-server URL with workspace parameter when file creation succeeds", async () => {
      // Mock ensureWorkspaceFile to return a workspace file path
      mockWorkspaceFileService.ensureWorkspaceFile.mockResolvedValue(
        new Path("/test/workspaces/my-workspace.code-workspace")
      );

      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080,
        mockFileSystemLayer,
        mockLoggingService,
        "claude-code",
        mockWorkspaceFileService,
        MOCK_WRAPPER_PATH
      );

      const url = await appState.getWorkspaceUrl("/path/to/workspace", {});

      expect(url).toContain("http://127.0.0.1:8080");
      expect(url).toContain("workspace=");
    });

    it("falls back to folder URL when workspace file creation fails", async () => {
      // Mock ensureWorkspaceFile to throw an error
      mockWorkspaceFileService.ensureWorkspaceFile.mockRejectedValue(
        new Error("File creation failed")
      );

      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080,
        mockFileSystemLayer,
        mockLoggingService,
        "claude-code",
        mockWorkspaceFileService,
        MOCK_WRAPPER_PATH
      );

      const url = await appState.getWorkspaceUrl("/path/to/workspace", {});

      expect(url).toContain("http://127.0.0.1:8080");
      expect(url).toContain("folder=");
    });

    it("passes agent settings to workspace file service", async () => {
      mockWorkspaceFileService.ensureWorkspaceFile.mockResolvedValue(
        new Path("/test/workspaces/my-workspace.code-workspace")
      );

      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080,
        mockFileSystemLayer,
        mockLoggingService,
        "claude-code",
        mockWorkspaceFileService,
        MOCK_WRAPPER_PATH
      );

      const envVars = { ANTHROPIC_API_KEY: "test-key" };
      await appState.getWorkspaceUrl("/path/to/workspace", envVars);

      expect(mockWorkspaceFileService.ensureWorkspaceFile).toHaveBeenCalledWith(
        expect.any(Path), // workspacePath
        expect.any(Path), // projectWorkspacesDir
        expect.objectContaining({
          "claudeCode.claudeProcessWrapper": MOCK_WRAPPER_PATH,
          // Env vars are converted to {name, value}[] format for Claude extension
          "claudeCode.environmentVariables": [{ name: "ANTHROPIC_API_KEY", value: "test-key" }],
        })
      );
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
        8080,
        mockFileSystemLayer,
        mockLoggingService,
        "claude-code",
        mockWorkspaceFileService,
        MOCK_WRAPPER_PATH
      );

      await appState.loadPersistedProjects();

      expect(mockProjectStore.loadAllProjects).toHaveBeenCalled();
      // createGitWorktreeProvider is called with projectPath (Path), workspacesDir (Path), fileSystemLayer, loggers, and options
      expect(mockCreateGitWorktreeProvider).toHaveBeenCalledWith(
        expect.any(Path), // projectPath as Path
        expect.any(Path), // workspacesDir as Path
        expect.any(Object), // FileSystemLayer
        expect.any(Object), // Git Logger
        expect.any(Object), // Worktree Logger
        expect.objectContaining({ keepFilesService: expect.any(Object) }) // Options with KeepFilesService
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
        8080,
        mockFileSystemLayer,
        mockLoggingService,
        "claude-code",
        mockWorkspaceFileService,
        MOCK_WRAPPER_PATH
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
        8080,
        mockFileSystemLayer,
        mockLoggingService,
        "claude-code",
        mockWorkspaceFileService,
        MOCK_WRAPPER_PATH
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
        8080,
        mockFileSystemLayer,
        mockLoggingService,
        "claude-code",
        mockWorkspaceFileService,
        MOCK_WRAPPER_PATH
      );

      await appState.openProject("/project");
      const project = appState.findProjectForWorkspace("/other/.worktrees/unknown");

      expect(project).toBeUndefined();
    });
  });

  describe("openProject agent status integration", () => {
    // Note: Agent status initialization via initWorkspace is now handled by
    // OpenCodeServerManager callbacks routed through AppState (see Step 11 of SINGLE_OPENCODE_SERVER.md).
    // AppState.openProject no longer calls initWorkspace directly.

    it("does not fail when agentStatusManager is not set", async () => {
      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080,
        mockFileSystemLayer,
        mockLoggingService,
        "claude-code",
        mockWorkspaceFileService,
        MOCK_WRAPPER_PATH
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

      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080,
        mockFileSystemLayer,
        mockLoggingService,
        "claude-code",
        mockWorkspaceFileService,
        MOCK_WRAPPER_PATH
      );

      // openProject should still succeed despite cleanup failure
      const project = await appState.openProject("/project");

      expect(project.path).toBe("/project");
      // Give the async cleanup a chance to complete
      await delay(10);
      // Logging is an implementation detail - we just verify the operation succeeded
    });

    it("calls cleanupOrphanedWorkspaces on openProject", async () => {
      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080,
        mockFileSystemLayer,
        mockLoggingService,
        "claude-code",
        mockWorkspaceFileService,
        MOCK_WRAPPER_PATH
      );

      await appState.openProject("/project");

      // Give the async cleanup a chance to be called
      await delay(10);
      expect(mockWorkspaceProvider.cleanupOrphanedWorkspaces).toHaveBeenCalled();
    });
  });

  describe("setLastBaseBranch", () => {
    it("stores branch in runtime map", async () => {
      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080,
        mockFileSystemLayer,
        mockLoggingService,
        "claude-code",
        mockWorkspaceFileService,
        MOCK_WRAPPER_PATH
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
        8080,
        mockFileSystemLayer,
        mockLoggingService,
        "claude-code",
        mockWorkspaceFileService,
        MOCK_WRAPPER_PATH
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
        8080,
        mockFileSystemLayer,
        mockLoggingService,
        "claude-code",
        mockWorkspaceFileService,
        MOCK_WRAPPER_PATH
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
        8080,
        mockFileSystemLayer,
        mockLoggingService,
        "claude-code",
        mockWorkspaceFileService,
        MOCK_WRAPPER_PATH
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
        8080,
        mockFileSystemLayer,
        mockLoggingService,
        "claude-code",
        mockWorkspaceFileService,
        MOCK_WRAPPER_PATH
      );

      // Don't open any project
      const result = await appState.getDefaultBaseBranch("/nonexistent");
      expect(result).toBeUndefined();
    });

    it("returns undefined when provider.defaultBase() throws", async () => {
      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080,
        mockFileSystemLayer,
        mockLoggingService,
        "claude-code",
        mockWorkspaceFileService,
        MOCK_WRAPPER_PATH
      );

      await appState.openProject("/project");

      // Now make defaultBase throw for the next call
      mockWorkspaceProvider.defaultBase.mockRejectedValueOnce(new Error("Git error"));

      const result = await appState.getDefaultBaseBranch("/project");
      expect(result).toBeUndefined();
      // Logging is an implementation detail - we just verify undefined is returned
    });
  });

  describe("openProject with defaultBaseBranch", () => {
    it("includes defaultBaseBranch in returned Project", async () => {
      mockWorkspaceProvider.defaultBase.mockResolvedValueOnce("main");

      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080,
        mockFileSystemLayer,
        mockLoggingService,
        "claude-code",
        mockWorkspaceFileService,
        MOCK_WRAPPER_PATH
      );

      const project = await appState.openProject("/project");

      expect(project.defaultBaseBranch).toBe("main");
    });

    it("includes runtime branch when previously set", async () => {
      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080,
        mockFileSystemLayer,
        mockLoggingService,
        "claude-code",
        mockWorkspaceFileService,
        MOCK_WRAPPER_PATH
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
        8080,
        mockFileSystemLayer,
        mockLoggingService,
        "claude-code",
        mockWorkspaceFileService,
        MOCK_WRAPPER_PATH
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
        8080,
        mockFileSystemLayer,
        mockLoggingService,
        "claude-code",
        mockWorkspaceFileService,
        MOCK_WRAPPER_PATH
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

  describe("getAgentStartupCommand", () => {
    it("returns default command when agentStatusManager is not set", async () => {
      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080,
        mockFileSystemLayer,
        mockLoggingService,
        "claude-code",
        mockWorkspaceFileService,
        MOCK_WRAPPER_PATH
      );

      // Without agentStatusManager set, should return default
      const command = appState.getAgentStartupCommand(
        "/project/.worktrees/feature-1" as import("../shared/ipc").WorkspacePath
      );
      expect(command).toBe("opencode.openTerminal");
    });

    it("returns default command when provider not found", async () => {
      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080,
        mockFileSystemLayer,
        mockLoggingService,
        "claude-code",
        mockWorkspaceFileService,
        MOCK_WRAPPER_PATH
      );

      // Create a mock AgentStatusManager
      const mockAgentStatusManager = {
        getProvider: vi.fn().mockReturnValue(undefined),
        addProvider: vi.fn(),
        hasProvider: vi.fn(),
        removeWorkspace: vi.fn(),
        disconnectWorkspace: vi.fn(),
        reconnectWorkspace: vi.fn(),
        markActive: vi.fn(),
        clearTuiTracking: vi.fn(),
        onStatusChanged: vi.fn(),
        dispose: vi.fn(),
        getLogger: vi.fn(),
        getSdkFactory: vi.fn(),
      };
      appState.setAgentStatusManager(
        mockAgentStatusManager as unknown as import("../agents").AgentStatusManager
      );

      // Provider not found, should return default
      const command = appState.getAgentStartupCommand(
        "/project/.worktrees/feature-1" as import("../shared/ipc").WorkspacePath
      );
      expect(command).toBe("opencode.openTerminal");
    });

    it("returns provider startup command when provider found", async () => {
      const appState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080,
        mockFileSystemLayer,
        mockLoggingService,
        "claude-code",
        mockWorkspaceFileService,
        MOCK_WRAPPER_PATH
      );

      // Create a mock provider with startupCommands
      const mockProvider = {
        startupCommands: ["claude-vscode.terminal.open"] as readonly string[],
        connect: vi.fn(),
        disconnect: vi.fn(),
        reconnect: vi.fn(),
        onStatusChange: vi.fn(),
        getSession: vi.fn(),
        getEnvironmentVariables: vi.fn(),
        markActive: vi.fn(),
        dispose: vi.fn(),
      };

      // Create a mock AgentStatusManager that returns the provider
      const mockAgentStatusManager = {
        getProvider: vi.fn().mockReturnValue(mockProvider),
        addProvider: vi.fn(),
        hasProvider: vi.fn(),
        removeWorkspace: vi.fn(),
        disconnectWorkspace: vi.fn(),
        reconnectWorkspace: vi.fn(),
        markActive: vi.fn(),
        clearTuiTracking: vi.fn(),
        onStatusChanged: vi.fn(),
        dispose: vi.fn(),
        getLogger: vi.fn(),
        getSdkFactory: vi.fn(),
      };
      appState.setAgentStatusManager(
        mockAgentStatusManager as unknown as import("../agents").AgentStatusManager
      );

      // Provider found, should return provider's startup command
      const command = appState.getAgentStartupCommand(
        "/project/.worktrees/feature-1" as import("../shared/ipc").WorkspacePath
      );
      expect(command).toBe("claude-vscode.terminal.open");
    });
  });
});
