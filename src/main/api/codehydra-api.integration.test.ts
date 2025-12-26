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
import * as nodePath from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CodeHydraApiImpl } from "./codehydra-api";
import { generateProjectId } from "./id-utils";
import type { AppState } from "../app-state";
import type { IViewManager } from "../managers/view-manager.interface";
import type {
  ProjectId,
  WorkspaceName,
  DeletionProgress,
  DeletionOperationId,
} from "../../shared/api/types";
import type { DeletionProgressCallback, KillTerminalsCallback } from "./codehydra-api";
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
    getServerManager: vi.fn().mockReturnValue({
      stopServer: vi.fn().mockResolvedValue({ success: true }),
    }),
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
    name: nodePath.basename(path) || "project",
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
      // Logging is an implementation detail - we just verify both handlers were called
    });
  });

  describe("Workspace deletion with stop-server operation", () => {
    const projectPath = "/home/user/my-project";
    const workspacePath = "/home/user/.worktrees/feature";

    /**
     * Helper to create a CodeHydraApiImpl with custom callbacks for deletion testing.
     */
    function createApiWithCallbacksAndServerManager(
      appStateOverride: AppState,
      viewManagerOverride: IViewManager,
      emitDeletionProgress: DeletionProgressCallback,
      killTerminalsCallback?: KillTerminalsCallback,
      stopServerCallback?: (workspacePath: string) => Promise<{ success: boolean; error?: string }>
    ): CodeHydraApiImpl {
      // If stopServerCallback provided, add it to appState mock
      if (stopServerCallback) {
        const serverManager = {
          stopServer: stopServerCallback,
          getPort: vi.fn().mockReturnValue(null),
        };
        vi.mocked(appStateOverride.getServerManager).mockReturnValue(serverManager as never);
      }

      return new CodeHydraApiImpl(
        appStateOverride,
        viewManagerOverride,
        createMockElectronDialog(),
        createMockElectronApp(),
        createMockVscodeSetup(),
        undefined, // existingLifecycleApi
        emitDeletionProgress,
        killTerminalsCallback
      );
    }

    it("deletion includes stop-server operation in progress events", async () => {
      // Setup workspace in project
      const workspaceObj: InternalWorkspace = {
        name: "feature",
        path: workspacePath,
        branch: "feature",
        metadata: { base: "main" },
      };
      const internalProject = createInternalProject(projectPath, [workspaceObj]);

      // Track all progress events
      const progressEvents: DeletionProgress[] = [];
      const emitDeletionProgress = vi.fn((progress: DeletionProgress) => {
        progressEvents.push(JSON.parse(JSON.stringify(progress)));
      });

      // Setup AppState mock
      const localAppState = createMockAppState({
        getProject: vi.fn().mockReturnValue(internalProject),
        getAllProjects: vi.fn().mockResolvedValue([internalProject]),
        getWorkspaceProvider: vi.fn().mockReturnValue({
          removeWorkspace: vi.fn().mockResolvedValue({ workspaceRemoved: true }),
        }),
        removeWorkspace: vi.fn().mockResolvedValue(undefined),
        getServerManager: vi.fn().mockReturnValue({
          stopServer: vi.fn().mockResolvedValue({ success: true }),
          getPort: vi.fn().mockReturnValue(null),
        }),
      });

      // Setup ViewManager mock
      const localViewManager = createMockViewManager();
      vi.mocked(localViewManager.destroyWorkspaceView).mockResolvedValue(undefined);

      // Create API
      const localApi = createApiWithCallbacksAndServerManager(
        localAppState,
        localViewManager,
        emitDeletionProgress
      );

      const projectId = generateProjectId(projectPath);

      try {
        await localApi.workspaces.remove(projectId, "feature" as WorkspaceName, true);

        // Wait for async deletion to complete
        await vi.waitFor(() => {
          const lastProgress = progressEvents[progressEvents.length - 1];
          expect(lastProgress?.completed).toBe(true);
        });

        // Verify stop-server operation is in the operations list
        const finalProgress = progressEvents[progressEvents.length - 1]!;
        const operationIds = finalProgress.operations.map((op) => op.id as string);
        expect(operationIds).toContain("stop-server");
      } finally {
        localApi.dispose();
      }
    });

    it("marks stop-server as error when kill fails", async () => {
      // Setup workspace in project
      const workspaceObj: InternalWorkspace = {
        name: "feature",
        path: workspacePath,
        branch: "feature",
        metadata: { base: "main" },
      };
      const internalProject = createInternalProject(projectPath, [workspaceObj]);

      // Track all progress events
      const progressEvents: DeletionProgress[] = [];
      const emitDeletionProgress = vi.fn((progress: DeletionProgress) => {
        progressEvents.push(JSON.parse(JSON.stringify(progress)));
      });

      // Setup AppState mock with failing stopServer
      const localAppState = createMockAppState({
        getProject: vi.fn().mockReturnValue(internalProject),
        getAllProjects: vi.fn().mockResolvedValue([internalProject]),
        getWorkspaceProvider: vi.fn().mockReturnValue({
          removeWorkspace: vi.fn().mockResolvedValue({ workspaceRemoved: true }),
        }),
        removeWorkspace: vi.fn().mockResolvedValue(undefined),
        getServerManager: vi.fn().mockReturnValue({
          stopServer: vi
            .fn()
            .mockResolvedValue({ success: false, error: "Process did not terminate" }),
          getPort: vi.fn().mockReturnValue(14001),
        }),
      });

      // Setup ViewManager mock
      const localViewManager = createMockViewManager();
      vi.mocked(localViewManager.destroyWorkspaceView).mockResolvedValue(undefined);

      // Create API
      const localApi = createApiWithCallbacksAndServerManager(
        localAppState,
        localViewManager,
        emitDeletionProgress
      );

      const projectId = generateProjectId(projectPath);

      try {
        await localApi.workspaces.remove(projectId, "feature" as WorkspaceName, true);

        // Wait for async deletion to complete
        await vi.waitFor(() => {
          const lastProgress = progressEvents[progressEvents.length - 1];
          expect(lastProgress?.completed).toBe(true);
        });

        // Verify stop-server operation is marked as error
        const finalProgress = progressEvents[progressEvents.length - 1]!;
        const stopServerOp = finalProgress.operations.find(
          (op) => (op.id as string) === "stop-server"
        );
        expect(stopServerOp?.status).toBe("error");
        expect(stopServerOp?.error).toBeDefined();
        expect(finalProgress.hasErrors).toBe(true);
      } finally {
        localApi.dispose();
      }
    });
  });

  describe("Workspace deletion with kill terminals", () => {
    const projectPath = "/home/user/my-project";
    const workspacePath = "/home/user/.worktrees/feature";

    /**
     * Helper to create a CodeHydraApiImpl with custom callbacks for deletion testing.
     */
    function createApiWithCallbacks(
      appStateOverride: AppState,
      viewManagerOverride: IViewManager,
      emitDeletionProgress: DeletionProgressCallback,
      killTerminalsCallback?: KillTerminalsCallback
    ): CodeHydraApiImpl {
      return new CodeHydraApiImpl(
        appStateOverride,
        viewManagerOverride,
        createMockElectronDialog(),
        createMockElectronApp(),
        createMockVscodeSetup(),
        undefined, // existingLifecycleApi
        emitDeletionProgress,
        killTerminalsCallback
      );
    }

    it("deletion-full-flow-with-kill-terminals: should execute 4 operations in sequence with all progress events", async () => {
      // Setup workspace in project
      const workspaceObj: InternalWorkspace = {
        name: "feature",
        path: workspacePath,
        branch: "feature",
        metadata: { base: "main" },
      };
      const internalProject = createInternalProject(projectPath, [workspaceObj]);

      // Track all progress events
      const progressEvents: DeletionProgress[] = [];
      const emitDeletionProgress = vi.fn((progress: DeletionProgress) => {
        progressEvents.push(JSON.parse(JSON.stringify(progress))); // Deep copy
      });

      // Track when killTerminalsCallback is called
      const killTerminalsCalls: string[] = [];
      const killTerminalsCallback = vi.fn(async (path: string) => {
        killTerminalsCalls.push(path);
      });

      // Setup AppState mock
      const localAppState = createMockAppState({
        getProject: vi.fn().mockReturnValue(internalProject),
        getAllProjects: vi.fn().mockResolvedValue([internalProject]),
        getWorkspaceProvider: vi.fn().mockReturnValue({
          removeWorkspace: vi.fn().mockResolvedValue({ workspaceRemoved: true }),
        }),
        removeWorkspace: vi.fn().mockResolvedValue(undefined),
      });

      // Setup ViewManager mock
      const localViewManager = createMockViewManager();
      vi.mocked(localViewManager.destroyWorkspaceView).mockResolvedValue(undefined);

      // Create API with callbacks
      const localApi = createApiWithCallbacks(
        localAppState,
        localViewManager,
        emitDeletionProgress,
        killTerminalsCallback
      );

      // Generate the actual project ID from the path
      const projectId = generateProjectId(projectPath);

      try {
        // Start deletion
        const result = await localApi.workspaces.remove(
          projectId,
          "feature" as WorkspaceName,
          true // keepBranch
        );

        expect(result).toEqual({ started: true });

        // Wait for async deletion to complete
        await vi.waitFor(() => {
          const lastProgress = progressEvents[progressEvents.length - 1];
          expect(lastProgress?.completed).toBe(true);
        });

        // Verify killTerminalsCallback was called with correct path
        expect(killTerminalsCallback).toHaveBeenCalledWith(workspacePath);
        expect(killTerminalsCalls).toEqual([workspacePath]);

        // Verify all 4 operations in correct order
        expect(progressEvents.length).toBeGreaterThanOrEqual(7); // At least: initial, kill-in-progress, kill-done, stop-server-in-progress, stop-server-done, vscode-in-progress, vscode-done, workspace-in-progress, workspace-done, final

        // Verify operation sequence through progress events
        // Find the first progress event for each operation in-progress state
        const killInProgress = progressEvents.find(
          (p) => p.operations.find((op) => op.id === "kill-terminals")?.status === "in-progress"
        );
        const stopServerInProgress = progressEvents.find(
          (p) => p.operations.find((op) => op.id === "stop-server")?.status === "in-progress"
        );
        const vscodeInProgress = progressEvents.find(
          (p) => p.operations.find((op) => op.id === "cleanup-vscode")?.status === "in-progress"
        );
        const workspaceInProgress = progressEvents.find(
          (p) => p.operations.find((op) => op.id === "cleanup-workspace")?.status === "in-progress"
        );

        expect(killInProgress).toBeDefined();
        expect(stopServerInProgress).toBeDefined();
        expect(vscodeInProgress).toBeDefined();
        expect(workspaceInProgress).toBeDefined();

        // Verify operation order: when stop-server is in-progress, kill-terminals should be done
        const stopServerInProgressOps = stopServerInProgress!.operations;
        expect(stopServerInProgressOps.find((op) => op.id === "kill-terminals")?.status).toBe(
          "done"
        );

        // Verify operation order: when cleanup-vscode is in-progress, kill-terminals and stop-server should be done
        const vscodeInProgressOps = vscodeInProgress!.operations;
        expect(vscodeInProgressOps.find((op) => op.id === "kill-terminals")?.status).toBe("done");
        expect(vscodeInProgressOps.find((op) => op.id === "stop-server")?.status).toBe("done");

        // Verify operation order: when cleanup-workspace is in-progress, all previous should be done
        const workspaceInProgressOps = workspaceInProgress!.operations;
        expect(workspaceInProgressOps.find((op) => op.id === "kill-terminals")?.status).toBe(
          "done"
        );
        expect(workspaceInProgressOps.find((op) => op.id === "stop-server")?.status).toBe("done");
        expect(workspaceInProgressOps.find((op) => op.id === "cleanup-vscode")?.status).toBe(
          "done"
        );

        // Verify final state
        const finalProgress = progressEvents[progressEvents.length - 1]!;
        expect(finalProgress.completed).toBe(true);
        expect(finalProgress.hasErrors).toBe(false);
        expect(finalProgress.operations).toHaveLength(4);
        expect(finalProgress.operations.map((op) => op.id)).toEqual([
          "kill-terminals",
          "stop-server",
          "cleanup-vscode",
          "cleanup-workspace",
        ] as DeletionOperationId[]);
        finalProgress.operations.forEach((op) => {
          expect(op.status).toBe("done");
        });
      } finally {
        localApi.dispose();
      }
    });

    it("workspace deletion calls shutdown callback during deletion", async () => {
      // This test verifies that the killTerminalsCallback (which includes shutdown)
      // is called during the workspace deletion flow
      const workspaceObj: InternalWorkspace = {
        name: "feature",
        path: workspacePath,
        branch: "feature",
        metadata: { base: "main" },
      };
      const internalProject = createInternalProject(projectPath, [workspaceObj]);

      // Track when the callback is called
      let callbackCalledAt: number | null = null;
      let callbackWorkspacePath: string | null = null;
      const shutdownCallback = vi.fn(async (path: string) => {
        callbackCalledAt = Date.now();
        callbackWorkspacePath = path;
      });

      // Track progress events
      const progressEvents: DeletionProgress[] = [];
      const emitDeletionProgress = vi.fn((progress: DeletionProgress) => {
        progressEvents.push(JSON.parse(JSON.stringify(progress)));
      });

      // Setup mocks
      const localAppState = createMockAppState({
        getProject: vi.fn().mockReturnValue(internalProject),
        getAllProjects: vi.fn().mockResolvedValue([internalProject]),
        getWorkspaceProvider: vi.fn().mockReturnValue({
          removeWorkspace: vi.fn().mockResolvedValue({ workspaceRemoved: true }),
        }),
        removeWorkspace: vi.fn().mockResolvedValue(undefined),
      });
      const localViewManager = createMockViewManager();
      vi.mocked(localViewManager.destroyWorkspaceView).mockResolvedValue(undefined);

      const localApi = createApiWithCallbacks(
        localAppState,
        localViewManager,
        emitDeletionProgress,
        shutdownCallback
      );

      const projectId = generateProjectId(projectPath);

      try {
        // Start deletion
        await localApi.workspaces.remove(projectId, "feature" as WorkspaceName);

        // Wait for completion
        await vi.waitFor(() => {
          const lastProgress = progressEvents[progressEvents.length - 1];
          expect(lastProgress?.completed).toBe(true);
        });

        // Verify callback was called with correct workspace path
        expect(shutdownCallback).toHaveBeenCalledTimes(1);
        expect(callbackWorkspacePath).toBe(workspacePath);
        expect(callbackCalledAt).not.toBeNull();
      } finally {
        localApi.dispose();
      }
    });

    it("workspace deletion flow ordering: kill-terminals before cleanup-vscode", async () => {
      // This test verifies the ordering: kill-terminals → cleanup-vscode → cleanup-workspace
      const workspaceObj: InternalWorkspace = {
        name: "feature",
        path: workspacePath,
        branch: "feature",
        metadata: { base: "main" },
      };
      const internalProject = createInternalProject(projectPath, [workspaceObj]);

      // Track the order of operations
      const operationOrder: string[] = [];

      // Callback that records when it starts
      const killTerminalsCallback = vi.fn(async () => {
        operationOrder.push("kill-terminals");
      });

      // Mock ViewManager that records when destroyWorkspaceView is called
      const localViewManager = createMockViewManager();
      vi.mocked(localViewManager.destroyWorkspaceView).mockImplementation(async () => {
        operationOrder.push("cleanup-vscode");
      });

      // Mock provider that records when removeWorkspace is called
      const mockProvider = {
        removeWorkspace: vi.fn().mockImplementation(async () => {
          operationOrder.push("cleanup-workspace");
          return { workspaceRemoved: true };
        }),
      };

      const localAppState = createMockAppState({
        getProject: vi.fn().mockReturnValue(internalProject),
        getAllProjects: vi.fn().mockResolvedValue([internalProject]),
        getWorkspaceProvider: vi.fn().mockReturnValue(mockProvider),
        removeWorkspace: vi.fn().mockResolvedValue(undefined),
      });

      const progressEvents: DeletionProgress[] = [];
      const emitDeletionProgress = vi.fn((progress: DeletionProgress) => {
        progressEvents.push(JSON.parse(JSON.stringify(progress)));
      });

      const localApi = createApiWithCallbacks(
        localAppState,
        localViewManager,
        emitDeletionProgress,
        killTerminalsCallback
      );

      const projectId = generateProjectId(projectPath);

      try {
        await localApi.workspaces.remove(projectId, "feature" as WorkspaceName);

        // Wait for completion
        await vi.waitFor(() => {
          const lastProgress = progressEvents[progressEvents.length - 1];
          expect(lastProgress?.completed).toBe(true);
        });

        // Verify the exact ordering of operations
        expect(operationOrder).toEqual(["kill-terminals", "cleanup-vscode", "cleanup-workspace"]);
      } finally {
        localApi.dispose();
      }
    });

    it("deletion-concurrent-attempt: should return started:true without starting new deletion", async () => {
      // Setup workspace in project
      const workspaceObj: InternalWorkspace = {
        name: "feature",
        path: workspacePath,
        branch: "feature",
        metadata: { base: "main" },
      };
      const internalProject = createInternalProject(projectPath, [workspaceObj]);

      // Track progress events
      const progressEvents: DeletionProgress[] = [];
      const emitDeletionProgress = vi.fn((progress: DeletionProgress) => {
        progressEvents.push(JSON.parse(JSON.stringify(progress)));
      });

      // Create a slow killTerminalsCallback that we can control
      let resolveKillTerminals: () => void;
      const killTerminalsPromise = new Promise<void>((resolve) => {
        resolveKillTerminals = resolve;
      });
      let killTerminalsCallCount = 0;
      const killTerminalsCallback = vi.fn(async () => {
        killTerminalsCallCount++;
        await killTerminalsPromise;
      });

      // Setup AppState mock
      const localAppState = createMockAppState({
        getProject: vi.fn().mockReturnValue(internalProject),
        getAllProjects: vi.fn().mockResolvedValue([internalProject]),
        getWorkspaceProvider: vi.fn().mockReturnValue({
          removeWorkspace: vi.fn().mockResolvedValue({ workspaceRemoved: true }),
        }),
        removeWorkspace: vi.fn().mockResolvedValue(undefined),
      });

      // Setup ViewManager mock
      const localViewManager = createMockViewManager();
      vi.mocked(localViewManager.destroyWorkspaceView).mockResolvedValue(undefined);

      // Create API with callbacks
      const localApi = createApiWithCallbacks(
        localAppState,
        localViewManager,
        emitDeletionProgress,
        killTerminalsCallback
      );

      // Generate the actual project ID from the path
      const projectId = generateProjectId(projectPath);

      try {
        // Start first deletion - this will be slow because of killTerminalsCallback
        const result1 = await localApi.workspaces.remove(projectId, "feature" as WorkspaceName);
        expect(result1).toEqual({ started: true });

        // Wait for kill-terminals to be in-progress
        await vi.waitFor(() => {
          const hasKillInProgress = progressEvents.some(
            (p) => p.operations.find((op) => op.id === "kill-terminals")?.status === "in-progress"
          );
          expect(hasKillInProgress).toBe(true);
        });

        // Try to delete the same workspace again while first is still running
        const result2 = await localApi.workspaces.remove(projectId, "feature" as WorkspaceName);

        // Should return started: true (idempotent)
        expect(result2).toEqual({ started: true });

        // Verify killTerminalsCallback was only called ONCE (not twice)
        expect(killTerminalsCallCount).toBe(1);

        // Now let the deletion complete
        resolveKillTerminals!();

        // Wait for completion
        await vi.waitFor(() => {
          const lastProgress = progressEvents[progressEvents.length - 1];
          expect(lastProgress?.completed).toBe(true);
        });

        // Verify still only one call to killTerminalsCallback
        expect(killTerminalsCallback).toHaveBeenCalledTimes(1);
      } finally {
        localApi.dispose();
      }
    });
  });
});
