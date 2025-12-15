/**
 * Tests for CodeHydraApiImpl.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CodeHydraApiImpl } from "./codehydra-api";
import type { AppState } from "../app-state";
import type { IViewManager } from "../managers/view-manager.interface";
import type { ProjectId, WorkspaceName, Project, Workspace } from "../../shared/api/types";
import type {
  Project as InternalProject,
  ProjectPath,
  BaseInfo,
  AggregatedAgentStatus,
} from "../../shared/ipc";
import type { IWorkspaceProvider } from "../../services/git/workspace-provider";
import type { Workspace as InternalWorkspace } from "../../services/git/types";
import type { AgentStatusManager } from "../../services/opencode/agent-status-manager";
import type { IVscodeSetup } from "../../services/vscode-setup/types";

// =============================================================================
// Mock Factories
// =============================================================================

function createMockAppState(overrides: Partial<AppState> = {}): AppState {
  return {
    openProject: vi.fn(),
    closeProject: vi.fn(),
    getProject: vi.fn(),
    getAllProjects: vi.fn().mockResolvedValue([]),
    getWorkspaceProvider: vi.fn(),
    findProjectForWorkspace: vi.fn(),
    addWorkspace: vi.fn(),
    removeWorkspace: vi.fn(),
    getWorkspaceUrl: vi.fn(),
    getDefaultBaseBranch: vi.fn(),
    setLastBaseBranch: vi.fn(),
    loadPersistedProjects: vi.fn(),
    setDiscoveryService: vi.fn(),
    getDiscoveryService: vi.fn(),
    setAgentStatusManager: vi.fn(),
    getAgentStatusManager: vi.fn(),
    ...overrides,
  } as unknown as AppState;
}

function createMockViewManager(overrides: Partial<IViewManager> = {}): IViewManager {
  return {
    getUIView: vi.fn(),
    createWorkspaceView: vi.fn(),
    destroyWorkspaceView: vi.fn(),
    getWorkspaceView: vi.fn(),
    updateBounds: vi.fn(),
    setActiveWorkspace: vi.fn(),
    getActiveWorkspacePath: vi.fn(),
    focusActiveWorkspace: vi.fn(),
    focusUI: vi.fn(),
    setDialogMode: vi.fn(),
    setMode: vi.fn(),
    getMode: vi.fn().mockReturnValue("workspace"),
    onModeChange: vi.fn().mockReturnValue(() => {}),
    updateCodeServerPort: vi.fn(),
    ...overrides,
  } as unknown as IViewManager;
}

function createMockElectronDialog(): typeof Electron.dialog {
  return {
    showOpenDialog: vi.fn().mockResolvedValue({ canceled: true, filePaths: [] }),
    showSaveDialog: vi.fn(),
    showMessageBox: vi.fn(),
    showErrorBox: vi.fn(),
    showCertificateTrustDialog: vi.fn(),
  } as unknown as typeof Electron.dialog;
}

function createMockElectronApp(): typeof Electron.app {
  return {
    quit: vi.fn(),
    exit: vi.fn(),
    relaunch: vi.fn(),
    isReady: vi.fn().mockReturnValue(true),
    whenReady: vi.fn().mockResolvedValue(undefined),
    focus: vi.fn(),
    hide: vi.fn(),
    show: vi.fn(),
    setAppUserModelId: vi.fn(),
    isPackaged: false,
    getName: vi.fn().mockReturnValue("codehydra"),
    getVersion: vi.fn().mockReturnValue("0.0.0"),
    getPath: vi.fn(),
    setPath: vi.fn(),
    getLocale: vi.fn().mockReturnValue("en-US"),
  } as unknown as typeof Electron.app;
}

// =============================================================================
// Test Data
// =============================================================================

const TEST_PROJECT_PATH = "/home/user/projects/my-app" as ProjectPath;
const TEST_PROJECT_ID = "my-app-b9703f12" as ProjectId;
const TEST_WORKSPACE_NAME = "feature-branch" as WorkspaceName;
const TEST_WORKSPACE_PATH = "/home/user/.codehydra/projects/my-app/workspaces/feature-branch";

function createTestProject(overrides: Partial<Project> = {}): Project {
  return {
    id: TEST_PROJECT_ID,
    name: "my-app",
    path: TEST_PROJECT_PATH,
    workspaces: [],
    ...overrides,
  };
}

function createTestWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    projectId: TEST_PROJECT_ID,
    name: TEST_WORKSPACE_NAME,
    branch: "feature-branch",
    path: TEST_WORKSPACE_PATH,
    ...overrides,
  };
}

// Used in future tests
void createTestWorkspace;

/**
 * Create an internal project (as returned by AppState).
 */
function createInternalProject(overrides: Partial<InternalProject> = {}): InternalProject {
  return {
    path: TEST_PROJECT_PATH,
    name: "my-app",
    workspaces: [],
    ...overrides,
  };
}

// =============================================================================
// Tests: API Skeleton
// =============================================================================

