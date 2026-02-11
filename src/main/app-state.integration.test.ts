// @vitest-environment node

/**
 * Integration tests for AppState.
 *
 * Tests verify project and workspace state management, including
 * workspace registration/unregistration.
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
import { generateProjectId } from "../shared/api/id-utils";

// =============================================================================
// Mock Factories
// =============================================================================

const WORKSPACES_DIR = "/test/workspaces";

// Mock workspace provider
const { mockProjectStore, mockWorkspaceProvider } = vi.hoisted(() => {
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
    getProjectConfig: vi.fn(() => Promise.resolve(undefined)),
  };

  return {
    mockProjectStore: mockStore,
    mockWorkspaceProvider: mockProvider,
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

// Mock wrapper path for Claude wrapper
const MOCK_WRAPPER_PATH = "/mock/bin/claude";

function createMockWorkspaceFileService() {
  return {
    ensureWorkspaceFile: vi.fn().mockResolvedValue(new Path("/test/workspace.code-workspace")),
    createWorkspaceFile: vi.fn().mockResolvedValue(new Path("/test/workspace.code-workspace")),
    getWorkspaceFilePath: vi.fn().mockReturnValue(new Path("/test/workspace.code-workspace")),
    deleteWorkspaceFile: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Helper: register a project in AppState via the public registerProject() API.
 */
function registerTestProject(
  appState: AppState,
  projectPath: string,
  workspaces: Array<{ name: string; path: string; branch: string }> = [
    { name: "feature-1", path: `${projectPath}/.worktrees/feature-1`, branch: "feature-1" },
  ]
): void {
  const path = new Path(projectPath);
  appState.registerProject({
    id: generateProjectId(path.toString()),
    name: path.basename,
    path,
    workspaces: workspaces.map((w) => ({
      name: w.name,
      path: new Path(w.path),
      branch: w.branch,
      metadata: {},
    })),
    provider: mockWorkspaceProvider as never,
  });
}

// =============================================================================
// Integration Tests: Workspace Removal Cleanup Flow
// =============================================================================

describe("AppState Integration", () => {
  let appState: AppState;
  let mockViewManager: IViewManager;
  let mockPathProvider: PathProvider;
  let mockFileSystemLayer: FileSystemLayer;
  let mockLoggingService: MockLoggingService;
  let mockWorkspaceFileService: ReturnType<typeof createMockWorkspaceFileService>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProjectStore.loadAllProjects.mockResolvedValue([]);
    mockPathProvider = createMockPathProvider({
      dataRootDir: WORKSPACES_DIR,
    });
    mockViewManager = createMockViewManager();
    mockFileSystemLayer = createFileSystemMock();
    mockLoggingService = createMockLoggingService();
    mockWorkspaceFileService = createMockWorkspaceFileService();

    appState = new AppState(
      mockProjectStore as unknown as ProjectStore,
      mockViewManager,
      mockPathProvider,
      8080,
      mockFileSystemLayer,
      mockLoggingService,
      "claude",
      mockWorkspaceFileService,
      MOCK_WRAPPER_PATH
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("unregisterWorkspace", () => {
    it("removes workspace from project state without stopping servers or destroying views", () => {
      registerTestProject(appState, "/project");

      // Verify workspace exists
      const projectBefore = appState.getProject("/project");
      expect(projectBefore?.workspaces).toHaveLength(1);

      // Clear mocks
      vi.clearAllMocks();

      // Unregister workspace (state-only removal)
      appState.unregisterWorkspace("/project", "/project/.worktrees/feature-1");

      // Verify workspace removed from state
      const projectAfter = appState.getProject("/project");
      expect(projectAfter?.workspaces).toHaveLength(0);

      // Verify no server/view cleanup happened (that's the hook modules' job)
      expect(mockViewManager.destroyWorkspaceView).not.toHaveBeenCalled();
    });

    it("handles non-existent project gracefully", () => {
      // Should not throw
      expect(() =>
        appState.unregisterWorkspace("/nonexistent", "/nonexistent/.worktrees/feature-1")
      ).not.toThrow();
    });
  });
});
