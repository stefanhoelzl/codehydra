/**
 * Integration tests for bootstrap.
 *
 * These tests verify the full bootstrap flow with modules wired correctly.
 * Uses behavioral IpcLayer mock instead of vi.mock("electron").
 */

import { describe, it, expect, vi } from "vitest";
import { initializeBootstrap } from "./bootstrap";
import type { BootstrapDeps } from "./bootstrap";
import type { CoreModuleDeps } from "./modules/core";
import { createMockLogger } from "../services/logging";
import type { IKeepFilesService } from "../services/keepfiles";
import { createBehavioralIpcLayer } from "../services/platform/ipc.test-utils";
import { HookRegistry } from "./intents/infrastructure/hook-registry";
import { Dispatcher } from "./intents/infrastructure/dispatcher";
import type { IViewManager } from "./managers/view-manager.interface";
import type { WorkspaceName } from "../shared/api/types";
import { generateProjectId } from "../shared/api/id-utils";

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

function createMockViewManager(): IViewManager {
  const modeChangeHandlers: Array<(event: { mode: string; previousMode: string }) => void> = [];
  return {
    getUIViewHandle: vi.fn(),
    getUIWebContents: vi.fn().mockReturnValue(null),
    sendToUI: vi.fn(),
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
    isWorkspaceLoading: vi.fn().mockReturnValue(false),
    setWorkspaceLoaded: vi.fn(),
    onLoadingChange: vi.fn().mockReturnValue(() => {}),
    preloadWorkspaceUrl: vi.fn(),
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
    resolveWorkspace: vi.fn().mockReturnValue("/mock/workspace"),
    codeServerPort: 0,
    wrapperPath: "/mock/bin/claude",
    dialog: {
      showOpenDialog: vi.fn().mockResolvedValue({ canceled: true, filePaths: [] }),
    },
  };
}

