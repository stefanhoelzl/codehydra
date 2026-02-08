/**
 * Integration tests for bootstrap.
 *
 * These tests verify the full bootstrap flow with modules wired correctly.
 * Uses behavioral IpcLayer mock instead of vi.mock("electron").
 */

import { describe, it, expect, vi } from "vitest";
import { initializeBootstrap } from "./bootstrap";
import type { BootstrapDeps } from "./bootstrap";
import type { LifecycleModuleDeps } from "./modules/lifecycle";
import type { CoreModuleDeps } from "./modules/core";
import { createMockLogger } from "../services/logging";
import type { IKeepFilesService } from "../services/keepfiles";
import { createBehavioralIpcLayer } from "../services/platform/ipc.test-utils";
import { HookRegistry } from "./intents/infrastructure/hook-registry";
import { Dispatcher } from "./intents/infrastructure/dispatcher";
import type { AppState } from "./app-state";
import type { IViewManager } from "./managers/view-manager.interface";
import type { WorkspaceName } from "../shared/api/types";
import { generateProjectId } from "./api/id-utils";

// =============================================================================
// Test Constants
// =============================================================================

const TEST_PROJECT_PATH = "/test/project";
const TEST_PROJECT_ID = generateProjectId(TEST_PROJECT_PATH);
const TEST_WORKSPACE_PATH = `${TEST_PROJECT_PATH}/workspaces/feature`;
const TEST_WORKSPACE_NAME = "feature" as WorkspaceName;

// =============================================================================
// Mock Factories
// =============================================================================

function createMockLifecycleDeps(overrides?: Partial<LifecycleModuleDeps>): LifecycleModuleDeps {
  return {
    getVscodeSetup: vi.fn().mockResolvedValue(undefined),
    configService: {
      load: vi.fn().mockResolvedValue({
        agent: "opencode",
        versions: { claude: null, opencode: null, codeServer: "4.107.0" },
      }),
      save: vi.fn().mockResolvedValue(undefined),
      updateAgent: vi.fn().mockResolvedValue(undefined),
    } as unknown as import("../services/config/config-service").ConfigService,
    app: { quit: vi.fn() },
    doStartServices: vi.fn().mockResolvedValue(undefined),
    logger: createMockLogger(),
    ...overrides,
  };
}