describe("CodeHydraApiImpl - Skeleton", () => {
  let appState: AppState;
  let viewManager: IViewManager;
  let dialog: typeof Electron.dialog;
  let app: typeof Electron.app;
  let api: CodeHydraApiImpl;

  beforeEach(() => {
    appState = createMockAppState();
    viewManager = createMockViewManager();
    dialog = createMockElectronDialog();
    app = createMockElectronApp();
    api = new CodeHydraApiImpl(appState, viewManager, dialog, app);
  });

  describe("instantiation", () => {
    it("should create instance with services", () => {
      expect(api).toBeDefined();
      expect(api.projects).toBeDefined();
      expect(api.workspaces).toBeDefined();
      expect(api.ui).toBeDefined();
      expect(api.lifecycle).toBeDefined();
    });
  });

  describe("on() subscription", () => {
    it("should return unsubscribe function", () => {
      const handler = vi.fn();
      const unsubscribe = api.on("project:opened", handler);

      expect(typeof unsubscribe).toBe("function");
    });

    it("should call handler when event emitted", () => {
      const handler = vi.fn();
      api.on("project:opened", handler);

      const project = createTestProject();
      api.emit("project:opened", { project });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({ project });
    });

    it("should stop calling handler after unsubscribe", () => {
      const handler = vi.fn();
      const unsubscribe = api.on("project:opened", handler);

      unsubscribe();

      const project = createTestProject();
      api.emit("project:opened", { project });

      expect(handler).not.toHaveBeenCalled();
    });

    it("should support multiple handlers for same event", () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      api.on("project:opened", handler1);
      api.on("project:opened", handler2);

      const project = createTestProject();
      api.emit("project:opened", { project });

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });

    it("should not break other handlers if one throws", () => {
      const errorHandler = vi.fn().mockImplementation(() => {
        throw new Error("Handler error");
      });
      const normalHandler = vi.fn();

      api.on("project:opened", errorHandler);
      api.on("project:opened", normalHandler);

      const project = createTestProject();
      // Should not throw
      expect(() => api.emit("project:opened", { project })).not.toThrow();

      // Both should be called despite error
      expect(errorHandler).toHaveBeenCalledTimes(1);
      expect(normalHandler).toHaveBeenCalledTimes(1);
    });
  });

  describe("dispose()", () => {
    it("should remove all event subscriptions", () => {
      const handler = vi.fn();
      api.on("project:opened", handler);

      api.dispose();

      const project = createTestProject();
      api.emit("project:opened", { project });

      expect(handler).not.toHaveBeenCalled();
    });

    it("should be safe to call multiple times", () => {
      expect(() => {
        api.dispose();
        api.dispose();
      }).not.toThrow();
    });
  });
});

// =============================================================================
// Tests: ID Resolution (Private helpers exposed via public API behavior)
// =============================================================================

describe("CodeHydraApiImpl - ID Resolution", () => {
  let appState: AppState;
  let viewManager: IViewManager;
  let dialog: typeof Electron.dialog;
  let app: typeof Electron.app;
  let api: CodeHydraApiImpl;

  beforeEach(() => {
    appState = createMockAppState();
    viewManager = createMockViewManager();
    dialog = createMockElectronDialog();
    app = createMockElectronApp();
    api = new CodeHydraApiImpl(appState, viewManager, dialog, app);
  });

  describe("project resolution via get()", () => {
    it("should resolve project by ID", async () => {
      // Set up mock to return an internal project at the expected path
      const mockInternalProject = createInternalProject();
      vi.mocked(appState.getAllProjects).mockResolvedValue([mockInternalProject]);
      vi.mocked(appState.getProject).mockReturnValue(mockInternalProject);

      const result = await api.projects.get(TEST_PROJECT_ID);

      expect(result).toBeDefined();
      expect(result?.id).toBe(TEST_PROJECT_ID);
    });

    it("should return undefined for invalid project ID", async () => {
      vi.mocked(appState.getAllProjects).mockResolvedValue([]);

      const result = await api.projects.get("invalid-00000000" as ProjectId);

      expect(result).toBeUndefined();
    });
  });

  describe("workspace resolution via get()", () => {
    it("should resolve workspace by project ID and name", async () => {
      const mockInternalProject = createInternalProject({
        workspaces: [
          {
            name: "feature-branch",
            path: TEST_WORKSPACE_PATH,
            branch: "feature-branch",
          },
        ],
      });
      vi.mocked(appState.getAllProjects).mockResolvedValue([mockInternalProject]);
      vi.mocked(appState.getProject).mockReturnValue(mockInternalProject);

      const result = await api.workspaces.get(TEST_PROJECT_ID, TEST_WORKSPACE_NAME);

      expect(result).toBeDefined();
      expect(result?.name).toBe(TEST_WORKSPACE_NAME);
    });

    it("should return undefined for invalid workspace name", async () => {
      const mockInternalProject = createInternalProject();
      vi.mocked(appState.getAllProjects).mockResolvedValue([mockInternalProject]);
      vi.mocked(appState.getProject).mockReturnValue(mockInternalProject);

      const result = await api.workspaces.get(TEST_PROJECT_ID, "nonexistent" as WorkspaceName);

      expect(result).toBeUndefined();
    });
  });
});

// =============================================================================
// Tests: IProjectApi
// =============================================================================