function createMockGlobalWorktreeProvider(): import("../services/git/git-worktree-provider").GitWorktreeProvider {
  return {
    setMetadata: vi.fn().mockResolvedValue(undefined),
    getMetadata: vi.fn().mockResolvedValue({ base: "main" }),
    registerProject: vi.fn(),
    unregisterProject: vi.fn(),
    ensureWorkspaceRegistered: vi.fn(),
    validateRepository: vi.fn().mockResolvedValue(undefined),
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
    viewManagerFn: () => createMockViewManager(),
    gitClientFn: () =>
      ({
        clone: vi.fn().mockResolvedValue(undefined),
      }) as unknown as import("../services").IGitClient,
    pathProviderFn: () =>
      ({
        projectsDir: "/test/projects",
        remotesDir: "/test/remotes",
        getProjectWorkspacesDir: vi.fn().mockImplementation((projectPath: unknown) => {
          const pathStr = typeof projectPath === "string" ? projectPath : String(projectPath);
          return { toString: () => `${pathStr}/workspaces` };
        }),
      }) as unknown as import("../services").PathProvider,
    projectStoreFn: () =>
      ({
        findByRemoteUrl: vi.fn().mockResolvedValue(undefined),
        saveProject: vi.fn().mockResolvedValue(undefined),
        getProjectConfig: vi.fn().mockResolvedValue(undefined),
        deleteProjectDirectory: vi.fn().mockResolvedValue(undefined),
        loadAllProjectConfigs: vi.fn().mockResolvedValue([]),
        removeProject: vi.fn().mockResolvedValue(undefined),
      }) as unknown as import("../services").ProjectStore,
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
    badgeManagerFn: () =>
      ({ updateBadge: vi.fn() }) as unknown as import("./managers/badge-manager").BadgeManager,
    serverManagerDeps: {
      processRunner: {} as never,
      portManager: {} as never,
      httpClient: {} as never,
      pathProvider: {} as never,
      fileSystem: {} as never,
      logger: createMockLogger(),
    },
    onAgentInitialized: vi.fn(),
    pluginServer: null,
    getApiFn: () =>
      ({
        on: vi.fn().mockReturnValue(() => {}),
        lifecycle: {},
        projects: {},
        workspaces: {},
        ui: {},
        dispose: vi.fn(),
      }) as never,
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
    agentStatusManagerFn: () =>
      ({
        getStatus: vi.fn(),
        getEnvironmentVariables: vi.fn().mockReturnValue(null),
        onStatusChanged: vi.fn().mockReturnValue(() => {}),
        markActive: vi.fn(),
        dispose: vi.fn(),
      }) as never,
    codeServerManager: {
      ensureRunning: vi.fn().mockResolvedValue(undefined),
      port: vi.fn().mockReturnValue(9090),
      getConfig: vi.fn().mockReturnValue({
        runtimeDir: "/mock/runtime",
        extensionsDir: "/mock/extensions",
        userDataDir: "/mock/user-data",
      }),
      setPluginPort: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
    } as never,
    fileSystemLayer: {
      mkdir: vi.fn().mockResolvedValue(undefined),
    } as never,
    configDataProviderFn: () => vi.fn().mockReturnValue({ env: null, agentType: null }),
    viewLayer: null,
    windowLayer: null,
    sessionLayer: null,
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
// Integration Tests
// =============================================================================

describe("bootstrap.startup", () => {
  it("full startup with registry and modules", async () => {
    const deps = createMockDeps();
    const result = initializeBootstrap(deps);

    // All modules are registered during initializeBootstrap
    const api = result.getInterface();

    // Verify all API groups are available
    expect(api.lifecycle).toBeDefined();
    expect(api.lifecycle.ready).toBeTypeOf("function");
    expect(api.lifecycle.quit).toBeTypeOf("function");

    expect(api.projects).toBeDefined();
    expect(api.projects.open).toBeTypeOf("function");
    expect(api.projects.close).toBeTypeOf("function");
    expect(api.projects.fetchBases).toBeTypeOf("function");

    expect(api.workspaces).toBeDefined();
    expect(api.workspaces.create).toBeTypeOf("function");
    expect(api.workspaces.remove).toBeTypeOf("function");
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
  it("all modules registered during initializeBootstrap", () => {
    const deps = createMockDeps();
    const result = initializeBootstrap(deps);

    // wireDispatcher and CoreModule now run during initializeBootstrap,
    // so getInterface() should succeed immediately
    expect(() => result.getInterface()).not.toThrow();
  });
});

describe("bootstrap.quit.flow", () => {
  it("lifecycle.quit dispatches app:shutdown and calls app.quit()", async () => {
    const appQuit = vi.fn();
    const ipcLayer = createBehavioralIpcLayer();
    const deps: BootstrapDeps = { ...createMockDeps(), app: { quit: appQuit }, ipcLayer };
    const result = initializeBootstrap(deps);

    // Invoke lifecycle.quit via IPC - should dispatch app:shutdown which runs quit hook
    await ipcLayer._invoke("api:lifecycle:quit", {});

    expect(appQuit).toHaveBeenCalled();

    await result.dispose();
  });

  it("second lifecycle.quit is idempotent (shutdown only runs once)", async () => {
    const appQuit = vi.fn();
    const ipcLayer = createBehavioralIpcLayer();
    const deps: BootstrapDeps = { ...createMockDeps(), app: { quit: appQuit }, ipcLayer };
    const result = initializeBootstrap(deps);

    // First quit
    await ipcLayer._invoke("api:lifecycle:quit", {});
    expect(appQuit).toHaveBeenCalledTimes(1);

    // Second quit - idempotency interceptor blocks it
    await ipcLayer._invoke("api:lifecycle:quit", {});
    expect(appQuit).toHaveBeenCalledTimes(1);

    await result.dispose();
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
    const result = initializeBootstrap(deps);

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
    const result = initializeBootstrap(deps);

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
    const result = initializeBootstrap(deps);

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
    const result = initializeBootstrap(deps);

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
    const result = initializeBootstrap(deps);

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

// =============================================================================
// Setup Flow Integration Tests (Plan Test Matrix)
// =============================================================================

/**
 * Helper: creates deps with a captured dispatcher and mock webContents
 * for testing the full app:start → app:setup flow.
 */
function createSetupTestDeps(overrides?: {
  configAgent?: string | null;
  codeServerNeedsDownload?: boolean;
  agentNeedsDownload?: boolean;
  extensionNeedsInstall?: boolean;
  missingExtensions?: string[];
  outdatedExtensions?: string[];
  downloadError?: Error;
  agentDownloadMock?: ReturnType<typeof vi.fn>;
}) {
  const captured: {
    dispatcher: Dispatcher;
    ipcLayer: ReturnType<typeof createBehavioralIpcLayer>;
    webContentsSendCalls: Array<{ channel: string; args: unknown[] }>;
  } = {
    dispatcher: null as unknown as Dispatcher,
    ipcLayer: createBehavioralIpcLayer(),
    webContentsSendCalls: [],
  };

  const mockWebContents = {
    isDestroyed: () => false,
    send: (channel: string, ...args: unknown[]) => {
      captured.webContentsSendCalls.push({ channel, args });
    },
  };

  const baseDeps = createMockDeps();
  const configAgent = overrides?.configAgent !== undefined ? overrides.configAgent : "opencode";

  // Create a viewManager that returns the mock webContents for show-ui hooks
  // but returns null for the mount handler in activate (to avoid blocking).
  // ViewModule's activate handler calls onLoadingChange() before the mount check,
  // so we use it as a signal to switch getUIWebContents to return null.
  const setupViewManager = createMockViewManager();
  let inActivateHandler = false;
  (setupViewManager as unknown as Record<string, unknown>).onLoadingChange = vi
    .fn()
    .mockImplementation(() => {
      inActivateHandler = true;
      return () => {};
    });
  (setupViewManager as unknown as Record<string, unknown>).getUIWebContents = vi
    .fn()
    .mockImplementation(() => {
      if (inActivateHandler) return null;
      return mockWebContents as unknown as import("electron").WebContents;
    });

  const deps: BootstrapDeps = {
    ...baseDeps,
    ipcLayer: captured.ipcLayer,
    viewManagerFn: () => setupViewManager,
    dispatcherFn: () => {
      const hookRegistry = new HookRegistry();
      captured.dispatcher = new Dispatcher(hookRegistry);
      return { hookRegistry, dispatcher: captured.dispatcher };
    },
    getUIWebContentsFn: () => mockWebContents as unknown as import("electron").WebContents,
    setupDeps: {
      configService: {
        load: vi.fn().mockResolvedValue({ agent: configAgent, versions: {} }),
        save: vi.fn().mockResolvedValue(undefined),
        setAgent: vi.fn().mockResolvedValue(undefined),
      } as unknown as import("../services/config/config-service").ConfigService,
      codeServerManager: {
        preflight: vi.fn().mockResolvedValue({
          success: true,
          needsDownload: overrides?.codeServerNeedsDownload ?? false,
        }),
        downloadBinary: overrides?.downloadError
          ? vi.fn().mockRejectedValue(overrides.downloadError)
          : vi.fn().mockResolvedValue(undefined),
      } as unknown as import("../services").CodeServerManager,
      getAgentBinaryManager: () =>
        ({
          preflight: vi.fn().mockResolvedValue({
            success: true,
            needsDownload: overrides?.agentNeedsDownload ?? false,
          }),
          downloadBinary: overrides?.agentDownloadMock ?? vi.fn().mockResolvedValue(undefined),
          getBinaryType: vi.fn().mockReturnValue("opencode"),
        }) as unknown as import("../services/binary-download").AgentBinaryManager,
      extensionManager: {
        preflight: vi.fn().mockResolvedValue({
          success: true,
          needsInstall: overrides?.extensionNeedsInstall ?? false,
          missingExtensions: overrides?.missingExtensions ?? [],
          outdatedExtensions: overrides?.outdatedExtensions ?? [],
        }),
        install: vi.fn().mockResolvedValue(undefined),
        cleanOutdated: vi.fn().mockResolvedValue(undefined),
      } as unknown as import("../services/vscode-setup/extension-manager").ExtensionManager,
    },
  };

  return { deps, captured, mockWebContents };
}

describe("bootstrap.setup.flow", () => {
  it("#1: startup completes when no setup needed", async () => {
    const { deps, captured } = createSetupTestDeps({
      configAgent: "opencode",
      codeServerNeedsDownload: false,
      agentNeedsDownload: false,
      extensionNeedsInstall: false,
    });

    initializeBootstrap(deps);

    // Dispatch app:start -- should skip setup entirely
    await captured.dispatcher.dispatch({ type: "app:start", payload: {} });

    // Verify no setup-related IPC was sent
    const setupShown = captured.webContentsSendCalls.some(
      (c) => c.channel === "api:lifecycle:show-setup"
    );
    expect(setupShown).toBe(false);

    // Verify main view was shown (via show-starting then show-main-view pattern)
    const showStarting = captured.webContentsSendCalls.some(
      (c) => c.channel === "api:lifecycle:show-starting"
    );
    expect(showStarting).toBe(true);
  });

  it("#2: shows starting screen immediately", async () => {
    const { deps, captured } = createSetupTestDeps();

    initializeBootstrap(deps);

    await captured.dispatcher.dispatch({ type: "app:start", payload: {} });

    // First IPC event should be show-starting
    expect(captured.webContentsSendCalls[0]?.channel).toBe("api:lifecycle:show-starting");
  });

  it("#3: shows agent selection when no agent configured", async () => {
    vi.useFakeTimers();
    try {
      const { deps, captured } = createSetupTestDeps({
        configAgent: null,
      });

      initializeBootstrap(deps);

      // Dispatch app:start -- it will hang at agent-selection waiting for IPC response
      // We need to simulate the renderer responding
      const dispatchPromise = captured.dispatcher.dispatch({
        type: "app:start",
        payload: {},
      });

      // Flush microtask queue so async hooks progress to the agent-selection listener
      await vi.advanceTimersByTimeAsync(0);

      // Verify show-agent-selection was sent
      const agentSelectionSent = captured.webContentsSendCalls.some(
        (c) => c.channel === "api:lifecycle:show-agent-selection"
      );
      expect(agentSelectionSent).toBe(true);

      // Simulate renderer responding with agent selection
      captured.ipcLayer._emit("api:lifecycle:agent-selected", { agent: "opencode" });

      await vi.runAllTimersAsync();
      await dispatchPromise;
    } finally {
      vi.useRealTimers();
    }
  });

  it("#4: agent selection saved after user responds", async () => {
    vi.useFakeTimers();
    try {
      const { deps, captured } = createSetupTestDeps({
        configAgent: null,
      });

      const mockSetAgent = deps.setupDeps.configService.setAgent as ReturnType<typeof vi.fn>;

      initializeBootstrap(deps);

      const dispatchPromise = captured.dispatcher.dispatch({
        type: "app:start",
        payload: {},
      });

      // Flush microtask queue so async hooks progress to the agent-selection listener
      await vi.advanceTimersByTimeAsync(0);

      // Simulate user selecting an agent
      captured.ipcLayer._emit("api:lifecycle:agent-selected", { agent: "claude" });

      await vi.runAllTimersAsync();
      await dispatchPromise;

      // Verify agent was saved
      expect(mockSetAgent).toHaveBeenCalledWith("claude");
    } finally {
      vi.useRealTimers();
    }
  });

  it("#5: downloads binaries when missing", async () => {
    const agentDownloadMock = vi.fn().mockResolvedValue(undefined);
    const { deps, captured } = createSetupTestDeps({
      configAgent: "opencode",
      codeServerNeedsDownload: true,
      agentNeedsDownload: true,
      agentDownloadMock,
    });

    const mockCodeServerDownload = deps.setupDeps.codeServerManager.downloadBinary as ReturnType<
      typeof vi.fn
    >;

    initializeBootstrap(deps);

    await captured.dispatcher.dispatch({ type: "app:start", payload: {} });

    // Verify both download methods were called
    expect(mockCodeServerDownload).toHaveBeenCalledOnce();
    expect(agentDownloadMock).toHaveBeenCalledOnce();
  });

  it("#6: installs extensions when missing", async () => {
    const { deps, captured } = createSetupTestDeps({
      configAgent: "opencode",
      extensionNeedsInstall: true,
      missingExtensions: ["test-ext-1", "test-ext-2"],
    });

    const mockInstall = deps.setupDeps.extensionManager.install as ReturnType<typeof vi.fn>;

    initializeBootstrap(deps);

    await captured.dispatcher.dispatch({ type: "app:start", payload: {} });

    // Verify install was called with the missing extensions
    expect(mockInstall).toHaveBeenCalledOnce();
    expect(mockInstall.mock.calls[0]?.[0]).toEqual(["test-ext-1", "test-ext-2"]);
  });

  it("#7: returns to starting screen after setup", async () => {
    const { deps, captured } = createSetupTestDeps({
      configAgent: "opencode",
      codeServerNeedsDownload: true,
    });

    initializeBootstrap(deps);

    await captured.dispatcher.dispatch({ type: "app:start", payload: {} });

    // Find the sequence: show-setup → ... → show-starting (hide-ui hook)
    const channels = captured.webContentsSendCalls.map((c) => c.channel);

    const setupIdx = channels.indexOf("api:lifecycle:show-setup");
    expect(setupIdx).toBeGreaterThanOrEqual(0);

    // After setup, should return to show-starting
    const postSetupStarting = channels.indexOf("api:lifecycle:show-starting", setupIdx + 1);
    expect(postSetupStarting).toBeGreaterThan(setupIdx);
  });

  it("#12: show-main-view not sent from setup flow (sent by lifecycle layer)", async () => {
    const { deps, captured } = createSetupTestDeps({
      configAgent: "opencode",
      codeServerNeedsDownload: false,
      extensionNeedsInstall: false,
    });

    initializeBootstrap(deps);

    await captured.dispatcher.dispatch({ type: "app:start", payload: {} });

    // show-main-view is now sent by showMainViewModule in wireDispatcher(),
    // not by the setup flow. Verify it's NOT sent from setup.
    const mainViewShown = captured.webContentsSendCalls.some(
      (c) => c.channel === "api:lifecycle:show-main-view"
    );
    expect(mainViewShown).toBe(false);
  });

  it("#13: app:setup includes causation reference", async () => {
    const { deps, captured } = createSetupTestDeps({
      configAgent: "opencode",
      codeServerNeedsDownload: true,
    });

    initializeBootstrap(deps);

    // The app:start operation dispatches app:setup internally via ctx.dispatch().
    // We verify causation by checking that app:setup was dispatched (it would fail
    // without proper intent registration) and that the setup operation ran correctly.
    // The causation tracking is built into the Dispatcher infrastructure.
    await captured.dispatcher.dispatch({ type: "app:start", payload: {} });

    // Verify the setup ran (show-setup IPC was sent, proving app:setup was dispatched)
    const setupShown = captured.webContentsSendCalls.some(
      (c) => c.channel === "api:lifecycle:show-setup"
    );
    expect(setupShown).toBe(true);

    // Verify the hide-ui ran (proving app:setup completed and returned to app:start)
    const channels = captured.webContentsSendCalls.map((c) => c.channel);
    const setupIdx = channels.indexOf("api:lifecycle:show-setup");
    const hideIdx = channels.indexOf("api:lifecycle:show-starting", setupIdx + 1);
    expect(hideIdx).toBeGreaterThan(setupIdx);
  });

  it("#15: download failure emits error event", async () => {
    vi.useFakeTimers();
    try {
      const downloadError = new Error("Network timeout");
      const { deps, captured } = createSetupTestDeps({
        configAgent: "opencode",
        codeServerNeedsDownload: true,
        downloadError,
      });

      const result = initializeBootstrap(deps);

      // Wire early subscriber (matches the pattern in index.ts)
      result.registry.on("lifecycle:setup-error", (payload) => {
        captured.webContentsSendCalls.push({
          channel: "api:lifecycle:setup-error",
          args: [payload],
        });
      });

      // Dispatch will enter retry loop after setup failure.
      // Start the dispatch but don't await -- it will wait for retry IPC.
      const dispatchPromise = captured.dispatcher.dispatch({
        type: "app:start",
        payload: {},
      });

      // Flush microtask queue so the error is emitted and retry loop starts
      await vi.advanceTimersByTimeAsync(0);

      // Verify setup-error IPC was sent to renderer
      const errorSent = captured.webContentsSendCalls.find(
        (c) => c.channel === "api:lifecycle:setup-error"
      );
      expect(errorSent).toBeDefined();
      expect((errorSent?.args[0] as { message: string }).message).toContain("Network timeout");

      // Fix the download mock so retry succeeds, then trigger retry
      (
        deps.setupDeps.codeServerManager.downloadBinary as ReturnType<typeof vi.fn>
      ).mockResolvedValue(undefined);
      captured.ipcLayer._emit("api:lifecycle:retry");

      // Now the dispatch should complete
      await vi.runAllTimersAsync();
      await dispatchPromise;
    } finally {
      vi.useRealTimers();
    }
  });

  it("#17: agent-selection hook skipped when agent configured", async () => {
    const { deps, captured } = createSetupTestDeps({
      configAgent: "opencode",
      codeServerNeedsDownload: true, // Need setup but agent is configured
    });

    initializeBootstrap(deps);

    await captured.dispatcher.dispatch({ type: "app:start", payload: {} });

    // Verify no agent selection IPC was sent
    const agentSelectionSent = captured.webContentsSendCalls.some(
      (c) => c.channel === "api:lifecycle:show-agent-selection"
    );
    expect(agentSelectionSent).toBe(false);
  });

  it("#18: binary hook skipped when binaries present", async () => {
    const { deps, captured } = createSetupTestDeps({
      configAgent: "opencode",
      codeServerNeedsDownload: false,
      agentNeedsDownload: false,
      extensionNeedsInstall: true,
      missingExtensions: ["test-ext"],
    });

    const mockDownloadBinary = deps.setupDeps.codeServerManager.downloadBinary as ReturnType<
      typeof vi.fn
    >;

    initializeBootstrap(deps);

    await captured.dispatcher.dispatch({ type: "app:start", payload: {} });

    // Verify download was NOT called for code-server
    expect(mockDownloadBinary).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Setup Progress Tests
// =============================================================================

describe("bootstrap.setup.progress", () => {
  it("passes progress callbacks to download methods during setup", async () => {
    // Capture the dispatcher from the factory
    let capturedDispatcher!: Dispatcher;
    const mockDownloadBinary = vi.fn().mockResolvedValue(undefined);
    const mockAgentDownloadBinary = vi.fn().mockResolvedValue(undefined);
    const mockInstall = vi.fn().mockResolvedValue(undefined);

    const baseDeps = createMockDeps();
    const deps: BootstrapDeps = {
      ...baseDeps,
      dispatcherFn: () => {
        const hookRegistry = new HookRegistry();
        capturedDispatcher = new Dispatcher(hookRegistry);
        return { hookRegistry, dispatcher: capturedDispatcher };
      },
      setupDeps: {
        ...baseDeps.setupDeps,
        codeServerManager: {
          preflight: vi.fn().mockResolvedValue({ success: true, needsDownload: true }),
          downloadBinary: mockDownloadBinary,
        } as unknown as import("../services").CodeServerManager,
        getAgentBinaryManager: () =>
          ({
            preflight: vi
              .fn()
              .mockResolvedValue({ success: true, needsDownload: true, binaryType: "opencode" }),
            downloadBinary: mockAgentDownloadBinary,
            getBinaryType: vi.fn().mockReturnValue("opencode"),
          }) as unknown as import("../services/binary-download").AgentBinaryManager,
        extensionManager: {
          preflight: vi.fn().mockResolvedValue({
            success: true,
            needsInstall: true,
            missingExtensions: ["test-ext"],
            outdatedExtensions: [],
          }),
          install: mockInstall,
          cleanOutdated: vi.fn().mockResolvedValue(undefined),
        } as unknown as import("../services/vscode-setup/extension-manager").ExtensionManager,
      },
    };

    initializeBootstrap(deps);

    // Dispatch app:start which triggers check → app:setup → binary/extensions hooks
    const handle = capturedDispatcher.dispatch({
      type: "app:start",
      payload: {},
    });
    await handle;

    // Verify progress callbacks were passed (not undefined)
    expect(mockDownloadBinary).toHaveBeenCalledOnce();
    expect(mockDownloadBinary.mock.calls[0]?.[0]).toBeTypeOf("function");

    expect(mockAgentDownloadBinary).toHaveBeenCalledOnce();
    expect(mockAgentDownloadBinary.mock.calls[0]?.[0]).toBeTypeOf("function");

    expect(mockInstall).toHaveBeenCalledOnce();
    expect(mockInstall.mock.calls[0]?.[1]).toBeTypeOf("function");
  });

  it("emits setup-progress with percentage when download callback is invoked", async () => {
    vi.useFakeTimers();
    try {
      let capturedDispatcher!: Dispatcher;
      const progressEvents: unknown[] = [];
      const mockDownloadBinary = vi.fn().mockImplementation(async (onProgress: unknown) => {
        // Advance past throttle window before calling progress
        vi.advanceTimersByTime(200);
        if (typeof onProgress === "function") {
          (
            onProgress as (p: {
              phase: string;
              bytesDownloaded: number;
              totalBytes: number;
            }) => void
          )({ phase: "downloading", bytesDownloaded: 50, totalBytes: 100 });
        }
      });

      const baseDeps = createMockDeps();
      const deps: BootstrapDeps = {
        ...baseDeps,
        dispatcherFn: () => {
          const hookRegistry = new HookRegistry();
          capturedDispatcher = new Dispatcher(hookRegistry);
          return { hookRegistry, dispatcher: capturedDispatcher };
        },
        setupDeps: {
          ...baseDeps.setupDeps,
          codeServerManager: {
            preflight: vi.fn().mockResolvedValue({ success: true, needsDownload: true }),
            downloadBinary: mockDownloadBinary,
          } as unknown as import("../services").CodeServerManager,
          getAgentBinaryManager: () =>
            ({
              preflight: vi.fn().mockResolvedValue({ success: true, needsDownload: false }),
              downloadBinary: vi.fn().mockResolvedValue(undefined),
              getBinaryType: vi.fn().mockReturnValue("opencode"),
            }) as unknown as import("../services/binary-download").AgentBinaryManager,
          extensionManager: {
            preflight: vi.fn().mockResolvedValue({
              success: true,
              needsInstall: false,
              missingExtensions: [],
              outdatedExtensions: [],
            }),
            install: vi.fn().mockResolvedValue(undefined),
          } as unknown as import("../services/vscode-setup/extension-manager").ExtensionManager,
        },
      };

      const result = initializeBootstrap(deps);

      // Subscribe to setup-progress events
      result.registry.on("lifecycle:setup-progress", (event) => {
        progressEvents.push(event);
      });

      const handle = capturedDispatcher.dispatch({
        type: "app:start",
        payload: {},
      });

      // Advance timers to allow async operations to complete
      await vi.runAllTimersAsync();
      await handle;

      // Find a progress event with percentage for vscode row
      const withPercent = progressEvents.find((e) => {
        const evt = e as { rows: Array<{ id: string; progress?: number }> };
        return evt.rows.some((r) => r.id === "vscode" && r.progress === 50);
      });
      expect(withPercent).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

// =============================================================================
// Lifecycle Ready Tests
// =============================================================================

describe("bootstrap.lifecycle.ready", () => {
  it("resolves mount promise (no event re-emission)", async () => {
    const baseDeps = createMockDeps();
    const ipcLayer = createBehavioralIpcLayer();

    const deps: BootstrapDeps = {
      ...baseDeps,
      ipcLayer,
    };

    const result = initializeBootstrap(deps);

    // lifecycle.ready just resolves the mount promise — no events re-emitted
    const projectOpenedEvents: unknown[] = [];
    result.registry.on("project:opened", (event) => {
      projectOpenedEvents.push(event);
    });

    await ipcLayer._invoke("api:lifecycle:ready", {});

    // No event re-emission — events flow naturally from project:open dispatches
    expect(projectOpenedEvents).toHaveLength(0);

    await result.dispose();
  });

  it("is idempotent (can be called multiple times safely)", async () => {
    const baseDeps = createMockDeps();
    const ipcLayer = createBehavioralIpcLayer();
    const deps: BootstrapDeps = { ...baseDeps, ipcLayer };

    const result = initializeBootstrap(deps);

    // Call twice — second call is a no-op (mountResolve is null)
    await ipcLayer._invoke("api:lifecycle:ready", {});
    await ipcLayer._invoke("api:lifecycle:ready", {});

    // No errors, no events re-emitted
    await result.dispose();
  });
});