function createMockAppState(overrides?: Partial<AppState>): AppState {
  return {
    openProject: vi.fn().mockResolvedValue({
      path: TEST_PROJECT_PATH,
      name: "test-project",
      workspaces: [],
    }),
    closeProject: vi.fn().mockResolvedValue(undefined),
    getProject: vi.fn().mockReturnValue({
      path: TEST_PROJECT_PATH,
      name: "test-project",
      workspaces: [{ path: TEST_WORKSPACE_PATH, branch: "feature", metadata: { base: "main" } }],
    }),
    getAllProjects: vi.fn().mockResolvedValue([
      {
        path: TEST_PROJECT_PATH,
        name: "test-project",
        workspaces: [{ path: TEST_WORKSPACE_PATH, branch: "feature", metadata: { base: "main" } }],
      },
    ]),
    getWorkspaceProvider: vi.fn().mockReturnValue({
      createWorkspace: vi.fn().mockResolvedValue({
        path: TEST_WORKSPACE_PATH,
        branch: "feature",
        metadata: { base: "main" },
      }),
      unregisterWorkspace: vi.fn(),
      listBases: vi.fn().mockResolvedValue([]),
      updateBases: vi.fn().mockResolvedValue(undefined),
      isDirty: vi.fn().mockResolvedValue(false),
      setMetadata: vi.fn().mockResolvedValue(undefined),
      getMetadata: vi.fn().mockResolvedValue({ base: "main" }),
    }),
    findProjectForWorkspace: vi.fn().mockReturnValue({
      path: TEST_PROJECT_PATH,
      name: "test-project",
      workspaces: [],
    }),
    registerWorkspace: vi.fn(),
    unregisterWorkspace: vi.fn(),
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
  const modeChangeHandlers: Array<(event: { mode: string; previousMode: string }) => void> = [];
  return {
    getUIView: vi.fn(),
    createWorkspaceView: vi.fn(),
    destroyWorkspaceView: vi.fn().mockResolvedValue(undefined),
    getWorkspaceView: vi.fn(),
    updateBounds: vi.fn(),
    setActiveWorkspace: vi.fn(),
    getActiveWorkspacePath: vi.fn().mockReturnValue(TEST_WORKSPACE_PATH),
    focusActiveWorkspace: vi.fn(),
    focusUI: vi.fn(),
    setMode: vi.fn(),
    getMode: vi.fn().mockReturnValue("workspace"),
    onModeChange: vi.fn((handler) => {
      modeChangeHandlers.push(handler);
      return () => {
        const idx = modeChangeHandlers.indexOf(handler);
        if (idx >= 0) modeChangeHandlers.splice(idx, 1);
      };
    }),
    onWorkspaceChange: vi.fn().mockReturnValue(() => {}),
    updateCodeServerPort: vi.fn(),
    // Test helper for emitting mode changes
    _emitModeChange: (event: { mode: string; previousMode: string }) => {
      for (const handler of modeChangeHandlers) {
        handler(event);
      }
    },
  } as unknown as IViewManager & {
    _emitModeChange: (event: { mode: string; previousMode: string }) => void;
  };
}

function createMockCoreDeps(): CoreModuleDeps {
  return {
    appState: createMockAppState(),
    viewManager: createMockViewManager(),
    gitClient: {
      clone: vi.fn().mockResolvedValue(undefined),
    } as unknown as import("../services").IGitClient,
    pathProvider: {
      projectsDir: "/test/projects",
    } as unknown as import("../services").PathProvider,
    projectStore: {
      findByRemoteUrl: vi.fn().mockResolvedValue(undefined),
      saveProject: vi.fn().mockResolvedValue(undefined),
      getProjectConfig: vi.fn().mockResolvedValue(undefined),
      deleteProjectDirectory: vi.fn().mockResolvedValue(undefined),
    } as unknown as import("../services").ProjectStore,
    dialog: {
      showOpenDialog: vi.fn().mockResolvedValue({ canceled: true, filePaths: [] }),
    },
    logger: createMockLogger(),
  };
}

function createMockGlobalWorktreeProvider(): import("../services/git/git-worktree-provider").GitWorktreeProvider {
  return {
    setMetadata: vi.fn().mockResolvedValue(undefined),
    getMetadata: vi.fn().mockResolvedValue({ base: "main" }),
    registerProject: vi.fn(),
    unregisterProject: vi.fn(),
    ensureWorkspaceRegistered: vi.fn(),
  } as unknown as import("../services/git/git-worktree-provider").GitWorktreeProvider;
}

function createMockDispatcher(): ReturnType<BootstrapDeps["dispatcherFn"]> {
  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);
  return { hookRegistry, dispatcher };
}

function createMockKeepFilesService(): IKeepFilesService {
  return {
    copyToWorkspace: async () => ({
      configExists: false,
      copiedCount: 0,
      skippedCount: 0,
      errors: [],
    }),
  };
}

function createMockDeps(): BootstrapDeps {
  return {
    logger: createMockLogger(),
    ipcLayer: createBehavioralIpcLayer(),
    lifecycleDeps: createMockLifecycleDeps(),
    coreDepsFn: () => createMockCoreDeps(),
    globalWorktreeProviderFn: () => createMockGlobalWorktreeProvider(),
    keepFilesServiceFn: () => createMockKeepFilesService(),
    workspaceFileServiceFn: () =>
      ({
        deleteWorkspaceFile: vi.fn().mockResolvedValue(undefined),
      }) as unknown as import("../services").IWorkspaceFileService,
    emitDeletionProgressFn: () => vi.fn(),
    killTerminalsCallbackFn: () => undefined,
    workspaceLockHandlerFn: () => undefined,
    dispatcherFn: createMockDispatcher,
  };
}

// =============================================================================
// Integration Tests
// =============================================================================

