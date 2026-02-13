// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
const { mockProjectStore, mockViewManager, mockWorkspaceFileService, mockGlobalProvider } =
  vi.hoisted(() => {
    const mockStore = {
      saveProject: vi.fn(() => Promise.resolve()),
      removeProject: vi.fn(() => Promise.resolve()),
      loadAllProjects: vi.fn(() => Promise.resolve([] as string[])),
      getProjectConfig: vi.fn(() =>
        Promise.resolve(undefined as { remoteUrl?: string } | undefined)
      ),
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
      deleteWorkspaceFile: vi.fn(),
    };

    // Mock GitWorktreeProvider (global provider)
    const mockProvider = {
      defaultBase: vi.fn(() => Promise.resolve("main")),
    };

    return {
      mockProjectStore: mockStore,
      mockViewManager: mockView,
      mockWorkspaceFileService: mockWsFileService,
      mockGlobalProvider: mockProvider,
    };
  });

import { AppState } from "./app-state";
import type { ProjectStore } from "../services";
import { generateProjectId } from "../shared/api/id-utils";

/**
 * Helper: register a project in AppState via the public registerProject() API.
 * Returns the AppState for chaining.
 */
function registerTestProject(
  appState: AppState,
  projectPath: string,
  workspaces: Array<{ name: string; path: string; branch: string }> = [
    { name: "feature-1", path: "/project/.worktrees/feature-1", branch: "feature-1" },
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
  });
}

