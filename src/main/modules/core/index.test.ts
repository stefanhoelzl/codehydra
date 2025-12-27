/**
 * Unit tests for CoreModule.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { CoreModule, type CoreModuleDeps } from "./index";
import { createMockRegistry } from "../../api/registry.test-utils";
import type { MockApiRegistry } from "../../api/registry.test-utils";
import type { AppState } from "../../app-state";
import type { IViewManager } from "../../managers/view-manager.interface";
import { createMockLogger } from "../../../services/logging";
import { generateProjectId } from "../../api/id-utils";

// =============================================================================
// Test Constants
// =============================================================================

const TEST_PROJECT_PATH = "/test/project";
const TEST_PROJECT_ID = generateProjectId(TEST_PROJECT_PATH);

// =============================================================================
// Mock Factories
// =============================================================================

function createMockAppState(overrides: Partial<AppState> = {}): AppState {
  return {
    openProject: vi.fn().mockResolvedValue({
      path: "/test/project",
      name: "test-project",
      workspaces: [],
    }),
    closeProject: vi.fn().mockResolvedValue(undefined),
    getProject: vi.fn(),
    getAllProjects: vi.fn().mockResolvedValue([]),
    getWorkspaceProvider: vi.fn().mockReturnValue({
      createWorkspace: vi.fn().mockResolvedValue({
        path: "/test/project/workspaces/feature",
        branch: "feature",
        metadata: { base: "main" },
      }),
      removeWorkspace: vi.fn().mockResolvedValue(undefined),
      listBases: vi.fn().mockResolvedValue([]),
      updateBases: vi.fn().mockResolvedValue(undefined),
      isDirty: vi.fn().mockResolvedValue(false),
      setMetadata: vi.fn().mockResolvedValue(undefined),
      getMetadata: vi.fn().mockResolvedValue({ base: "main" }),
    }),
    findProjectForWorkspace: vi.fn(),
    addWorkspace: vi.fn(),
    removeWorkspace: vi.fn().mockResolvedValue(undefined),
    getWorkspaceUrl: vi.fn(),
    getDefaultBaseBranch: vi.fn().mockResolvedValue("main"),
    setLastBaseBranch: vi.fn(),
    loadPersistedProjects: vi.fn(),
    setDiscoveryService: vi.fn(),
    getDiscoveryService: vi.fn(),
    setAgentStatusManager: vi.fn(),
    getAgentStatusManager: vi.fn().mockReturnValue(null),
    getServerManager: vi.fn().mockReturnValue({
      stopServer: vi.fn().mockResolvedValue({ success: true }),
      getPort: vi.fn().mockReturnValue(null),
    }),
    ...overrides,
  } as unknown as AppState;
}

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

function createMockDeps(overrides: Partial<CoreModuleDeps> = {}): CoreModuleDeps {
  const defaults: CoreModuleDeps = {
    appState: createMockAppState(),
    viewManager: createMockViewManager(),
    emitDeletionProgress: vi.fn(),
    logger: createMockLogger(),
  };
  return { ...defaults, ...overrides };
}

// =============================================================================
// Tests
// =============================================================================

describe("core.projects", () => {
  let registry: MockApiRegistry;
  let deps: CoreModuleDeps;

  beforeEach(() => {
    registry = createMockRegistry();
    deps = createMockDeps();
  });

  describe("projects.open", () => {
    it("opens project and emits project:opened event", async () => {
      const appState = createMockAppState({
        openProject: vi.fn().mockResolvedValue({
          path: "/test/project",
          name: "test-project",
          workspaces: [],
        }),
      });
      deps = createMockDeps({ appState });
      new CoreModule(registry, deps);

      const handler = registry.getHandler("projects.open");
      const result = await handler!({ path: "/test/project" });

      expect(result.name).toBe("test-project");
      expect(appState.openProject).toHaveBeenCalledWith("/test/project");

      const emittedEvents = registry.getEmittedEvents();
      expect(emittedEvents).toContainEqual({
        event: "project:opened",
        payload: { project: expect.any(Object) },
      });
    });
  });

  describe("projects.list", () => {
    it("returns list of projects", async () => {
      const appState = createMockAppState({
        getAllProjects: vi.fn().mockResolvedValue([
          { path: "/test/project1", name: "project1", workspaces: [] },
          { path: "/test/project2", name: "project2", workspaces: [] },
        ]),
      });
      deps = createMockDeps({ appState });
      new CoreModule(registry, deps);

      const handler = registry.getHandler("projects.list");
      const result = await handler!({});

      expect(result).toHaveLength(2);
      expect(result[0]?.name).toBe("project1");
      expect(result[1]?.name).toBe("project2");
    });
  });

  describe("projects.close", () => {
    it("closes project and emits project:closed event", async () => {
      const appState = createMockAppState({
        getAllProjects: vi
          .fn()
          .mockResolvedValue([{ path: TEST_PROJECT_PATH, name: "test-project", workspaces: [] }]),
        closeProject: vi.fn().mockResolvedValue(undefined),
      });
      deps = createMockDeps({ appState });
      new CoreModule(registry, deps);

      const handler = registry.getHandler("projects.close");
      await handler!({ projectId: TEST_PROJECT_ID });

      expect(appState.closeProject).toHaveBeenCalledWith(TEST_PROJECT_PATH);

      const emittedEvents = registry.getEmittedEvents();
      expect(emittedEvents).toContainEqual({
        event: "project:closed",
        payload: { projectId: TEST_PROJECT_ID },
      });
    });
  });
});

describe("core.workspaces", () => {
  let registry: MockApiRegistry;
  let deps: CoreModuleDeps;

  beforeEach(() => {
    registry = createMockRegistry();
    deps = createMockDeps();
  });

  describe("workspaces.create", () => {
    it("creates workspace and emits workspace:created event", async () => {
      const appState = createMockAppState({
        getAllProjects: vi
          .fn()
          .mockResolvedValue([{ path: TEST_PROJECT_PATH, name: "test-project", workspaces: [] }]),
        getWorkspaceProvider: vi.fn().mockReturnValue({
          createWorkspace: vi.fn().mockResolvedValue({
            path: `${TEST_PROJECT_PATH}/workspaces/feature`,
            branch: "feature",
            metadata: { base: "main" },
          }),
        }),
      });
      deps = createMockDeps({ appState });
      new CoreModule(registry, deps);

      const handler = registry.getHandler("workspaces.create");
      const result = await handler!({
        projectId: TEST_PROJECT_ID,
        name: "feature",
        base: "main",
      });

      expect(result.name).toBe("feature");
      expect(result.branch).toBe("feature");

      const emittedEvents = registry.getEmittedEvents();
      expect(emittedEvents).toContainEqual({
        event: "workspace:created",
        payload: { projectId: TEST_PROJECT_ID, workspace: expect.any(Object) },
      });
    });
  });
});

describe("core.registration", () => {
  let registry: MockApiRegistry;
  let deps: CoreModuleDeps;

  beforeEach(() => {
    registry = createMockRegistry();
    deps = createMockDeps();
  });

  it("registers all projects.* paths with IPC", () => {
    new CoreModule(registry, deps);

    const registeredPaths = registry.getRegisteredPaths();
    expect(registeredPaths).toContain("projects.open");
    expect(registeredPaths).toContain("projects.close");
    expect(registeredPaths).toContain("projects.list");
    expect(registeredPaths).toContain("projects.get");
    expect(registeredPaths).toContain("projects.fetchBases");
  });

  it("registers all workspaces.* paths with IPC", () => {
    new CoreModule(registry, deps);

    const registeredPaths = registry.getRegisteredPaths();
    expect(registeredPaths).toContain("workspaces.create");
    expect(registeredPaths).toContain("workspaces.remove");
    expect(registeredPaths).toContain("workspaces.forceRemove");
    expect(registeredPaths).toContain("workspaces.get");
    expect(registeredPaths).toContain("workspaces.getStatus");
    expect(registeredPaths).toContain("workspaces.getOpencodePort");
    expect(registeredPaths).toContain("workspaces.setMetadata");
    expect(registeredPaths).toContain("workspaces.getMetadata");
  });

  it("registers methods with correct IPC channels", () => {
    new CoreModule(registry, deps);

    expect(registry.register).toHaveBeenCalledWith("projects.open", expect.any(Function), {
      ipc: "api:project:open",
    });
    expect(registry.register).toHaveBeenCalledWith("workspaces.create", expect.any(Function), {
      ipc: "api:workspace:create",
    });
  });
});

describe("CoreModule.dispose", () => {
  let registry: MockApiRegistry;
  let deps: CoreModuleDeps;

  beforeEach(() => {
    registry = createMockRegistry();
    deps = createMockDeps();
  });

  it("dispose is a no-op", () => {
    const module = new CoreModule(registry, deps);
    expect(() => module.dispose()).not.toThrow();
  });
});

describe("core.workspaces.remove.server.stop.error", () => {
  let registry: MockApiRegistry;
  let deps: CoreModuleDeps;

  beforeEach(() => {
    registry = createMockRegistry();
  });

  it("continues deletion when server stop fails", async () => {
    const workspacePath = `${TEST_PROJECT_PATH}/workspaces/feature`;
    const workspaceName = "feature" as import("../../../shared/api/types").WorkspaceName;
    const emitDeletionProgress = vi.fn();

    const appState = createMockAppState({
      getAllProjects: vi.fn().mockResolvedValue([
        {
          path: TEST_PROJECT_PATH,
          name: "test-project",
          workspaces: [{ path: workspacePath, branch: "feature", metadata: { base: "main" } }],
        },
      ]),
      getProject: vi.fn().mockReturnValue({
        path: TEST_PROJECT_PATH,
        name: "test-project",
        workspaces: [{ path: workspacePath, branch: "feature", metadata: { base: "main" } }],
      }),
      getServerManager: vi.fn().mockReturnValue({
        stopServer: vi.fn().mockResolvedValue({ success: false, error: "Server stop failed" }),
        getPort: vi.fn().mockReturnValue(null),
      }),
      getWorkspaceProvider: vi.fn().mockReturnValue({
        removeWorkspace: vi.fn().mockResolvedValue(undefined),
      }),
    });

    const viewManager = createMockViewManager();

    deps = createMockDeps({ appState, viewManager, emitDeletionProgress });
    new CoreModule(registry, deps);

    const handler = registry.getHandler("workspaces.remove");
    const result = await handler!({
      projectId: TEST_PROJECT_ID,
      workspaceName,
      keepBranch: true,
    });

    expect(result).toEqual({ started: true });

    // Wait for async deletion to complete
    await vi.waitFor(() => {
      const calls = emitDeletionProgress.mock.calls;
      const lastCall = calls[calls.length - 1];
      expect(lastCall).toBeDefined();
      const progress = lastCall![0];
      expect(progress.completed).toBe(true);
    });

    // Verify deletion progress was emitted with server stop error
    const calls = emitDeletionProgress.mock.calls;
    const lastCall = calls[calls.length - 1];
    const progress = lastCall![0];

    // The stop-server operation should have an error status
    const stopServerOp = progress.operations.find((op: { id: string }) => op.id === "stop-server");
    expect(stopServerOp?.status).toBe("error");
    expect(stopServerOp?.error).toBe("Server stop failed");

    // But cleanup-vscode should have still been attempted
    const cleanupVscodeOp = progress.operations.find(
      (op: { id: string }) => op.id === "cleanup-vscode"
    );
    expect(cleanupVscodeOp?.status).toBe("done");
  });
});

describe("core.workspaces.remove.view.destroy.error", () => {
  let registry: MockApiRegistry;
  let deps: CoreModuleDeps;

  beforeEach(() => {
    registry = createMockRegistry();
  });

  it("continues deletion when view destroy fails", async () => {
    const workspacePath = `${TEST_PROJECT_PATH}/workspaces/feature`;
    const workspaceName = "feature" as import("../../../shared/api/types").WorkspaceName;
    const emitDeletionProgress = vi.fn();

    const appState = createMockAppState({
      getAllProjects: vi.fn().mockResolvedValue([
        {
          path: TEST_PROJECT_PATH,
          name: "test-project",
          workspaces: [{ path: workspacePath, branch: "feature", metadata: { base: "main" } }],
        },
      ]),
      getProject: vi.fn().mockReturnValue({
        path: TEST_PROJECT_PATH,
        name: "test-project",
        workspaces: [{ path: workspacePath, branch: "feature", metadata: { base: "main" } }],
      }),
      getServerManager: vi.fn().mockReturnValue({
        stopServer: vi.fn().mockResolvedValue({ success: true }),
        getPort: vi.fn().mockReturnValue(null),
      }),
      getWorkspaceProvider: vi.fn().mockReturnValue({
        removeWorkspace: vi.fn().mockResolvedValue(undefined),
      }),
    });

    const viewManager = {
      ...createMockViewManager(),
      destroyWorkspaceView: vi.fn().mockRejectedValue(new Error("View destroy failed")),
    } as unknown as IViewManager;

    deps = createMockDeps({ appState, viewManager, emitDeletionProgress });
    new CoreModule(registry, deps);

    const handler = registry.getHandler("workspaces.remove");
    const result = await handler!({
      projectId: TEST_PROJECT_ID,
      workspaceName,
      keepBranch: true,
    });

    expect(result).toEqual({ started: true });

    // Wait for async deletion to complete
    await vi.waitFor(() => {
      const calls = emitDeletionProgress.mock.calls;
      const lastCall = calls[calls.length - 1];
      expect(lastCall).toBeDefined();
      const progress = lastCall![0];
      expect(progress.completed).toBe(true);
    });

    // Verify deletion progress was emitted with view destroy error
    const calls = emitDeletionProgress.mock.calls;
    const lastCall = calls[calls.length - 1];
    const progress = lastCall![0];

    // The cleanup-vscode operation should have an error status
    const cleanupVscodeOp = progress.operations.find(
      (op: { id: string }) => op.id === "cleanup-vscode"
    );
    expect(cleanupVscodeOp?.status).toBe("error");
    expect(cleanupVscodeOp?.error).toBe("View destroy failed");

    // But cleanup-workspace should have still been attempted
    const cleanupWorkspaceOp = progress.operations.find(
      (op: { id: string }) => op.id === "cleanup-workspace"
    );
    expect(["done", "in-progress"]).toContain(cleanupWorkspaceOp?.status);
  });
});

describe("core.workspaces.remove.last-workspace", () => {
  let registry: MockApiRegistry;
  let deps: CoreModuleDeps;

  beforeEach(() => {
    registry = createMockRegistry();
  });

  it("emits workspace:switched(null) when removing last active workspace", async () => {
    const workspacePath = `${TEST_PROJECT_PATH}/workspaces/feature`;
    const workspaceName = "feature" as import("../../../shared/api/types").WorkspaceName;
    const emitDeletionProgress = vi.fn();

    const appState = createMockAppState({
      // Only one workspace exists
      getAllProjects: vi.fn().mockResolvedValue([
        {
          path: TEST_PROJECT_PATH,
          name: "test-project",
          workspaces: [{ path: workspacePath, branch: "feature", metadata: { base: "main" } }],
        },
      ]),
      getProject: vi.fn().mockReturnValue({
        path: TEST_PROJECT_PATH,
        name: "test-project",
        workspaces: [{ path: workspacePath, branch: "feature", metadata: { base: "main" } }],
      }),
      getServerManager: vi.fn().mockReturnValue({
        stopServer: vi.fn().mockResolvedValue({ success: true }),
        getPort: vi.fn().mockReturnValue(null),
      }),
      getWorkspaceProvider: vi.fn().mockReturnValue({
        removeWorkspace: vi.fn().mockResolvedValue(undefined),
      }),
    });

    const viewManager = {
      ...createMockViewManager(),
      // This workspace is the active one
      getActiveWorkspacePath: vi.fn().mockReturnValue(workspacePath),
      setActiveWorkspace: vi.fn(),
    } as unknown as IViewManager;

    deps = createMockDeps({ appState, viewManager, emitDeletionProgress });
    new CoreModule(registry, deps);

    // Track workspace:switched events
    const switchedEvents: unknown[] = [];
    registry.on("workspace:switched", (event: unknown) => {
      switchedEvents.push(event);
    });

    const handler = registry.getHandler("workspaces.remove");
    const result = await handler!({
      projectId: TEST_PROJECT_ID,
      workspaceName,
      keepBranch: true,
    });

    expect(result).toEqual({ started: true });

    // workspace:switched(null) should be emitted synchronously before fire-and-forget
    expect(switchedEvents).toHaveLength(1);
    expect(switchedEvents[0]).toBeNull();

    // viewManager.setActiveWorkspace(null) should have been called
    expect(viewManager.setActiveWorkspace).toHaveBeenCalledWith(null, false);
  });

  it("does not emit workspace:switched(null) when other workspaces exist", async () => {
    const workspacePath1 = `${TEST_PROJECT_PATH}/workspaces/feature1`;
    const workspacePath2 = `${TEST_PROJECT_PATH}/workspaces/feature2`;
    const workspaceName = "feature1" as import("../../../shared/api/types").WorkspaceName;
    const emitDeletionProgress = vi.fn();

    const appState = createMockAppState({
      // Two workspaces exist
      getAllProjects: vi.fn().mockResolvedValue([
        {
          path: TEST_PROJECT_PATH,
          name: "test-project",
          workspaces: [
            { path: workspacePath1, branch: "feature1", metadata: { base: "main" } },
            { path: workspacePath2, branch: "feature2", metadata: { base: "main" } },
          ],
        },
      ]),
      getProject: vi.fn().mockReturnValue({
        path: TEST_PROJECT_PATH,
        name: "test-project",
        workspaces: [
          { path: workspacePath1, branch: "feature1", metadata: { base: "main" } },
          { path: workspacePath2, branch: "feature2", metadata: { base: "main" } },
        ],
      }),
      getServerManager: vi.fn().mockReturnValue({
        stopServer: vi.fn().mockResolvedValue({ success: true }),
        getPort: vi.fn().mockReturnValue(null),
      }),
      getWorkspaceProvider: vi.fn().mockReturnValue({
        removeWorkspace: vi.fn().mockResolvedValue(undefined),
      }),
    });

    const viewManager = {
      ...createMockViewManager(),
      // First workspace is active
      getActiveWorkspacePath: vi.fn().mockReturnValue(workspacePath1),
      setActiveWorkspace: vi.fn(),
    } as unknown as IViewManager;

    deps = createMockDeps({ appState, viewManager, emitDeletionProgress });
    new CoreModule(registry, deps);

    // Track workspace:switched events
    const switchedEvents: unknown[] = [];
    registry.on("workspace:switched", (event: unknown) => {
      switchedEvents.push(event);
    });

    const handler = registry.getHandler("workspaces.remove");
    await handler!({
      projectId: TEST_PROJECT_ID,
      workspaceName,
      keepBranch: true,
    });

    // Should switch to the other workspace, not null
    expect(switchedEvents).toHaveLength(1);
    expect(switchedEvents[0]).not.toBeNull();
    expect(switchedEvents[0]).toMatchObject({
      path: workspacePath2,
      workspaceName: "feature2",
    });

    // viewManager.setActiveWorkspace should be called with the other workspace
    expect(viewManager.setActiveWorkspace).toHaveBeenCalledWith(workspacePath2, false);
  });
});