describe("CodeHydraApiImpl - IProjectApi", () => {
  let appState: AppState;
  let viewManager: IViewManager;
  let dialog: typeof Electron.dialog;
  let app: typeof Electron.app;
  let api: CodeHydraApiImpl;

  beforeEach(() => {
    appState = createMockAppState();
    viewManager = createMockViewManager();
    dialog = createMockElectronDialog();
    app = createMockElectronApp();
    api = new CodeHydraApiImpl(appState, viewManager, dialog, app);
  });

  describe("open()", () => {
    it("should open a project and return it with generated ID", async () => {
      const mockInternalProject = createInternalProject();
      vi.mocked(appState.openProject).mockResolvedValue(mockInternalProject);

      const result = await api.projects.open(TEST_PROJECT_PATH);

      expect(appState.openProject).toHaveBeenCalledWith(TEST_PROJECT_PATH);
      expect(result.id).toBe(TEST_PROJECT_ID);
      expect(result.path).toBe(TEST_PROJECT_PATH);
      expect(result.name).toBe("my-app");
    });

    it("should emit project:opened event", async () => {
      const mockInternalProject = createInternalProject();
      vi.mocked(appState.openProject).mockResolvedValue(mockInternalProject);
      const handler = vi.fn();
      api.on("project:opened", handler);

      await api.projects.open(TEST_PROJECT_PATH);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          project: expect.objectContaining({ id: TEST_PROJECT_ID }),
        })
      );
    });

    it("should propagate errors from appState.openProject", async () => {
      vi.mocked(appState.openProject).mockRejectedValue(new Error("Not a git repository"));

      await expect(api.projects.open("/invalid/path")).rejects.toThrow("Not a git repository");
    });
  });

  describe("close()", () => {
    it("should close a project by ID", async () => {
      const mockInternalProject = createInternalProject();
      vi.mocked(appState.getAllProjects).mockResolvedValue([mockInternalProject]);
      vi.mocked(appState.closeProject).mockResolvedValue(undefined);

      await api.projects.close(TEST_PROJECT_ID);

      expect(appState.closeProject).toHaveBeenCalledWith(TEST_PROJECT_PATH);
    });

    it("should emit project:closed event", async () => {
      const mockInternalProject = createInternalProject();
      vi.mocked(appState.getAllProjects).mockResolvedValue([mockInternalProject]);
      vi.mocked(appState.closeProject).mockResolvedValue(undefined);
      const handler = vi.fn();
      api.on("project:closed", handler);

      await api.projects.close(TEST_PROJECT_ID);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({ projectId: TEST_PROJECT_ID });
    });

    it("should throw if project ID not found", async () => {
      vi.mocked(appState.getAllProjects).mockResolvedValue([]);

      await expect(api.projects.close("invalid-00000000" as ProjectId)).rejects.toThrow(
        /not found/i
      );
    });
  });

  describe("list()", () => {
    it("should return empty array when no projects", async () => {
      vi.mocked(appState.getAllProjects).mockResolvedValue([]);

      const result = await api.projects.list();

      expect(result).toEqual([]);
    });

    it("should return projects with generated IDs", async () => {
      const mockProject1 = createInternalProject();
      const mockProject2 = createInternalProject({
        path: "/home/user/projects/other-app" as ProjectPath,
        name: "other-app",
      });
      vi.mocked(appState.getAllProjects).mockResolvedValue([mockProject1, mockProject2]);

      const result = await api.projects.list();

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe(TEST_PROJECT_ID);
      expect(result[1].name).toBe("other-app");
    });

    it("should include defaultBaseBranch when available", async () => {
      const mockProject = createInternalProject({ defaultBaseBranch: "main" });
      vi.mocked(appState.getAllProjects).mockResolvedValue([mockProject]);

      const result = await api.projects.list();

      expect(result[0].defaultBaseBranch).toBe("main");
    });
  });

  describe("fetchBases()", () => {
    it("should return bases from workspace provider", async () => {
      const mockBases: BaseInfo[] = [
        { name: "main", isRemote: false },
        { name: "origin/main", isRemote: true },
      ];
      const mockProvider = {
        listBases: vi.fn().mockResolvedValue(mockBases),
        updateBases: vi.fn().mockResolvedValue({ fetchedRemotes: [], failedRemotes: [] }),
      } as unknown as IWorkspaceProvider;
      const mockInternalProject = createInternalProject();
      vi.mocked(appState.getAllProjects).mockResolvedValue([mockInternalProject]);
      vi.mocked(appState.getWorkspaceProvider).mockReturnValue(mockProvider);

      const result = await api.projects.fetchBases(TEST_PROJECT_ID);

      expect(result.bases).toEqual(mockBases);
    });

    it("should throw if project not found", async () => {
      vi.mocked(appState.getAllProjects).mockResolvedValue([]);

      await expect(api.projects.fetchBases("invalid-00000000" as ProjectId)).rejects.toThrow(
        /not found/i
      );
    });

    it("should trigger background fetch and emit event when complete", async () => {
      const mockBases: BaseInfo[] = [{ name: "main", isRemote: false }];
      const updatedBases: BaseInfo[] = [
        { name: "main", isRemote: false },
        { name: "origin/feature", isRemote: true },
      ];
      let fetchCompleted = false;
      const mockProvider = {
        listBases: vi.fn().mockImplementation(() => {
          // Return updated bases after fetch completes
          return Promise.resolve(fetchCompleted ? updatedBases : mockBases);
        }),
        updateBases: vi.fn().mockImplementation(async () => {
          fetchCompleted = true;
          return { fetchedRemotes: ["origin"], failedRemotes: [] };
        }),
      } as unknown as IWorkspaceProvider;
      const mockInternalProject = createInternalProject();
      vi.mocked(appState.getAllProjects).mockResolvedValue([mockInternalProject]);
      vi.mocked(appState.getWorkspaceProvider).mockReturnValue(mockProvider);

      const handler = vi.fn();
      api.on("project:bases-updated", handler);

      // Initial fetch should return cached bases
      const result = await api.projects.fetchBases(TEST_PROJECT_ID);
      expect(result.bases).toEqual(mockBases);

      // Wait for background fetch
      await vi.waitFor(() => expect(handler).toHaveBeenCalled());

      expect(handler).toHaveBeenCalledWith({
        projectId: TEST_PROJECT_ID,
        bases: updatedBases,
      });
    });
  });
});