describe("bootstrap.startup", () => {
  it("full startup with registry and modules", async () => {
    const deps = createMockDeps();
    const result = initializeBootstrap(deps) as ReturnType<typeof initializeBootstrap> & {
      startServices: () => void;
    };

    // Start services to register all modules
    result.startServices();

    // Get the complete API interface
    const api = result.getInterface();

    // Verify all API groups are available
    expect(api.lifecycle).toBeDefined();
    expect(api.lifecycle.getState).toBeTypeOf("function");
    expect(api.lifecycle.setup).toBeTypeOf("function");
    expect(api.lifecycle.quit).toBeTypeOf("function");

    expect(api.projects).toBeDefined();
    expect(api.projects.open).toBeTypeOf("function");
    expect(api.projects.close).toBeTypeOf("function");
    expect(api.projects.list).toBeTypeOf("function");
    expect(api.projects.get).toBeTypeOf("function");
    expect(api.projects.fetchBases).toBeTypeOf("function");

    expect(api.workspaces).toBeDefined();
    expect(api.workspaces.create).toBeTypeOf("function");
    expect(api.workspaces.remove).toBeTypeOf("function");
    expect(api.workspaces.get).toBeTypeOf("function");
    expect(api.workspaces.getStatus).toBeTypeOf("function");
    expect(api.workspaces.getAgentSession).toBeTypeOf("function");
    expect(api.workspaces.setMetadata).toBeTypeOf("function");
    expect(api.workspaces.getMetadata).toBeTypeOf("function");

    expect(api.ui).toBeDefined();
    expect(api.ui.selectFolder).toBeTypeOf("function");
    expect(api.ui.getActiveWorkspace).toBeTypeOf("function");
    expect(api.ui.switchWorkspace).toBeTypeOf("function");
    expect(api.ui.setMode).toBeTypeOf("function");

    // Cleanup
    await result.dispose();
  });
});

describe("bootstrap.module.order", () => {
  it("lifecycle registered before Core/UI", () => {
    const deps = createMockDeps();
    const result = initializeBootstrap(deps) as ReturnType<typeof initializeBootstrap> & {
      startServices: () => void;
    };

    // Before startServices(), only lifecycle methods should be registered
    // Calling getInterface() should throw because Core/UI are missing
    expect(() => result.getInterface()).toThrow(/Missing method registrations/);

    // Now start services
    result.startServices();

    // Now getInterface() should succeed
    expect(() => result.getInterface()).not.toThrow();
  });

  it("doStartServices callback is provided to lifecycle module", () => {
    const doStartServicesMock = vi.fn().mockResolvedValue(undefined);

    const deps: BootstrapDeps = {
      logger: createMockLogger(),
      ipcLayer: createBehavioralIpcLayer(),
      lifecycleDeps: createMockLifecycleDeps({
        doStartServices: doStartServicesMock,
      }),
      coreDepsFn: () => createMockCoreDeps(),
      globalWorktreeProviderFn: () => createMockGlobalWorktreeProvider(),
      keepFilesServiceFn: () => createMockKeepFilesService(),
      workspaceFileServiceFn: () =>
        ({
          deleteWorkspaceFile: vi.fn().mockResolvedValue(undefined),
        }) as unknown as import("../services").IWorkspaceFileService,
      emitDeletionProgressFn: () => vi.fn(),
      killTerminalsCallbackFn: () => undefined,
      workspaceLockHandlerFn: () => undefined,
      dispatcherFn: createMockDispatcher,
    };

    const result = initializeBootstrap(deps);

    // Verify the registry was created and lifecycle module is registered
    expect(result.registry).toBeDefined();

    // The doStartServices callback is wired through to the lifecycle module
    // When setup completes successfully, it will call this callback
    // which in turn calls startServices()
    expect(doStartServicesMock).not.toHaveBeenCalled(); // Not called until setup runs
  });
});

// =============================================================================
// IPC Roundtrip Tests
// =============================================================================

// NOTE: IPC roundtrip testing (call from mock renderer, verify result matches)
// is covered by boundary tests in src/main/api/registry.boundary.test.ts.
// Those tests verify actual Electron IPC behavior with the real ipcMain module.

// =============================================================================
// Event Tests
// =============================================================================

describe("bootstrap.events.roundtrip", () => {
  it("events flow from modules to subscribers", async () => {
    const deps = createMockDeps();
    const result = initializeBootstrap(deps) as ReturnType<typeof initializeBootstrap> & {
      startServices: () => void;
    };

    result.startServices();

    // Subscribe to project:opened event
    const projectOpenedHandler = vi.fn();
    result.registry.on("project:opened", projectOpenedHandler);

    // Subscribe to workspace:created event
    const workspaceCreatedHandler = vi.fn();
    result.registry.on("workspace:created", workspaceCreatedHandler);

    // Emit project:opened
    result.registry.emit("project:opened", {
      project: {
        id: TEST_PROJECT_ID,
        name: "test-project",
        path: TEST_PROJECT_PATH,
        workspaces: [],
      },
    });

    expect(projectOpenedHandler).toHaveBeenCalledOnce();
    expect(projectOpenedHandler).toHaveBeenCalledWith({
      project: expect.objectContaining({
        id: TEST_PROJECT_ID,
        name: "test-project",
      }),
    });

    // Emit workspace:created
    result.registry.emit("workspace:created", {
      projectId: TEST_PROJECT_ID,
      workspace: {
        projectId: TEST_PROJECT_ID,
        name: TEST_WORKSPACE_NAME,
        branch: "feature",
        metadata: { base: "main" },
        path: TEST_WORKSPACE_PATH,
      },
    });

    expect(workspaceCreatedHandler).toHaveBeenCalledOnce();
    expect(workspaceCreatedHandler).toHaveBeenCalledWith({
      projectId: TEST_PROJECT_ID,
      workspace: expect.objectContaining({
        name: TEST_WORKSPACE_NAME,
      }),
    });

    // Cleanup
    await result.dispose();
  });
});

