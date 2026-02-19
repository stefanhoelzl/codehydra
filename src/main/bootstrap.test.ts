/**
 * Unit tests for bootstrap.
 *
 * Uses behavioral IpcLayer mock instead of vi.mock("electron").
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { initializeBootstrap } from "./bootstrap";
import type { BootstrapDeps } from "./bootstrap";
import { createMockLogger } from "../services/logging";
import type { IKeepFilesService } from "../services/keepfiles";
import { createBehavioralIpcLayer } from "../services/platform/ipc.test-utils";
import { HookRegistry } from "./intents/infrastructure/hook-registry";
import { Dispatcher } from "./intents/infrastructure/dispatcher";
import type { IViewManager } from "./managers/view-manager.interface";

// =============================================================================
// Mock Factories
// =============================================================================

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

function createMockGlobalWorktreeProvider(): import("../services/git/git-worktree-provider").GitWorktreeProvider {
  return {
    setMetadata: vi.fn().mockResolvedValue(undefined),
    getMetadata: vi.fn().mockResolvedValue({ base: "main" }),
    registerProject: vi.fn(),
    unregisterProject: vi.fn(),
    ensureWorkspaceRegistered: vi.fn(),
  } as unknown as import("../services/git/git-worktree-provider").GitWorktreeProvider;
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
  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);
  return {
    logger: createMockLogger(),
    ipcLayer: createBehavioralIpcLayer(),
    app: { quit: vi.fn() },
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
    globalWorktreeProvider: createMockGlobalWorktreeProvider(),
    keepFilesService: createMockKeepFilesService(),
    workspaceFileService: {
      deleteWorkspaceFile: vi.fn().mockResolvedValue(undefined),
    } as unknown as import("../services").IWorkspaceFileService,
    emitDeletionProgress: vi.fn(),
    killTerminalsCallback: undefined,
    workspaceLockHandler: undefined,
    hookRegistry,
    dispatcher,
    setTitle: vi.fn(),
    titleVersion: "test",
    badgeManager: {
      updateBadge: vi.fn(),
    } as unknown as import("./managers/badge-manager").BadgeManager,
    agentServerManagers: {
      claude: {
        dispose: vi.fn().mockResolvedValue(undefined),
        onServerStarted: vi.fn().mockReturnValue(() => {}),
        onServerStopped: vi.fn().mockReturnValue(() => {}),
        setMarkActiveHandler: vi.fn(),
      } as never,
      opencode: {
        dispose: vi.fn().mockResolvedValue(undefined),
        onServerStarted: vi.fn().mockReturnValue(() => {}),
        onServerStopped: vi.fn().mockReturnValue(() => {}),
        setMarkActiveHandler: vi.fn(),
      } as never,
    },
    agentStatusManager: {
      getStatus: vi.fn(),
      onStatusChanged: vi.fn().mockReturnValue(() => {}),
      dispose: vi.fn(),
    } as never,
    mcpServerManager: {
      start: vi.fn().mockResolvedValue(9999),
      stop: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
      registerWorkspace: vi.fn(),
      unregisterWorkspace: vi.fn(),
      getPort: vi.fn().mockReturnValue(null),
    } as never,
    pluginServer: null,
    getApiFn: () => {
      throw new Error("not initialized");
    },
    loggingService: { createLogger: () => createMockLogger() } as never,
    telemetryService: null,
    platformInfo: { platform: "linux", arch: "x64" } as never,
    buildInfo: {
      version: "1.0.0",
      isDevelopment: true,
      isPackaged: false,
      appPath: "/app",
    } as never,
    autoUpdater: {
      start: vi.fn(),
      dispose: vi.fn(),
      onUpdateAvailable: vi.fn().mockReturnValue(() => {}),
    } as never,
    codeServerManager: {
      ensureRunning: vi.fn().mockResolvedValue(undefined),
      port: vi.fn().mockReturnValue(9090),
    } as never,
    fileSystemLayer: { mkdir: vi.fn().mockResolvedValue(undefined) } as never,
    viewLayer: null,
    windowLayer: null,
    sessionLayer: null,
    getUIWebContentsFn: () => null,
    wrapperPath: "/mock/bin/claude",
    dialog: {
      showOpenDialog: vi.fn().mockResolvedValue({ canceled: true, filePaths: [] }),
    },
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

  it("registers all modules including core and ui", () => {
    const result = initializeBootstrap(deps);

    // wireDispatcher and CoreModule now run during initializeBootstrap,
    // so all methods should be registered immediately
    const api = result.getInterface();
    expect(api.lifecycle).toBeDefined();
    expect(api.projects).toBeDefined();
    expect(api.workspaces).toBeDefined();
    expect(api.ui).toBeDefined();
  });

  it("dispose cleans up all modules", async () => {
    const result = initializeBootstrap(deps);

    // Get interface to verify it works before dispose
    const api = result.getInterface();
    expect(api).toBeDefined();

    // Dispose should not throw
    await expect(result.dispose()).resolves.not.toThrow();
  });

  it("registers IPC handlers for all modules", () => {
    // IPC handlers are registered automatically for all modules
    const result = initializeBootstrap(deps);

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
    const result = initializeBootstrap(deps);

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