// =============================================================================
// Tests: IWorkspaceApi
// =============================================================================

describe("CodeHydraApiImpl - IWorkspaceApi", () => {
  let appState: AppState;
  let viewManager: IViewManager;
  let dialog: typeof Electron.dialog;
  let app: typeof Electron.app;
  let api: CodeHydraApiImpl;

  beforeEach(() => {
    appState = createMockAppState();
    viewManager = createMockViewManager();
    dialog = createMockElectronDialog();
    app = createMockElectronApp();
    api = new CodeHydraApiImpl(appState, viewManager, dialog, app);
  });

  describe("create()", () => {
    it("should create a workspace and return it", async () => {
      const mockCreatedWorkspace: InternalWorkspace = {
        name: "new-feature",
        path: "/home/user/.codehydra/projects/my-app/workspaces/new-feature",
        branch: "new-feature",
      };
      const mockProvider = {
        createWorkspace: vi.fn().mockResolvedValue(mockCreatedWorkspace),
      } as unknown as IWorkspaceProvider;
      const mockInternalProject = createInternalProject();
      vi.mocked(appState.getAllProjects).mockResolvedValue([mockInternalProject]);
      vi.mocked(appState.getWorkspaceProvider).mockReturnValue(mockProvider);

      const result = await api.workspaces.create(TEST_PROJECT_ID, "new-feature", "main");

      expect(mockProvider.createWorkspace).toHaveBeenCalledWith("new-feature", "main");
      expect(result.name).toBe("new-feature" as WorkspaceName);
      expect(result.projectId).toBe(TEST_PROJECT_ID);
    });

    it("should emit workspace:created event", async () => {
      const mockCreatedWorkspace: InternalWorkspace = {
        name: "new-feature",
        path: "/home/user/.codehydra/projects/my-app/workspaces/new-feature",
        branch: "new-feature",
      };
      const mockProvider = {
        createWorkspace: vi.fn().mockResolvedValue(mockCreatedWorkspace),
      } as unknown as IWorkspaceProvider;
      const mockInternalProject = createInternalProject();
      vi.mocked(appState.getAllProjects).mockResolvedValue([mockInternalProject]);
      vi.mocked(appState.getWorkspaceProvider).mockReturnValue(mockProvider);
      const handler = vi.fn();
      api.on("workspace:created", handler);

      await api.workspaces.create(TEST_PROJECT_ID, "new-feature", "main");

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: TEST_PROJECT_ID,
          workspace: expect.objectContaining({ name: "new-feature" }),
        })
      );
    });

    it("should call appState.addWorkspace to update state", async () => {
      const mockCreatedWorkspace: InternalWorkspace = {
        name: "new-feature",
        path: "/home/user/.codehydra/projects/my-app/workspaces/new-feature",
        branch: "new-feature",
      };
      const mockProvider = {
        createWorkspace: vi.fn().mockResolvedValue(mockCreatedWorkspace),
      } as unknown as IWorkspaceProvider;
      const mockInternalProject = createInternalProject();
      vi.mocked(appState.getAllProjects).mockResolvedValue([mockInternalProject]);
      vi.mocked(appState.getWorkspaceProvider).mockReturnValue(mockProvider);

      await api.workspaces.create(TEST_PROJECT_ID, "new-feature", "main");

      expect(appState.addWorkspace).toHaveBeenCalledWith(TEST_PROJECT_PATH, mockCreatedWorkspace);
    });

    it("should throw if project not found", async () => {
      vi.mocked(appState.getAllProjects).mockResolvedValue([]);

      await expect(
        api.workspaces.create("invalid-00000000" as ProjectId, "feature", "main")
      ).rejects.toThrow(/not found/i);
    });

    it("should remember last used base branch", async () => {
      const mockCreatedWorkspace: InternalWorkspace = {
        name: "new-feature",
        path: "/home/user/.codehydra/projects/my-app/workspaces/new-feature",
        branch: "new-feature",
      };
      const mockProvider = {
        createWorkspace: vi.fn().mockResolvedValue(mockCreatedWorkspace),
      } as unknown as IWorkspaceProvider;
      const mockInternalProject = createInternalProject();
      vi.mocked(appState.getAllProjects).mockResolvedValue([mockInternalProject]);
      vi.mocked(appState.getWorkspaceProvider).mockReturnValue(mockProvider);

      await api.workspaces.create(TEST_PROJECT_ID, "new-feature", "develop");

      expect(appState.setLastBaseBranch).toHaveBeenCalledWith(TEST_PROJECT_PATH, "develop");
    });
  });

  describe("remove()", () => {
    it("should remove a workspace", async () => {
      const mockProvider = {
        removeWorkspace: vi.fn().mockResolvedValue({ workspaceRemoved: true, baseDeleted: false }),
      } as unknown as IWorkspaceProvider;
      const mockInternalProject = createInternalProject({
        workspaces: [
          { name: "feature-branch", path: TEST_WORKSPACE_PATH, branch: "feature-branch" },
        ],
      });
      vi.mocked(appState.getAllProjects).mockResolvedValue([mockInternalProject]);
      vi.mocked(appState.getProject).mockReturnValue(mockInternalProject);
      vi.mocked(appState.getWorkspaceProvider).mockReturnValue(mockProvider);

      const result = await api.workspaces.remove(TEST_PROJECT_ID, TEST_WORKSPACE_NAME);

      // keepBranch defaults to true, so deleteBase should be false
      expect(mockProvider.removeWorkspace).toHaveBeenCalledWith(TEST_WORKSPACE_PATH, false);
      expect(result.branchDeleted).toBe(false);
    });

    it("should emit workspace:removed event", async () => {
      const mockProvider = {
        removeWorkspace: vi.fn().mockResolvedValue({ workspaceRemoved: true, baseDeleted: false }),
      } as unknown as IWorkspaceProvider;
      const mockInternalProject = createInternalProject({
        workspaces: [
          { name: "feature-branch", path: TEST_WORKSPACE_PATH, branch: "feature-branch" },
        ],
      });
      vi.mocked(appState.getAllProjects).mockResolvedValue([mockInternalProject]);
      vi.mocked(appState.getProject).mockReturnValue(mockInternalProject);
      vi.mocked(appState.getWorkspaceProvider).mockReturnValue(mockProvider);
      const handler = vi.fn();
      api.on("workspace:removed", handler);

      await api.workspaces.remove(TEST_PROJECT_ID, TEST_WORKSPACE_NAME);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({
        projectId: TEST_PROJECT_ID,
        workspaceName: TEST_WORKSPACE_NAME,
        path: TEST_WORKSPACE_PATH,
      });
    });

    it("should call appState.removeWorkspace to update state", async () => {
      const mockProvider = {
        removeWorkspace: vi.fn().mockResolvedValue({ workspaceRemoved: true, baseDeleted: false }),
      } as unknown as IWorkspaceProvider;
      const mockInternalProject = createInternalProject({
        workspaces: [
          { name: "feature-branch", path: TEST_WORKSPACE_PATH, branch: "feature-branch" },
        ],
      });
      vi.mocked(appState.getAllProjects).mockResolvedValue([mockInternalProject]);
      vi.mocked(appState.getProject).mockReturnValue(mockInternalProject);
      vi.mocked(appState.getWorkspaceProvider).mockReturnValue(mockProvider);

      await api.workspaces.remove(TEST_PROJECT_ID, TEST_WORKSPACE_NAME);

      expect(appState.removeWorkspace).toHaveBeenCalledWith(TEST_PROJECT_PATH, TEST_WORKSPACE_PATH);
    });

    it("should delete branch when keepBranch is false", async () => {
      const mockProvider = {
        removeWorkspace: vi.fn().mockResolvedValue({ workspaceRemoved: true, baseDeleted: true }),
      } as unknown as IWorkspaceProvider;
      const mockInternalProject = createInternalProject({
        workspaces: [
          { name: "feature-branch", path: TEST_WORKSPACE_PATH, branch: "feature-branch" },
        ],
      });
      vi.mocked(appState.getAllProjects).mockResolvedValue([mockInternalProject]);
      vi.mocked(appState.getProject).mockReturnValue(mockInternalProject);
      vi.mocked(appState.getWorkspaceProvider).mockReturnValue(mockProvider);

      const result = await api.workspaces.remove(TEST_PROJECT_ID, TEST_WORKSPACE_NAME, false);

      // keepBranch=false means deleteBase=true
      expect(mockProvider.removeWorkspace).toHaveBeenCalledWith(TEST_WORKSPACE_PATH, true);
      expect(result.branchDeleted).toBe(true);
    });

    it("should throw if workspace not found", async () => {
      const mockInternalProject = createInternalProject();
      vi.mocked(appState.getAllProjects).mockResolvedValue([mockInternalProject]);
      vi.mocked(appState.getProject).mockReturnValue(mockInternalProject);

      await expect(
        api.workspaces.remove(TEST_PROJECT_ID, "nonexistent" as WorkspaceName)
      ).rejects.toThrow(/not found/i);
    });

    describe("active workspace switching after removal", () => {
      const OTHER_WORKSPACE_PATH = "/home/user/.codehydra/projects/my-app/workspaces/other-feature";
      const OTHER_WORKSPACE_NAME = "other-feature" as WorkspaceName;

      it("should switch to another workspace in same project when active workspace is removed", async () => {
        const mockProvider = {
          removeWorkspace: vi
            .fn()
            .mockResolvedValue({ workspaceRemoved: true, baseDeleted: false }),
        } as unknown as IWorkspaceProvider;
        const mockInternalProject = createInternalProject({
          workspaces: [
            { name: "feature-branch", path: TEST_WORKSPACE_PATH, branch: "feature-branch" },
            { name: "other-feature", path: OTHER_WORKSPACE_PATH, branch: "other-feature" },
          ],
        });
        vi.mocked(appState.getAllProjects).mockResolvedValue([mockInternalProject]);
        vi.mocked(appState.getProject).mockReturnValue(mockInternalProject);
        vi.mocked(appState.getWorkspaceProvider).mockReturnValue(mockProvider);
        // The removed workspace is active
        vi.mocked(viewManager.getActiveWorkspacePath).mockReturnValue(TEST_WORKSPACE_PATH);

        const switchHandler = vi.fn();
        api.on("workspace:switched", switchHandler);

        await api.workspaces.remove(TEST_PROJECT_ID, TEST_WORKSPACE_NAME);

        // Should switch to the other workspace in the same project
        expect(viewManager.setActiveWorkspace).toHaveBeenCalledWith(OTHER_WORKSPACE_PATH, false);
        expect(switchHandler).toHaveBeenCalledWith({
          projectId: TEST_PROJECT_ID,
          workspaceName: OTHER_WORKSPACE_NAME,
          path: OTHER_WORKSPACE_PATH,
        });
      });

      it("should switch to workspace in another project when active workspace removed and no other in same project", async () => {
        const OTHER_PROJECT_PATH = "/home/user/projects/other-app" as ProjectPath;
        const OTHER_PROJECT_ID = "other-app-f959d361" as ProjectId;
        const OTHER_PROJECT_WORKSPACE_PATH =
          "/home/user/.codehydra/projects/other-app/workspaces/main-feature";
        const OTHER_PROJECT_WORKSPACE_NAME = "main-feature" as WorkspaceName;

        const mockProvider = {
          removeWorkspace: vi
            .fn()
            .mockResolvedValue({ workspaceRemoved: true, baseDeleted: false }),
        } as unknown as IWorkspaceProvider;
        const mockInternalProject = createInternalProject({
          workspaces: [
            { name: "feature-branch", path: TEST_WORKSPACE_PATH, branch: "feature-branch" },
          ],
        });
        const otherProject = {
          path: OTHER_PROJECT_PATH,
          name: "other-app",
          workspaces: [
            {
              name: "main-feature",
              path: OTHER_PROJECT_WORKSPACE_PATH,
              branch: "main-feature",
            },
          ],
        } as InternalProject;
        vi.mocked(appState.getAllProjects).mockResolvedValue([mockInternalProject, otherProject]);
        vi.mocked(appState.getProject).mockReturnValue(mockInternalProject);
        vi.mocked(appState.getWorkspaceProvider).mockReturnValue(mockProvider);
        // The removed workspace is active
        vi.mocked(viewManager.getActiveWorkspacePath).mockReturnValue(TEST_WORKSPACE_PATH);

        const switchHandler = vi.fn();
        api.on("workspace:switched", switchHandler);

        await api.workspaces.remove(TEST_PROJECT_ID, TEST_WORKSPACE_NAME);

        // Should switch to workspace in another project
        expect(viewManager.setActiveWorkspace).toHaveBeenCalledWith(
          OTHER_PROJECT_WORKSPACE_PATH,
          false
        );
        expect(switchHandler).toHaveBeenCalledWith({
          projectId: OTHER_PROJECT_ID,
          workspaceName: OTHER_PROJECT_WORKSPACE_NAME,
          path: OTHER_PROJECT_WORKSPACE_PATH,
        });
      });

      it("should set active to null when no workspaces remain after removal", async () => {
        const mockProvider = {
          removeWorkspace: vi
            .fn()
            .mockResolvedValue({ workspaceRemoved: true, baseDeleted: false }),
        } as unknown as IWorkspaceProvider;
        const mockInternalProject = createInternalProject({
          workspaces: [
            { name: "feature-branch", path: TEST_WORKSPACE_PATH, branch: "feature-branch" },
          ],
        });
        vi.mocked(appState.getAllProjects).mockResolvedValue([mockInternalProject]);
        vi.mocked(appState.getProject).mockReturnValue(mockInternalProject);
        vi.mocked(appState.getWorkspaceProvider).mockReturnValue(mockProvider);
        // The removed workspace is active
        vi.mocked(viewManager.getActiveWorkspacePath).mockReturnValue(TEST_WORKSPACE_PATH);

        const switchHandler = vi.fn();
        api.on("workspace:switched", switchHandler);

        await api.workspaces.remove(TEST_PROJECT_ID, TEST_WORKSPACE_NAME);

        // Should set active to null
        expect(viewManager.setActiveWorkspace).toHaveBeenCalledWith(null, false);
        expect(switchHandler).toHaveBeenCalledWith(null);
      });

      it("should not switch workspace when removed workspace was not active", async () => {
        const mockProvider = {
          removeWorkspace: vi
            .fn()
            .mockResolvedValue({ workspaceRemoved: true, baseDeleted: false }),
        } as unknown as IWorkspaceProvider;
        const mockInternalProject = createInternalProject({
          workspaces: [
            { name: "feature-branch", path: TEST_WORKSPACE_PATH, branch: "feature-branch" },
            { name: "other-feature", path: OTHER_WORKSPACE_PATH, branch: "other-feature" },
          ],
        });
        vi.mocked(appState.getAllProjects).mockResolvedValue([mockInternalProject]);
        vi.mocked(appState.getProject).mockReturnValue(mockInternalProject);
        vi.mocked(appState.getWorkspaceProvider).mockReturnValue(mockProvider);
        // A different workspace is active
        vi.mocked(viewManager.getActiveWorkspacePath).mockReturnValue(OTHER_WORKSPACE_PATH);

        const switchHandler = vi.fn();
        api.on("workspace:switched", switchHandler);

        await api.workspaces.remove(TEST_PROJECT_ID, TEST_WORKSPACE_NAME);

        // Should NOT switch - the active workspace is still valid
        expect(viewManager.setActiveWorkspace).not.toHaveBeenCalled();
        expect(switchHandler).not.toHaveBeenCalled();
      });
    });
  });

  describe("getStatus()", () => {
    it("should return isDirty from workspace provider", async () => {
      const mockProvider = {
        isDirty: vi.fn().mockResolvedValue(true),
      } as unknown as IWorkspaceProvider;
      const mockInternalProject = createInternalProject({
        workspaces: [
          { name: "feature-branch", path: TEST_WORKSPACE_PATH, branch: "feature-branch" },
        ],
      });
      vi.mocked(appState.getAllProjects).mockResolvedValue([mockInternalProject]);
      vi.mocked(appState.getProject).mockReturnValue(mockInternalProject);
      vi.mocked(appState.getWorkspaceProvider).mockReturnValue(mockProvider);

      const result = await api.workspaces.getStatus(TEST_PROJECT_ID, TEST_WORKSPACE_NAME);

      expect(result.isDirty).toBe(true);
    });

    it("should return agent status when available", async () => {
      const mockProvider = {
        isDirty: vi.fn().mockResolvedValue(false),
      } as unknown as IWorkspaceProvider;
      const mockAgentStatus: AggregatedAgentStatus = {
        status: "busy",
        counts: { idle: 0, busy: 1 },
      };
      const mockAgentStatusManager = {
        getStatus: vi.fn().mockReturnValue(mockAgentStatus),
      } as unknown as AgentStatusManager;
      const mockInternalProject = createInternalProject({
        workspaces: [
          { name: "feature-branch", path: TEST_WORKSPACE_PATH, branch: "feature-branch" },
        ],
      });
      vi.mocked(appState.getAllProjects).mockResolvedValue([mockInternalProject]);
      vi.mocked(appState.getProject).mockReturnValue(mockInternalProject);
      vi.mocked(appState.getWorkspaceProvider).mockReturnValue(mockProvider);
      vi.mocked(appState.getAgentStatusManager).mockReturnValue(mockAgentStatusManager);

      const result = await api.workspaces.getStatus(TEST_PROJECT_ID, TEST_WORKSPACE_NAME);

      expect(result.agent).toEqual({
        type: "busy",
        counts: { idle: 0, busy: 1, total: 1 },
      });
    });

    it("should return agent type none when no status manager", async () => {
      const mockProvider = {
        isDirty: vi.fn().mockResolvedValue(false),
      } as unknown as IWorkspaceProvider;
      const mockInternalProject = createInternalProject({
        workspaces: [
          { name: "feature-branch", path: TEST_WORKSPACE_PATH, branch: "feature-branch" },
        ],
      });
      vi.mocked(appState.getAllProjects).mockResolvedValue([mockInternalProject]);
      vi.mocked(appState.getProject).mockReturnValue(mockInternalProject);
      vi.mocked(appState.getWorkspaceProvider).mockReturnValue(mockProvider);
      vi.mocked(appState.getAgentStatusManager).mockReturnValue(null);

      const result = await api.workspaces.getStatus(TEST_PROJECT_ID, TEST_WORKSPACE_NAME);

      expect(result.agent).toEqual({ type: "none" });
    });
  });
});

