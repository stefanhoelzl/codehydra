/**
 * Integration tests for CodeHydraApiImpl.
 *
 * These tests verify that the API implementation methods integrate correctly
 * with each other and properly coordinate events and state changes.
 *
 * Note: These tests mock external systems (Git, Electron, services) but
 * test the integration between API methods and event emission.
 *
 * Tests cover:
 * - Project lifecycle: Open → create workspace → close
 * - Event coordination (events fired in correct order)
 * - Error handling across API boundaries
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CodeHydraApiImpl } from "./codehydra-api";
import type { AppState } from "../app-state";
import type { IViewManager } from "../managers/view-manager.interface";
import type { ProjectId, WorkspaceName } from "../../shared/api/types";
import type { Project as InternalProject, ProjectPath, BaseInfo } from "../../shared/ipc";
import type { IVscodeSetup } from "../../services/vscode-setup/types";
import type { IWorkspaceProvider } from "../../services/git/workspace-provider";
import type { Workspace as InternalWorkspace } from "../../services/git/types";

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

function createMockViewManager(): IViewManager {
  return {
    getUIView: vi.fn(),
    createWorkspaceView: vi.fn(),
    destroyWorkspaceView: vi.fn(),
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

function createMockVscodeSetup(): IVscodeSetup {
  return {
    isSetupComplete: vi.fn().mockResolvedValue(true),
    setup: vi.fn().mockResolvedValue({ success: true }),
    cleanVscodeDir: vi.fn(),
  } as unknown as IVscodeSetup;
}

function createInternalProject(
  path: string,
  workspaces: InternalWorkspace[] = []
): InternalProject {
  return {
    path: path as ProjectPath,
    name: path.split("/").pop() || "project",
    workspaces,
  };
}

// =============================================================================
// Integration Tests
// =============================================================================

describe("CodeHydraApiImpl Integration", () => {
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
    vscodeSetup = createMockVscodeSetup();

    api = new CodeHydraApiImpl(appState, viewManager, dialog, app, vscodeSetup);
  });

  afterEach(() => {
    api.dispose();
    vi.clearAllMocks();
  });

  describe("Project lifecycle (open → list → close)", () => {
    const projectPath = "/home/user/my-project";
    const internalProject = createInternalProject(projectPath);

    it("should emit events in correct order", async () => {
      // Setup mocks
      vi.mocked(appState.openProject).mockResolvedValue(internalProject);
      vi.mocked(appState.getAllProjects).mockResolvedValue([internalProject]);

      const events: string[] = [];
      api.on("project:opened", () => events.push("opened"));
      api.on("project:closed", () => events.push("closed"));

      // Open
      const project = await api.projects.open(projectPath);
      expect(events).toContain("opened");

      // Close
      await api.projects.close(project.id);
      expect(events).toEqual(["opened", "closed"]);
    });

    it("should return same ID for same project path", async () => {
      vi.mocked(appState.openProject).mockResolvedValue(internalProject);
      vi.mocked(appState.getAllProjects).mockResolvedValue([internalProject]);

      const project1 = await api.projects.open(projectPath);
      const project2 = await api.projects.open(projectPath);

      expect(project1.id).toBe(project2.id);
    });

    it("should list projects after opening", async () => {
      vi.mocked(appState.openProject).mockResolvedValue(internalProject);
      vi.mocked(appState.getAllProjects).mockResolvedValue([internalProject]);

      await api.projects.open(projectPath);
      const projects = await api.projects.list();

      expect(projects).toHaveLength(1);
      expect(projects[0]?.name).toBe("my-project");
    });
  });

  describe("Workspace lifecycle (create → status → remove)", () => {
    const projectPath = "/home/user/my-project";
    const workspacePath = "/home/user/.worktrees/feature";

    it("should coordinate workspace creation events with state", async () => {
      const internalProject = createInternalProject(projectPath);
      const createdWorkspace: InternalWorkspace = {
        name: "feature",
        path: workspacePath,
        branch: "feature",
        metadata: { base: "main" },
      };

      vi.mocked(appState.openProject).mockResolvedValue(internalProject);
      vi.mocked(appState.getAllProjects).mockResolvedValue([internalProject]);
      vi.mocked(appState.getWorkspaceProvider).mockReturnValue({
        createWorkspace: vi.fn().mockResolvedValue(createdWorkspace),
      } as unknown as IWorkspaceProvider);

      // Open project
      const project = await api.projects.open(projectPath);

      // Track events
      const createdEvent = vi.fn();
      api.on("workspace:created", createdEvent);

      // Create workspace
      const workspace = await api.workspaces.create(project.id, "feature", "main");

      // Verify event contains correct data
      expect(createdEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: project.id,
          workspace: expect.objectContaining({
            name: "feature",
            path: workspacePath,
          }),
        })
      );

      // Verify workspace includes projectId
      expect(workspace.projectId).toBe(project.id);
    });

    it("should coordinate workspace removal events", async () => {
      const workspaceObj: InternalWorkspace = {
        name: "feature",
        path: workspacePath,
        branch: "feature",
        metadata: { base: "main" },
      };
      const internalProject = createInternalProject(projectPath, [workspaceObj]);

      vi.mocked(appState.openProject).mockResolvedValue(internalProject);
      vi.mocked(appState.getAllProjects).mockResolvedValue([internalProject]);
      vi.mocked(appState.getProject).mockReturnValue(internalProject);
      vi.mocked(appState.getWorkspaceProvider).mockReturnValue({
        removeWorkspace: vi.fn().mockResolvedValue({ workspaceRemoved: true, baseDeleted: false }),
      } as unknown as IWorkspaceProvider);

      const project = await api.projects.open(projectPath);

      // Track events
      const removedEvent = vi.fn();
      api.on("workspace:removed", removedEvent);

      // Remove workspace (fire-and-forget, runs async)
      await api.workspaces.remove(project.id, "feature" as WorkspaceName);

      // Wait for async deletion to complete
      await vi.waitFor(() => {
        expect(removedEvent).toHaveBeenCalledTimes(1);
      });

      // Verify event contains correct WorkspaceRef
      expect(removedEvent).toHaveBeenCalledWith({
        projectId: project.id,
        workspaceName: "feature",
        path: workspacePath,
      });
    });
  });

  describe("fetchBases background update flow", () => {
    const projectPath = "/home/user/my-project";

    it("should return cached bases and emit event when background fetch completes", async () => {
      const cachedBases: BaseInfo[] = [{ name: "main", isRemote: false }];
      const updatedBases: BaseInfo[] = [
        { name: "main", isRemote: false },
        { name: "origin/develop", isRemote: true },
      ];

      let fetchCompleted = false;

      const mockProvider = {
        listBases: vi.fn().mockImplementation(() => {
          return Promise.resolve(fetchCompleted ? updatedBases : cachedBases);
        }),
        updateBases: vi.fn().mockImplementation(async () => {
          fetchCompleted = true;
          return { fetchedRemotes: ["origin"], failedRemotes: [] };
        }),
      } as unknown as IWorkspaceProvider;

      const internalProject = createInternalProject(projectPath);
      vi.mocked(appState.openProject).mockResolvedValue(internalProject);
      vi.mocked(appState.getAllProjects).mockResolvedValue([internalProject]);
      vi.mocked(appState.getWorkspaceProvider).mockReturnValue(mockProvider);

      const project = await api.projects.open(projectPath);

      // Track bases-updated event
      const basesUpdatedEvent = vi.fn();
      api.on("project:bases-updated", basesUpdatedEvent);

      // Fetch bases (returns cached immediately)
      const result = await api.projects.fetchBases(project.id);
      expect(result.bases).toEqual(cachedBases);

      // Wait for background fetch
      await vi.waitFor(() => expect(basesUpdatedEvent).toHaveBeenCalled());

      // Verify event contains updated bases
      expect(basesUpdatedEvent).toHaveBeenCalledWith({
        projectId: project.id,
        bases: updatedBases,
      });
    });
  });

  describe("Error handling across API boundaries", () => {
    it("should propagate service errors for project operations", async () => {
      const error = new Error("Not a git repository");
      vi.mocked(appState.openProject).mockRejectedValue(error);

      await expect(api.projects.open("/invalid/path")).rejects.toThrow("Not a git repository");
    });

    it("should return not-found style error for invalid project ID", async () => {
      vi.mocked(appState.getAllProjects).mockResolvedValue([]);

      await expect(api.projects.close("invalid-00000000" as ProjectId)).rejects.toThrow(
        /not found/i
      );
    });

    it("should return not-found style error for invalid workspace", async () => {
      const internalProject = createInternalProject("/test/project", []);
      vi.mocked(appState.getAllProjects).mockResolvedValue([internalProject]);
      vi.mocked(appState.getProject).mockReturnValue(internalProject);

      // Get project ID
      const projectId = (await api.projects.list())[0]!.id;

      await expect(
        api.workspaces.remove(projectId, "nonexistent" as WorkspaceName)
      ).rejects.toThrow(/not found/i);
    });
  });

  describe("Event isolation", () => {
    it("should not break other handlers if one throws", async () => {
      const errorHandler = vi.fn().mockImplementation(() => {
        throw new Error("Handler error");
      });
      const normalHandler = vi.fn();

      api.on("project:opened", errorHandler);
      api.on("project:opened", normalHandler);

      const internalProject = createInternalProject("/test/project");
      vi.mocked(appState.openProject).mockResolvedValue(internalProject);

      // Should not throw even though one handler errors
      await expect(api.projects.open("/test/project")).resolves.toBeDefined();

      // Both handlers should have been called
      expect(errorHandler).toHaveBeenCalled();
      expect(normalHandler).toHaveBeenCalled();
    });
  });
});