describe("bootstrap.events.multiple", () => {
  it("multiple subscribers receive same event", () => {
    const deps = createMockDeps();
    const result = initializeBootstrap(deps) as ReturnType<typeof initializeBootstrap> & {
      startServices: () => void;
    };

    result.startServices();

    // Subscribe multiple handlers
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    const handler3 = vi.fn();

    result.registry.on("project:closed", handler1);
    result.registry.on("project:closed", handler2);
    result.registry.on("project:closed", handler3);

    // Emit event
    result.registry.emit("project:closed", { projectId: TEST_PROJECT_ID });

    // All handlers should be called
    expect(handler1).toHaveBeenCalledOnce();
    expect(handler2).toHaveBeenCalledOnce();
    expect(handler3).toHaveBeenCalledOnce();
  });
});

describe("bootstrap.events.unsubscribe", () => {
  it("unsubscribed handlers do not receive events", () => {
    const deps = createMockDeps();
    const result = initializeBootstrap(deps) as ReturnType<typeof initializeBootstrap> & {
      startServices: () => void;
    };

    result.startServices();

    const handler = vi.fn();
    const unsubscribe = result.registry.on("project:opened", handler);

    // Emit first event
    result.registry.emit("project:opened", {
      project: {
        id: TEST_PROJECT_ID,
        name: "test",
        path: TEST_PROJECT_PATH,
        workspaces: [],
      },
    });

    expect(handler).toHaveBeenCalledOnce();

    // Unsubscribe
    unsubscribe();

    // Emit second event
    result.registry.emit("project:opened", {
      project: {
        id: TEST_PROJECT_ID,
        name: "test",
        path: TEST_PROJECT_PATH,
        workspaces: [],
      },
    });

    // Handler should NOT be called again
    expect(handler).toHaveBeenCalledOnce();
  });

  it("unsubscribing one handler does not affect others", () => {
    const deps = createMockDeps();
    const result = initializeBootstrap(deps) as ReturnType<typeof initializeBootstrap> & {
      startServices: () => void;
    };

    result.startServices();

    const handler1 = vi.fn();
    const handler2 = vi.fn();

    const unsubscribe1 = result.registry.on("workspace:removed", handler1);
    result.registry.on("workspace:removed", handler2);

    // Unsubscribe handler1
    unsubscribe1();

    // Emit event
    result.registry.emit("workspace:removed", {
      projectId: TEST_PROJECT_ID,
      workspaceName: TEST_WORKSPACE_NAME,
      path: TEST_WORKSPACE_PATH,
    });

    // Only handler2 should be called
    expect(handler1).not.toHaveBeenCalled();
    expect(handler2).toHaveBeenCalledOnce();
  });
});

describe("bootstrap.error.propagation", () => {
  it("handler errors are caught and do not affect other handlers", () => {
    const deps = createMockDeps();
    const result = initializeBootstrap(deps) as ReturnType<typeof initializeBootstrap> & {
      startServices: () => void;
    };

    result.startServices();

    const errorHandler = vi.fn().mockImplementation(() => {
      throw new Error("Handler error");
    });
    const normalHandler = vi.fn();

    result.registry.on("project:opened", errorHandler);
    result.registry.on("project:opened", normalHandler);

    // Emit event - should not throw
    expect(() =>
      result.registry.emit("project:opened", {
        project: {
          id: TEST_PROJECT_ID,
          name: "test",
          path: TEST_PROJECT_PATH,
          workspaces: [],
        },
      })
    ).not.toThrow();

    // Both handlers should have been attempted
    expect(errorHandler).toHaveBeenCalledOnce();
    expect(normalHandler).toHaveBeenCalledOnce();
  });
});