// =============================================================================
// Tests: IUiApi
// =============================================================================

describe("CodeHydraApiImpl - IUiApi", () => {
  let appState: AppState;
  let viewManager: IViewManager;
  let dialog: typeof Electron.dialog;
  let app: typeof Electron.app;
  let api: CodeHydraApiImpl;

  beforeEach(() => {
    appState = createMockAppState();
    viewManager = createMockViewManager();
    dialog = createMockElectronDialog();
    app = createMockElectronApp();
    api = new CodeHydraApiImpl(appState, viewManager, dialog, app);
  });

  describe("selectFolder()", () => {
    it("should return selected folder path", async () => {
      vi.mocked(dialog.showOpenDialog).mockResolvedValue({
        canceled: false,
        filePaths: ["/home/user/selected-project"],
      });

      const result = await api.ui.selectFolder();

      expect(dialog.showOpenDialog).toHaveBeenCalledWith(
        expect.objectContaining({ properties: expect.arrayContaining(["openDirectory"]) })
      );
      expect(result).toBe("/home/user/selected-project");
    });

    it("should return null when dialog canceled", async () => {
      vi.mocked(dialog.showOpenDialog).mockResolvedValue({
        canceled: true,
        filePaths: [],
      });

      const result = await api.ui.selectFolder();

      expect(result).toBeNull();
    });
  });

  describe("getActiveWorkspace()", () => {
    it("should return active workspace ref when active", async () => {
      vi.mocked(viewManager.getActiveWorkspacePath).mockReturnValue(TEST_WORKSPACE_PATH);
      const mockInternalProject = createInternalProject({
        workspaces: [
          { name: "feature-branch", path: TEST_WORKSPACE_PATH, branch: "feature-branch" },
        ],
      });
      vi.mocked(appState.findProjectForWorkspace).mockReturnValue(mockInternalProject);

      const result = await api.ui.getActiveWorkspace();

      expect(result).toEqual({
        projectId: TEST_PROJECT_ID,
        workspaceName: TEST_WORKSPACE_NAME,
        path: TEST_WORKSPACE_PATH,
      });
    });

    it("should return null when no active workspace", async () => {
      vi.mocked(viewManager.getActiveWorkspacePath).mockReturnValue(null);

      const result = await api.ui.getActiveWorkspace();

      expect(result).toBeNull();
    });
  });

  describe("switchWorkspace()", () => {
    it("should switch to workspace", async () => {
      const mockInternalProject = createInternalProject({
        workspaces: [
          { name: "feature-branch", path: TEST_WORKSPACE_PATH, branch: "feature-branch" },
        ],
      });
      vi.mocked(appState.getAllProjects).mockResolvedValue([mockInternalProject]);
      vi.mocked(appState.getProject).mockReturnValue(mockInternalProject);

      await api.ui.switchWorkspace(TEST_PROJECT_ID, TEST_WORKSPACE_NAME);

      expect(viewManager.setActiveWorkspace).toHaveBeenCalledWith(TEST_WORKSPACE_PATH, true);
    });

    it("should emit workspace:switched event", async () => {
      const mockInternalProject = createInternalProject({
        workspaces: [
          { name: "feature-branch", path: TEST_WORKSPACE_PATH, branch: "feature-branch" },
        ],
      });
      vi.mocked(appState.getAllProjects).mockResolvedValue([mockInternalProject]);
      vi.mocked(appState.getProject).mockReturnValue(mockInternalProject);
      const handler = vi.fn();
      api.on("workspace:switched", handler);

      await api.ui.switchWorkspace(TEST_PROJECT_ID, TEST_WORKSPACE_NAME);

      expect(handler).toHaveBeenCalledWith({
        projectId: TEST_PROJECT_ID,
        workspaceName: TEST_WORKSPACE_NAME,
        path: TEST_WORKSPACE_PATH,
      });
    });

    it("should not focus when focus=false", async () => {
      const mockInternalProject = createInternalProject({
        workspaces: [
          { name: "feature-branch", path: TEST_WORKSPACE_PATH, branch: "feature-branch" },
        ],
      });
      vi.mocked(appState.getAllProjects).mockResolvedValue([mockInternalProject]);
      vi.mocked(appState.getProject).mockReturnValue(mockInternalProject);

      await api.ui.switchWorkspace(TEST_PROJECT_ID, TEST_WORKSPACE_NAME, false);

      expect(viewManager.setActiveWorkspace).toHaveBeenCalledWith(TEST_WORKSPACE_PATH, false);
    });

    it("should throw if workspace not found", async () => {
      const mockInternalProject = createInternalProject();
      vi.mocked(appState.getAllProjects).mockResolvedValue([mockInternalProject]);
      vi.mocked(appState.getProject).mockReturnValue(mockInternalProject);

      await expect(
        api.ui.switchWorkspace(TEST_PROJECT_ID, "nonexistent" as WorkspaceName)
      ).rejects.toThrow(/not found/i);
    });
  });

  describe("setDialogMode()", () => {
    it("should set dialog mode", async () => {
      await api.ui.setDialogMode(true);

      expect(viewManager.setDialogMode).toHaveBeenCalledWith(true);
    });

    it("should clear dialog mode", async () => {
      await api.ui.setDialogMode(false);

      expect(viewManager.setDialogMode).toHaveBeenCalledWith(false);
    });
  });

  describe("focusActiveWorkspace()", () => {
    it("should focus active workspace", async () => {
      await api.ui.focusActiveWorkspace();

      expect(viewManager.focusActiveWorkspace).toHaveBeenCalled();
    });
  });
});