describe("AppState", () => {
  let appState: AppState;

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

    appState = new AppState(
      mockProjectStore as unknown as ProjectStore,
      mockViewManager as unknown as IViewManager,
      mockPathProvider,
      8080,
      mockFileSystemLayer,
      mockLoggingService,
      "claude",
      mockWorkspaceFileService,
      MOCK_WRAPPER_PATH,
      mockGlobalProvider as never
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("constructor", () => {
    it("creates an AppState instance", () => {
      expect(appState).toBeInstanceOf(AppState);
    });
  });

  describe("getProject", () => {
    it("returns project for registered path", () => {
      registerTestProject(appState, "/project");
      const project = appState.getProject("/project");

      expect(project?.path).toBe("/project");
    });

    it("returns undefined for non-existent path", () => {
      expect(appState.getProject("/nonexistent")).toBeUndefined();
    });
  });

  describe("getAllProjects", () => {
    it("returns all registered projects", async () => {
      registerTestProject(appState, "/project");
      const projects = await appState.getAllProjects();

      expect(projects).toHaveLength(1);
      expect(projects[0]?.path).toBe("/project");
    });
  });

  describe("getWorkspaceUrl", () => {
    it("generates code-server URL with workspace parameter when file creation succeeds", async () => {
      // Mock ensureWorkspaceFile to return a workspace file path
      mockWorkspaceFileService.ensureWorkspaceFile.mockResolvedValue(
        new Path("/test/workspaces/my-workspace.code-workspace")
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

      const url = await appState.getWorkspaceUrl("/path/to/workspace", {});

      expect(url).toContain("http://127.0.0.1:8080");
      expect(url).toContain("folder=");
    });

    it("passes agent settings to workspace file service", async () => {
      mockWorkspaceFileService.ensureWorkspaceFile.mockResolvedValue(
        new Path("/test/workspaces/my-workspace.code-workspace")
      );

      const envVars = { ANTHROPIC_API_KEY: "test-key" };
      await appState.getWorkspaceUrl("/path/to/workspace", envVars);

      expect(mockWorkspaceFileService.ensureWorkspaceFile).toHaveBeenCalledWith(
        expect.any(Path), // workspacePath
        expect.any(Path), // projectWorkspacesDir
        expect.objectContaining({
          "claudeCode.useTerminal": true,
          "claudeCode.claudeProcessWrapper": MOCK_WRAPPER_PATH,
          // Env vars are converted to {name, value}[] format for Claude extension
          "claudeCode.environmentVariables": [{ name: "ANTHROPIC_API_KEY", value: "test-key" }],
        })
      );
    });
  });

  describe("findProjectForWorkspace", () => {
    it("finds project containing workspace", () => {
      registerTestProject(appState, "/project");
      const project = appState.findProjectForWorkspace("/project/.worktrees/feature-1");

      expect(project?.path).toBe("/project");
    });

    it("returns undefined for unknown workspace", () => {
      registerTestProject(appState, "/project");
      const project = appState.findProjectForWorkspace("/other/.worktrees/unknown");

      expect(project).toBeUndefined();
    });
  });

  describe("setLastBaseBranch", () => {
    it("stores branch in runtime map", async () => {
      registerTestProject(appState, "/project");
      appState.setLastBaseBranch("/project", "feature-branch");

      // Verify it's stored by getting the default which should return the set value
      const defaultBranch = await appState.getDefaultBaseBranch("/project");
      expect(defaultBranch).toBe("feature-branch");
    });

    it("with same branch twice is idempotent", async () => {
      registerTestProject(appState, "/project");
      appState.setLastBaseBranch("/project", "feature-branch");
      appState.setLastBaseBranch("/project", "feature-branch");

      const defaultBranch = await appState.getDefaultBaseBranch("/project");
      expect(defaultBranch).toBe("feature-branch");
    });
  });

  describe("getDefaultBaseBranch", () => {
    it("returns runtime value when set", async () => {
      registerTestProject(appState, "/project");
      appState.setLastBaseBranch("/project", "develop");

      const result = await appState.getDefaultBaseBranch("/project");
      expect(result).toBe("develop");
    });

    it("falls back to globalProvider.defaultBase() when not set", async () => {
      mockGlobalProvider.defaultBase.mockResolvedValueOnce("main");
      registerTestProject(appState, "/project");

      const result = await appState.getDefaultBaseBranch("/project");
      expect(result).toBe("main");
      expect(mockGlobalProvider.defaultBase).toHaveBeenCalledWith(new Path("/project"));
    });

    it("returns undefined when provider not found", async () => {
      // Don't register any project
      const result = await appState.getDefaultBaseBranch("/nonexistent");
      expect(result).toBeUndefined();
    });

    it("returns cached value even after provider error would occur", async () => {
      registerTestProject(appState, "/project");
      appState.setLastBaseBranch("/project", "main");

      // Now make defaultBase throw - but it won't be called because cache hit
      mockGlobalProvider.defaultBase.mockRejectedValueOnce(new Error("Git error"));

      const result = await appState.getDefaultBaseBranch("/project");
      // Returns cached value, provider is not called
      expect(result).toBe("main");
    });
  });

  describe("getAllProjects with defaultBaseBranch", () => {
    it("includes current defaultBaseBranch for each project", async () => {
      mockGlobalProvider.defaultBase.mockResolvedValue("main");
      registerTestProject(appState, "/project");
      appState.setLastBaseBranch("/project", "feature-x");

      const projects = await appState.getAllProjects();

      expect(projects[0]?.defaultBaseBranch).toBe("feature-x");
    });
  });

  describe("getDefaultBaseBranch integration", () => {
    it("cached value takes precedence over provider fallback", async () => {
      // Use setLastBaseBranch to set the initial value (simulates intent-based flow
      // where project:open sets the default branch after discovery)
      registerTestProject(appState, "/project");
      appState.setLastBaseBranch("/project", "main");

      // Cached value is returned
      const initialDefault = await appState.getDefaultBaseBranch("/project");
      expect(initialDefault).toBe("main");

      // After setLastBaseBranch with new value, should return new cached value
      appState.setLastBaseBranch("/project", "develop");
      const cachedDefault = await appState.getDefaultBaseBranch("/project");
      expect(cachedDefault).toBe("develop");
    });
  });

  describe("getAgentType", () => {
    it("returns configured agent type for claude", () => {
      expect(appState.getAgentType()).toBe("claude");
    });

    it("returns configured agent type for opencode", () => {
      const opcAppState = new AppState(
        mockProjectStore as unknown as ProjectStore,
        mockViewManager as unknown as IViewManager,
        mockPathProvider,
        8080,
        mockFileSystemLayer,
        mockLoggingService,
        "opencode",
        mockWorkspaceFileService,
        MOCK_WRAPPER_PATH,
        mockGlobalProvider as never
      );

      expect(opcAppState.getAgentType()).toBe("opencode");
    });
  });
});
