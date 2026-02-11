/**
 * Unit tests for bootstrap.
 *
 * Uses behavioral IpcLayer mock instead of vi.mock("electron").
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { initializeBootstrap } from "./bootstrap";
import type { BootstrapDeps } from "./bootstrap";
import type { CoreModuleDeps } from "./modules/core";
import { createMockLogger } from "../services/logging";
import type { IKeepFilesService } from "../services/keepfiles";
import { createBehavioralIpcLayer } from "../services/platform/ipc.test-utils";
import { HookRegistry } from "./intents/infrastructure/hook-registry";
import { Dispatcher } from "./intents/infrastructure/dispatcher";
import type { AppState } from "./app-state";
import type { IViewManager } from "./managers/view-manager.interface";

// =============================================================================
// Mock Factories
// =============================================================================

function createMockAppState(): AppState {
  return {
    openProject: vi.fn().mockResolvedValue({
      path: "/test/project",
      name: "test-project",
      workspaces: [],
    }),
    closeProject: vi.fn().mockResolvedValue(undefined),
    getProject: vi.fn().mockReturnValue({
      path: "/test/project",
      name: "test-project",
      workspaces: [],
    }),
    getAllProjects: vi.fn().mockResolvedValue([]),
    getWorkspaceProvider: vi.fn().mockReturnValue({
      createWorkspace: vi.fn().mockResolvedValue({
        path: "/test/project/workspaces/feature",
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
    findProjectForWorkspace: vi.fn(),
    registerWorkspace: vi.fn(),
    unregisterWorkspace: vi.fn(),
    getWorkspaceUrl: vi.fn(),
    getDefaultBaseBranch: vi.fn().mockResolvedValue("main"),
    setLastBaseBranch: vi.fn(),
    setDiscoveryService: vi.fn(),
    getDiscoveryService: vi.fn(),
    setAgentStatusManager: vi.fn(),
    getAgentStatusManager: vi.fn().mockReturnValue(null),
    getServerManager: vi.fn().mockReturnValue({
      stopServer: vi.fn().mockResolvedValue({ success: true }),
      getPort: vi.fn().mockReturnValue(null),
    }),
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
    onWorkspaceChange: vi.fn().mockReturnValue(() => {}),
    updateCodeServerPort: vi.fn(),
  } as unknown as IViewManager;
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
      remotesDir: "/test/remotes",
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
    app: { quit: vi.fn() },
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
    setTitleFn: () => vi.fn(),
    titleVersionFn: () => "test",
    hasUpdateAvailableFn: () => () => false,
    badgeManagerFn: () =>
      ({ updateBadge: vi.fn() }) as unknown as import("./managers/badge-manager").BadgeManager,
    workspaceResolverFn: () => () => undefined,
    lifecycleRefsFn: () =>
      ({
        loggingService: { createLogger: () => createMockLogger() },
      }) as unknown as import("./bootstrap").LifecycleServiceRefs,
    getUIWebContentsFn: () => null,
    setupDeps: {
      configService: {
        load: vi.fn().mockResolvedValue({ agent: "opencode", versions: {} }),
        save: vi.fn().mockResolvedValue(undefined),
        setAgent: vi.fn().mockResolvedValue(undefined),
      } as unknown as import("../services/config/config-service").ConfigService,
      codeServerManager: {
        preflight: vi.fn().mockResolvedValue({ needsDownload: false }),
        downloadBinary: vi.fn().mockResolvedValue(undefined),
      } as unknown as import("../services").CodeServerManager,
      getAgentBinaryManager: () =>
        ({
          preflight: vi.fn().mockResolvedValue({ needsDownload: false }),
          downloadBinary: vi.fn().mockResolvedValue(undefined),
        }) as unknown as import("../services/binary-download").AgentBinaryManager,
      extensionManager: {
        preflight: vi.fn().mockResolvedValue({ needsInstall: false, missing: [], outdated: [] }),
        install: vi.fn().mockResolvedValue(undefined),
      } as unknown as import("../services/vscode-setup/extension-manager").ExtensionManager,
    },
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("initializeBootstrap", () => {
  let deps: BootstrapDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it("creates registry with lifecycle methods registered", () => {
    const result = initializeBootstrap(deps);

    // Lifecycle methods should be registered immediately
    // Check that lifecycle methods are available by verifying registry exists
    expect(result.registry).toBeDefined();
    expect(result.getInterface).toBeDefined();
    expect(result.dispose).toBeDefined();
  });

  it("getInterface throws when not all methods are registered", () => {
    const result = initializeBootstrap(deps);

    // Only lifecycle methods are registered initially
    // Core and UI methods are missing, so getInterface should throw
    expect(() => result.getInterface()).toThrow(/Missing method registrations/);
  });

  it("startServices registers core and ui methods", () => {
    const result = initializeBootstrap(deps) as ReturnType<typeof initializeBootstrap> & {
      startServices: () => void;
    };

    // Start services to register remaining modules
    result.startServices();

    // Now all methods should be registered
    const api = result.getInterface();
    expect(api.lifecycle).toBeDefined();
    expect(api.projects).toBeDefined();
    expect(api.workspaces).toBeDefined();
    expect(api.ui).toBeDefined();
  });

  it("startServices is idempotent", () => {
    const result = initializeBootstrap(deps) as ReturnType<typeof initializeBootstrap> & {
      startServices: () => void;
    };

    // Calling startServices multiple times should not throw
    result.startServices();
    expect(() => result.startServices()).not.toThrow();
  });

  it("dispose cleans up all modules", async () => {
    const result = initializeBootstrap(deps) as ReturnType<typeof initializeBootstrap> & {
      startServices: () => void;
    };

    result.startServices();

    // Get interface to verify it works before dispose
    const api = result.getInterface();
    expect(api).toBeDefined();

    // Dispose should not throw
    await expect(result.dispose()).resolves.not.toThrow();
  });

  it("registers IPC handlers for all modules", () => {
    // IPC handlers are registered automatically for all modules
    const result = initializeBootstrap(deps) as ReturnType<typeof initializeBootstrap> & {
      startServices: () => void;
    };

    // This should not throw - modules register their IPC handlers
    result.startServices();

    // Registry should have methods with IPC handlers
    expect(result.registry).toBeDefined();
  });
});

describe("bootstrap event flow", () => {
  let deps: BootstrapDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it("allows subscribing to events via registry.on()", () => {
    const result = initializeBootstrap(deps) as ReturnType<typeof initializeBootstrap> & {
      startServices: () => void;
    };
    result.startServices();

    const handler = vi.fn();
    const unsubscribe = result.registry.on("project:opened", handler);

    // Emit an event
    result.registry.emit("project:opened", {
      project: {
        id: "test-id" as never,
        name: "test",
        path: "/test",
        workspaces: [],
      },
    });

    expect(handler).toHaveBeenCalledOnce();

    // Unsubscribe
    unsubscribe();

    // Emit again
    result.registry.emit("project:opened", {
      project: {
        id: "test-id" as never,
        name: "test",
        path: "/test",
        workspaces: [],
      },
    });

    // Handler should not be called again
    expect(handler).toHaveBeenCalledOnce();
  });
});