// =============================================================================
// Tests: ILifecycleApi
// =============================================================================

describe("CodeHydraApiImpl - ILifecycleApi", () => {
  let appState: AppState;
  let viewManager: IViewManager;
  let dialog: typeof Electron.dialog;
  let app: typeof Electron.app;
  let vscodeSetup: IVscodeSetup;
  let api: CodeHydraApiImpl;

  beforeEach(() => {
    appState = createMockAppState();
    viewManager = createMockViewManager();
    dialog = createMockElectronDialog();
    app = createMockElectronApp();
    vscodeSetup = {
      isSetupComplete: vi.fn().mockResolvedValue(true),
      setup: vi.fn().mockResolvedValue({ success: true }),
      cleanVscodeDir: vi.fn(),
    } as unknown as IVscodeSetup;
    api = new CodeHydraApiImpl(appState, viewManager, dialog, app, vscodeSetup);
  });

  describe("getState()", () => {
    it("should return 'ready' when setup is complete", async () => {
      vi.mocked(vscodeSetup.isSetupComplete).mockResolvedValue(true);

      const result = await api.lifecycle.getState();

      expect(result).toBe("ready");
    });

    it("should return 'setup' when setup is not complete", async () => {
      vi.mocked(vscodeSetup.isSetupComplete).mockResolvedValue(false);

      const result = await api.lifecycle.getState();

      expect(result).toBe("setup");
    });
  });

  describe("setup()", () => {
    it("should return success result when setup succeeds", async () => {
      vi.mocked(vscodeSetup.setup).mockResolvedValue({ success: true });

      const result = await api.lifecycle.setup();

      expect(result).toEqual({ success: true });
    });

    it("should return failure result when setup fails", async () => {
      vi.mocked(vscodeSetup.setup).mockResolvedValue({
        success: false,
        error: {
          type: "unknown",
          message: "Extension installation failed",
          code: "EXTENSION_INSTALL_FAILED",
        },
      });

      const result = await api.lifecycle.setup();

      expect(result).toEqual({
        success: false,
        message: "Extension installation failed",
        code: "EXTENSION_INSTALL_FAILED",
      });
    });

    it("should emit setup:progress events", async () => {
      // Simulate progress callbacks using service types (config → settings mapping)
      vi.mocked(vscodeSetup.setup).mockImplementation(async (onProgress) => {
        // Service uses "config" step, API translates to "settings"
        onProgress?.({ step: "extensions", message: "Installing extensions..." });
        onProgress?.({ step: "config", message: "Writing settings..." });
        return { success: true };
      });
      const handler = vi.fn();
      api.on("setup:progress", handler);

      await api.lifecycle.setup();

      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler).toHaveBeenNthCalledWith(1, {
        step: "extensions",
        message: "Installing extensions...",
      });
      // "config" from service is mapped to "settings" in API
      expect(handler).toHaveBeenNthCalledWith(2, {
        step: "settings",
        message: "Writing settings...",
      });
    });
  });

  describe("quit()", () => {
    it("should call app.quit()", async () => {
      await api.lifecycle.quit();

      expect(app.quit).toHaveBeenCalled();
    });
  });
});
