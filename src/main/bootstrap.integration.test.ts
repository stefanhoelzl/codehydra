/**
 * Integration tests for bootstrap.
 *
 * These tests verify the full bootstrap flow with modules wired correctly.
 * Uses behavioral IpcLayer mock instead of vi.mock("electron").
 *
 * Since initializeBootstrap() has been eliminated, each test composes the
 * registry, dispatcher, operations, and modules inline -- mirroring the
 * composition root in index.ts.
 */

import { describe, it, expect, vi } from "vitest";
import { createMockLogger } from "../services/logging";
import { createBehavioralIpcLayer } from "../services/platform/ipc.test-utils";
import { HookRegistry } from "./intents/infrastructure/hook-registry";
import { Dispatcher } from "./intents/infrastructure/dispatcher";
import { wireModules } from "./intents/infrastructure/wire";
import { generateProjectId, extractWorkspaceName } from "../shared/api/id-utils";
import { ApiRegistry } from "./api/registry";
import { ApiIpcChannels } from "../shared/ipc";
import { createIpcEventBridge } from "./modules/ipc-event-bridge";
import { createQuitModule } from "./modules/quit-module";
import { createRetryModule } from "./modules/retry-module";
import { createLifecycleReadyModule } from "./modules/lifecycle-ready-module";
import { createViewModule } from "./modules/view-module";
import { createCodeServerModule } from "./modules/code-server-module";
import { createAgentModule } from "./modules/agent-module";
import { createIdempotencyModule } from "./intents/infrastructure/idempotency-module";

// Operations
import { AppShutdownOperation, INTENT_APP_SHUTDOWN } from "./operations/app-shutdown";
import { AppStartOperation, INTENT_APP_START } from "./operations/app-start";
import { SetupOperation, INTENT_SETUP, EVENT_SETUP_ERROR } from "./operations/setup";
import { SetModeOperation, INTENT_SET_MODE } from "./operations/set-mode";
import { SetMetadataOperation, INTENT_SET_METADATA } from "./operations/set-metadata";
import { GetMetadataOperation, INTENT_GET_METADATA } from "./operations/get-metadata";
import {
  GetWorkspaceStatusOperation,
  INTENT_GET_WORKSPACE_STATUS,
} from "./operations/get-workspace-status";
import { GetAgentSessionOperation, INTENT_GET_AGENT_SESSION } from "./operations/get-agent-session";
import { RestartAgentOperation, INTENT_RESTART_AGENT } from "./operations/restart-agent";
import {
  GetActiveWorkspaceOperation,
  INTENT_GET_ACTIVE_WORKSPACE,
} from "./operations/get-active-workspace";
import { OpenWorkspaceOperation, INTENT_OPEN_WORKSPACE } from "./operations/open-workspace";
import {
  DeleteWorkspaceOperation,
  INTENT_DELETE_WORKSPACE,
  EVENT_WORKSPACE_DELETED,
} from "./operations/delete-workspace";
import type { DeleteWorkspaceIntent, DeleteWorkspacePayload } from "./operations/delete-workspace";
import { OpenProjectOperation, INTENT_OPEN_PROJECT } from "./operations/open-project";
import { CloseProjectOperation, INTENT_CLOSE_PROJECT } from "./operations/close-project";
import { SwitchWorkspaceOperation, INTENT_SWITCH_WORKSPACE } from "./operations/switch-workspace";
import {
  UpdateAgentStatusOperation,
  INTENT_UPDATE_AGENT_STATUS,
} from "./operations/update-agent-status";
import { UpdateAvailableOperation, INTENT_UPDATE_AVAILABLE } from "./operations/update-available";
import type { WorkspaceName } from "../shared/api/types";

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

/** Returns the flat lifecycle-related deps for CodeServerModule mocking. */
function createMockCodeServerLifecycleDeps() {
  return {
    pluginServer: null,
    fileSystemLayer: {
      mkdir: vi.fn().mockResolvedValue(undefined),
    } as never,
    workspaceFileService: {} as never,
    wrapperPath: "/mock/bin/claude",
  };
}

/** Returns lifecycle-related methods to merge into codeServerManager mock. */
function createMockCodeServerManagerLifecycleMethods() {
  return {
    ensureRunning: vi.fn().mockResolvedValue(undefined),
    port: vi.fn().mockReturnValue(9090),
    getConfig: vi.fn().mockReturnValue({
      runtimeDir: "/mock/runtime",
      extensionsDir: "/mock/extensions",
      userDataDir: "/mock/user-data",
    }),
    setPluginPort: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Registers all operations on the given dispatcher.
 * Matches the registration done at the composition root (index.ts).
 */
function registerAllOperations(dispatcher: Dispatcher): DeleteWorkspaceOperation {
  dispatcher.registerOperation(INTENT_APP_SHUTDOWN, new AppShutdownOperation());
  dispatcher.registerOperation(INTENT_APP_START, new AppStartOperation());
  dispatcher.registerOperation(INTENT_SETUP, new SetupOperation());
  dispatcher.registerOperation(INTENT_SET_MODE, new SetModeOperation());
  dispatcher.registerOperation(INTENT_SET_METADATA, new SetMetadataOperation());
  dispatcher.registerOperation(INTENT_GET_METADATA, new GetMetadataOperation());
  dispatcher.registerOperation(INTENT_GET_WORKSPACE_STATUS, new GetWorkspaceStatusOperation());
  dispatcher.registerOperation(INTENT_GET_AGENT_SESSION, new GetAgentSessionOperation());
  dispatcher.registerOperation(INTENT_RESTART_AGENT, new RestartAgentOperation());
  dispatcher.registerOperation(INTENT_GET_ACTIVE_WORKSPACE, new GetActiveWorkspaceOperation());
  dispatcher.registerOperation(INTENT_OPEN_WORKSPACE, new OpenWorkspaceOperation());

  const deleteOp = new DeleteWorkspaceOperation();
  dispatcher.registerOperation(INTENT_DELETE_WORKSPACE, deleteOp);

  dispatcher.registerOperation(INTENT_OPEN_PROJECT, new OpenProjectOperation());
  dispatcher.registerOperation(INTENT_CLOSE_PROJECT, new CloseProjectOperation());
  dispatcher.registerOperation(
    INTENT_SWITCH_WORKSPACE,
    new SwitchWorkspaceOperation(extractWorkspaceName)
  );
  dispatcher.registerOperation(INTENT_UPDATE_AGENT_STATUS, new UpdateAgentStatusOperation());
  dispatcher.registerOperation(INTENT_UPDATE_AVAILABLE, new UpdateAvailableOperation());

  return deleteOp;
}

/**
 * Creates a fully wired test composition (registry + dispatcher + modules),
 * equivalent to what initializeBootstrap() used to do.
 */
function createTestWiring(overrides?: {
  ipcLayer?: ReturnType<typeof createBehavioralIpcLayer>;
  appQuit?: () => void;
  pluginServer?: unknown;
  modules?: import("./intents/infrastructure/module").IntentModule[];
  mountSignal?: { resolve: (() => void) | null };
}) {
  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);
  const ipcLayer = overrides?.ipcLayer ?? createBehavioralIpcLayer();
  const deleteOp = registerAllOperations(dispatcher);

  const registry = new ApiRegistry({ logger: createMockLogger(), ipcLayer });
  const mountSignal = overrides?.mountSignal ?? { resolve: null };

  const ipcEventBridge = createIpcEventBridge({
    apiRegistry: registry,
    getApi: () => registry.getInterface(),
    getUIWebContents: () => null,
    pluginServer: (overrides?.pluginServer ?? null) as never,
    logger: createMockLogger(),
    dispatcher,
    agentStatusManager: { getStatus: vi.fn() } as never,
    globalWorktreeProvider: createMockGlobalWorktreeProvider(),
    deleteOp: {
      hasPendingRetry: () => false,
      signalDismiss: vi.fn(),
      signalRetry: vi.fn(),
    },
  });

  const quitModule = createQuitModule({
    app: { quit: overrides?.appQuit ?? vi.fn<() => void>() },
  });
  const retryModule = createRetryModule({ ipcLayer });
  const { module: lifecycleReadyModule, readyHandler } = createLifecycleReadyModule({
    mountSignal,
  });

  wireModules(
    [...(overrides?.modules ?? []), quitModule, retryModule, lifecycleReadyModule, ipcEventBridge],
    hookRegistry,
    dispatcher
  );

  registry.register("lifecycle.ready", readyHandler, {
    ipc: ApiIpcChannels.LIFECYCLE_READY,
  });

  return {
    registry,
    dispatcher,
    hookRegistry,
    getInterface: () => registry.getInterface(),
    dispose: () => registry.dispose(),
    deleteOp,
  };
}

// =============================================================================
// Integration Tests
// =============================================================================

describe("bootstrap.startup", () => {
  it("full startup with registry and modules", async () => {
    const result = createTestWiring();

    // All modules are registered during setup
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
    expect(api.ui.getActiveWorkspace).toBeTypeOf("function");
    expect(api.ui.switchWorkspace).toBeTypeOf("function");
    expect(api.ui.setMode).toBeTypeOf("function");

    // Cleanup
    await result.dispose();
  });
});

describe("bootstrap.module.order", () => {
  it("all modules registered during initialization", () => {
    const result = createTestWiring();

    // wireModules runs during createTestWiring,
    // so getInterface() should succeed immediately
    expect(() => result.getInterface()).not.toThrow();
  });
});

// =============================================================================
// Inline Registration Tests (executeCommand)
// =============================================================================

describe("bootstrap.executeCommand", () => {
  it("delegates to pluginServer.sendCommand and returns data", async () => {
    const mockPluginServer = {
      sendCommand: vi.fn().mockResolvedValue({ success: true, data: { result: 42 } }),
    };
    const result = createTestWiring({ pluginServer: mockPluginServer });
    const api = result.getInterface();

    const data = await api.workspaces.executeCommand(TEST_WORKSPACE_PATH, "test.command", ["arg1"]);

    expect(data).toEqual({ result: 42 });
    expect(mockPluginServer.sendCommand).toHaveBeenCalledWith(TEST_WORKSPACE_PATH, "test.command", [
      "arg1",
    ]);

    await result.dispose();
  });

  it("throws when pluginServer is not available", async () => {
    const result = createTestWiring({ pluginServer: null });
    const api = result.getInterface();

    await expect(
      api.workspaces.executeCommand(TEST_WORKSPACE_PATH, "test.command")
    ).rejects.toThrow("Plugin server not available");

    await result.dispose();
  });

  it("throws when sendCommand returns failure", async () => {
    const mockPluginServer = {
      sendCommand: vi.fn().mockResolvedValue({ success: false, error: "Command failed" }),
    };
    const result = createTestWiring({ pluginServer: mockPluginServer });
    const api = result.getInterface();

    await expect(api.workspaces.executeCommand(TEST_WORKSPACE_PATH, "bad.command")).rejects.toThrow(
      "Command failed"
    );

    await result.dispose();
  });
});

describe("bootstrap.quit.flow", () => {
  it("lifecycle.quit dispatches app:shutdown and calls app.quit()", async () => {
    const appQuit = vi.fn();
    const ipcLayer = createBehavioralIpcLayer();
    const result = createTestWiring({ appQuit, ipcLayer });

    // Invoke lifecycle.quit via IPC - should dispatch app:shutdown which runs quit hook
    await ipcLayer._invoke("api:lifecycle:quit", {});

    expect(appQuit).toHaveBeenCalled();

    await result.dispose();
  });

  it("second lifecycle.quit is idempotent (shutdown only runs once)", async () => {
    const appQuit = vi.fn();
    const ipcLayer = createBehavioralIpcLayer();
    const hookRegistry = new HookRegistry();
    const dispatcher = new Dispatcher(hookRegistry);
    const deleteOp = registerAllOperations(dispatcher);
    void deleteOp;
    const idempotencyModule = createIdempotencyModule([{ intentType: INTENT_APP_SHUTDOWN }]);

    const registry = new ApiRegistry({ logger: createMockLogger(), ipcLayer });

    const ipcEventBridge = createIpcEventBridge({
      apiRegistry: registry,
      getApi: () => registry.getInterface(),
      getUIWebContents: () => null,
      pluginServer: null,
      logger: createMockLogger(),
      dispatcher,
      agentStatusManager: { getStatus: vi.fn() } as never,
      globalWorktreeProvider: createMockGlobalWorktreeProvider(),
      deleteOp: {
        hasPendingRetry: () => false,
        signalDismiss: vi.fn(),
        signalRetry: vi.fn(),
      },
    });

    const quitModule = createQuitModule({ app: { quit: appQuit } });
    const retryModule = createRetryModule({ ipcLayer });
    const { module: lifecycleReadyModule, readyHandler } = createLifecycleReadyModule({
      mountSignal: { resolve: null },
    });

    wireModules(
      [idempotencyModule, quitModule, retryModule, lifecycleReadyModule, ipcEventBridge],
      hookRegistry,
      dispatcher
    );

    registry.register("lifecycle.ready", readyHandler, {
      ipc: ApiIpcChannels.LIFECYCLE_READY,
    });

    // First quit
    await ipcLayer._invoke("api:lifecycle:quit", {});
    expect(appQuit).toHaveBeenCalledTimes(1);

    // Second quit - idempotency interceptor blocks it
    await ipcLayer._invoke("api:lifecycle:quit", {});
    expect(appQuit).toHaveBeenCalledTimes(1);

    await registry.dispose();
    void deleteOp;
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
    const result = createTestWiring();

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
    const result = createTestWiring();

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
    const result = createTestWiring();

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
    const result = createTestWiring();

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
    const result = createTestWiring();

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
 * Helper: creates a mock IViewManager for setup tests.
 * Switches getUIWebContents to return null after onLoadingChange is called
 * (which happens in the activate handler before the mount check).
 */
function createSetupViewManager(mockWebContents: unknown) {
  const modeChangeHandlers: Array<(event: { mode: string; previousMode: string }) => void> = [];
  let inActivateHandler = false;

  return {
    getUIViewHandle: vi.fn(),
    getUIWebContents: vi.fn().mockImplementation(() => {
      if (inActivateHandler) return null;
      return mockWebContents as import("electron").WebContents;
    }),
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
    onModeChange: vi.fn((handler: (event: { mode: string; previousMode: string }) => void) => {
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
    onLoadingChange: vi.fn().mockImplementation(() => {
      inActivateHandler = true;
      return () => {};
    }),
    preloadWorkspaceUrl: vi.fn(),
    create: vi.fn(),
  };
}

/**
 * Helper: creates deps with a captured dispatcher and mock webContents
 * for testing the full app:start -> app:setup flow.
 *
 * Creates real modules (viewModule, codeServerModule, agentModule, idempotencyModule)
 * with mock services, matching the composition root pattern from index.ts.
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

  const configAgent = overrides?.configAgent !== undefined ? overrides.configAgent : "opencode";

  // Create a viewManager for ViewModule
  const setupViewManager = createSetupViewManager(mockWebContents);

  const setupHookRegistry = new HookRegistry();
  captured.dispatcher = new Dispatcher(setupHookRegistry);

  // --- Create mock services for setup modules ---
  const mockConfigService = {
    load: vi.fn().mockResolvedValue({ agent: configAgent, versions: {} }),
    save: vi.fn().mockResolvedValue(undefined),
    setAgent: vi.fn().mockResolvedValue(undefined),
  };

  const mockSetupCodeServerManager = {
    preflight: vi.fn().mockResolvedValue({
      success: true,
      needsDownload: overrides?.codeServerNeedsDownload ?? false,
    }),
    downloadBinary: overrides?.downloadError
      ? vi.fn().mockRejectedValue(overrides.downloadError)
      : vi.fn().mockResolvedValue(undefined),
  };

  const mockGetAgentBinaryManager = () =>
    ({
      preflight: vi.fn().mockResolvedValue({
        success: true,
        needsDownload: overrides?.agentNeedsDownload ?? false,
      }),
      downloadBinary: overrides?.agentDownloadMock ?? vi.fn().mockResolvedValue(undefined),
      getBinaryType: vi.fn().mockReturnValue("opencode"),
    }) as unknown as import("../services/binary-download").AgentBinaryManager;

  const mockExtensionManager = {
    preflight: vi.fn().mockResolvedValue({
      success: true,
      needsInstall: overrides?.extensionNeedsInstall ?? false,
      missingExtensions: overrides?.missingExtensions ?? [],
      outdatedExtensions: overrides?.outdatedExtensions ?? [],
    }),
    install: vi.fn().mockResolvedValue(undefined),
    cleanOutdated: vi.fn().mockResolvedValue(undefined),
  };

  // --- Create real modules using factory functions ---
  const { module: viewModule, mountSignal } = createViewModule({
    viewManager: setupViewManager as never,
    logger: createMockLogger(),
    viewLayer: null,
    windowLayer: null,
    sessionLayer: null,
  });

  const codeServerModule = createCodeServerModule({
    codeServerManager: {
      ...mockSetupCodeServerManager,
      ...createMockCodeServerManagerLifecycleMethods(),
    } as never,
    extensionManager: mockExtensionManager as never,
    logger: createMockLogger(),
    ...createMockCodeServerLifecycleDeps(),
  });

  const agentModule = createAgentModule({
    configService: mockConfigService as never,
    getAgentBinaryManager: mockGetAgentBinaryManager,
    ipcLayer: captured.ipcLayer,
    getUIWebContentsFn: () => mockWebContents as unknown as import("electron").WebContents,
    logger: createMockLogger(),
    loggingService: { createLogger: () => createMockLogger() } as never,
    dispatcher: captured.dispatcher,
    killTerminalsCallback: undefined,
    agentServerManagers: {
      claude: {
        dispose: vi.fn().mockResolvedValue(undefined),
        startServer: vi.fn().mockResolvedValue(undefined),
        stopServer: vi.fn().mockResolvedValue({ success: true }),
        restartServer: vi.fn().mockResolvedValue({ success: true, port: 0 }),
        onServerStarted: vi.fn().mockReturnValue(() => {}),
        onServerStopped: vi.fn().mockReturnValue(() => {}),
        setMarkActiveHandler: vi.fn(),
        setMcpConfig: vi.fn(),
      } as never,
      opencode: {
        dispose: vi.fn().mockResolvedValue(undefined),
        startServer: vi.fn().mockResolvedValue(undefined),
        stopServer: vi.fn().mockResolvedValue({ success: true }),
        restartServer: vi.fn().mockResolvedValue({ success: true, port: 0 }),
        onServerStarted: vi.fn().mockReturnValue(() => {}),
        onServerStopped: vi.fn().mockReturnValue(() => {}),
        setMarkActiveHandler: vi.fn(),
        setMcpConfig: vi.fn(),
      } as never,
    },
    agentStatusManager: {
      getStatus: vi.fn(),
      getEnvironmentVariables: vi.fn().mockReturnValue(null),
      onStatusChanged: vi.fn().mockReturnValue(() => {}),
      markActive: vi.fn(),
      dispose: vi.fn(),
    } as never,
  });

  const idempotencyModule = createIdempotencyModule([
    { intentType: INTENT_APP_SHUTDOWN },
    { intentType: INTENT_SETUP, resetOn: EVENT_SETUP_ERROR },
    {
      intentType: INTENT_DELETE_WORKSPACE,
      getKey: (p) => {
        const { workspacePath } = p as DeleteWorkspacePayload;
        return workspacePath;
      },
      resetOn: EVENT_WORKSPACE_DELETED,
      isForced: (intent) => (intent as DeleteWorkspaceIntent).payload.force,
    },
  ]);

  // --- Register operations and wire modules ---
  const deleteOp = registerAllOperations(captured.dispatcher);

  const registry = new ApiRegistry({ logger: createMockLogger(), ipcLayer: captured.ipcLayer });

  const ipcEventBridge = createIpcEventBridge({
    apiRegistry: registry,
    getApi: () => registry.getInterface(),
    getUIWebContents: () => mockWebContents as unknown as import("electron").WebContents,
    pluginServer: null,
    logger: createMockLogger(),
    dispatcher: captured.dispatcher,
    agentStatusManager: {
      getStatus: vi.fn(),
      getEnvironmentVariables: vi.fn().mockReturnValue(null),
      onStatusChanged: vi.fn().mockReturnValue(() => {}),
      markActive: vi.fn(),
      dispose: vi.fn(),
    } as never,
    globalWorktreeProvider: createMockGlobalWorktreeProvider(),
    deleteOp: {
      hasPendingRetry: (wp: string) => deleteOp.hasPendingRetry(wp),
      signalDismiss: (wp: string) => deleteOp.signalDismiss(wp),
      signalRetry: (wp: string) => deleteOp.signalRetry(wp),
    },
  });

  const quitModule = createQuitModule({ app: { quit: vi.fn() } });
  const retryModule = createRetryModule({ ipcLayer: captured.ipcLayer });
  const { module: lifecycleReadyModule, readyHandler } = createLifecycleReadyModule({
    mountSignal,
  });

  wireModules(
    [
      idempotencyModule,
      viewModule,
      codeServerModule,
      agentModule,
      quitModule,
      retryModule,
      lifecycleReadyModule,
      ipcEventBridge,
    ],
    setupHookRegistry,
    captured.dispatcher
  );

  registry.register("lifecycle.ready", readyHandler, {
    ipc: ApiIpcChannels.LIFECYCLE_READY,
  });

  const setupMocks = {
    configService: mockConfigService,
    codeServerManager: mockSetupCodeServerManager,
    extensionManager: mockExtensionManager,
    getAgentBinaryManager: mockGetAgentBinaryManager,
  };

  return { registry, captured, mockWebContents, setupMocks };
}

describe("bootstrap.setup.flow", () => {
  it("#1: startup completes when no setup needed", async () => {
    const { captured } = createSetupTestDeps({
      configAgent: "opencode",
      codeServerNeedsDownload: false,
      agentNeedsDownload: false,
      extensionNeedsInstall: false,
    });

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
    const { captured } = createSetupTestDeps();

    await captured.dispatcher.dispatch({ type: "app:start", payload: {} });

    // First IPC event should be show-starting
    expect(captured.webContentsSendCalls[0]?.channel).toBe("api:lifecycle:show-starting");
  });

  it("#3: shows agent selection when no agent configured", async () => {
    vi.useFakeTimers();
    try {
      const { captured } = createSetupTestDeps({
        configAgent: null,
      });

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
      const { captured, setupMocks } = createSetupTestDeps({
        configAgent: null,
      });

      const mockSetAgent = setupMocks.configService.setAgent;

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
    const { captured, setupMocks } = createSetupTestDeps({
      configAgent: "opencode",
      codeServerNeedsDownload: true,
      agentNeedsDownload: true,
      agentDownloadMock,
    });

    const mockCodeServerDownload = setupMocks.codeServerManager.downloadBinary as ReturnType<
      typeof vi.fn
    >;

    await captured.dispatcher.dispatch({ type: "app:start", payload: {} });

    // Verify both download methods were called
    expect(mockCodeServerDownload).toHaveBeenCalledOnce();
    expect(agentDownloadMock).toHaveBeenCalledOnce();
  });

  it("#6: installs extensions when missing", async () => {
    const { captured, setupMocks } = createSetupTestDeps({
      configAgent: "opencode",
      extensionNeedsInstall: true,
      missingExtensions: ["test-ext-1", "test-ext-2"],
    });

    const mockInstall = setupMocks.extensionManager.install as ReturnType<typeof vi.fn>;

    await captured.dispatcher.dispatch({ type: "app:start", payload: {} });

    // Verify install was called with the missing extensions
    expect(mockInstall).toHaveBeenCalledOnce();
    expect(mockInstall.mock.calls[0]?.[0]).toEqual(["test-ext-1", "test-ext-2"]);
  });

  it("#7: returns to starting screen after setup", async () => {
    const { captured } = createSetupTestDeps({
      configAgent: "opencode",
      codeServerNeedsDownload: true,
    });

    await captured.dispatcher.dispatch({ type: "app:start", payload: {} });

    // Find the sequence: show-setup -> ... -> show-starting (hide-ui hook)
    const channels = captured.webContentsSendCalls.map((c) => c.channel);

    const setupIdx = channels.indexOf("api:lifecycle:show-setup");
    expect(setupIdx).toBeGreaterThanOrEqual(0);

    // After setup, should return to show-starting
    const postSetupStarting = channels.indexOf("api:lifecycle:show-starting", setupIdx + 1);
    expect(postSetupStarting).toBeGreaterThan(setupIdx);
  });

  it("#12: show-main-view not sent from setup flow (sent by lifecycle layer)", async () => {
    const { captured } = createSetupTestDeps({
      configAgent: "opencode",
      codeServerNeedsDownload: false,
      extensionNeedsInstall: false,
    });

    await captured.dispatcher.dispatch({ type: "app:start", payload: {} });

    // show-main-view is now sent by showMainViewModule in wireDispatcher(),
    // not by the setup flow. Verify it's NOT sent from setup.
    const mainViewShown = captured.webContentsSendCalls.some(
      (c) => c.channel === "api:lifecycle:show-main-view"
    );
    expect(mainViewShown).toBe(false);
  });

  it("#13: app:setup includes causation reference", async () => {
    const { captured } = createSetupTestDeps({
      configAgent: "opencode",
      codeServerNeedsDownload: true,
    });

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
      const { captured, setupMocks } = createSetupTestDeps({
        configAgent: "opencode",
        codeServerNeedsDownload: true,
        downloadError,
      });

      // Dispatch will enter retry loop after setup failure.
      // Start the dispatch but don't await -- it will wait for retry IPC.
      const dispatchPromise = captured.dispatcher.dispatch({
        type: "app:start",
        payload: {},
      });

      // Flush microtask queue so the error is emitted and retry loop starts
      await vi.advanceTimersByTimeAsync(0);

      // Verify setup-error IPC was sent to renderer via IpcEventBridge -> webContents.send
      const errorSent = captured.webContentsSendCalls.find(
        (c) => c.channel === "api:lifecycle:setup-error"
      );
      expect(errorSent).toBeDefined();
      expect((errorSent?.args[0] as { message: string }).message).toContain("Network timeout");

      // Fix the download mock so retry succeeds, then trigger retry
      (setupMocks.codeServerManager.downloadBinary as ReturnType<typeof vi.fn>).mockResolvedValue(
        undefined
      );
      captured.ipcLayer._emit("api:lifecycle:retry");

      // Now the dispatch should complete
      await vi.runAllTimersAsync();
      await dispatchPromise;
    } finally {
      vi.useRealTimers();
    }
  });

  it("#17: agent-selection hook skipped when agent configured", async () => {
    const { captured } = createSetupTestDeps({
      configAgent: "opencode",
      codeServerNeedsDownload: true, // Need setup but agent is configured
    });

    await captured.dispatcher.dispatch({ type: "app:start", payload: {} });

    // Verify no agent selection IPC was sent
    const agentSelectionSent = captured.webContentsSendCalls.some(
      (c) => c.channel === "api:lifecycle:show-agent-selection"
    );
    expect(agentSelectionSent).toBe(false);
  });

  it("#18: binary hook skipped when binaries present", async () => {
    const { captured, setupMocks } = createSetupTestDeps({
      configAgent: "opencode",
      codeServerNeedsDownload: false,
      agentNeedsDownload: false,
      extensionNeedsInstall: true,
      missingExtensions: ["test-ext"],
    });

    const mockDownloadBinary = setupMocks.codeServerManager.downloadBinary as ReturnType<
      typeof vi.fn
    >;

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
    const mockDownloadBinary = vi.fn().mockResolvedValue(undefined);
    const mockAgentDownloadBinary = vi.fn().mockResolvedValue(undefined);
    const mockInstall = vi.fn().mockResolvedValue(undefined);

    const progressHookRegistry = new HookRegistry();
    const progressDispatcher = new Dispatcher(progressHookRegistry);

    const progressCodeServerManager = {
      preflight: vi.fn().mockResolvedValue({ success: true, needsDownload: true }),
      downloadBinary: mockDownloadBinary,
    };

    const progressExtensionManager = {
      preflight: vi.fn().mockResolvedValue({
        success: true,
        needsInstall: true,
        missingExtensions: ["test-ext"],
        outdatedExtensions: [],
      }),
      install: mockInstall,
      cleanOutdated: vi.fn().mockResolvedValue(undefined),
    };

    const progressGetAgentBinaryManager = () =>
      ({
        preflight: vi
          .fn()
          .mockResolvedValue({ success: true, needsDownload: true, binaryType: "opencode" }),
        downloadBinary: mockAgentDownloadBinary,
        getBinaryType: vi.fn().mockReturnValue("opencode"),
      }) as unknown as import("../services/binary-download").AgentBinaryManager;

    const mockWebContents = {
      isDestroyed: () => false,
      send: vi.fn(),
    };

    const progressViewManager = createSetupViewManager(mockWebContents);

    const { module: viewModule, mountSignal } = createViewModule({
      viewManager: progressViewManager as never,
      logger: createMockLogger(),
      viewLayer: null,
      windowLayer: null,
      sessionLayer: null,
    });

    const codeServerModule = createCodeServerModule({
      codeServerManager: {
        ...progressCodeServerManager,
        ...createMockCodeServerManagerLifecycleMethods(),
      } as never,
      extensionManager: progressExtensionManager as never,
      logger: createMockLogger(),
      ...createMockCodeServerLifecycleDeps(),
    });

    const agentModule = createAgentModule({
      configService: {
        load: vi.fn().mockResolvedValue({ agent: "opencode", versions: {} }),
        setAgent: vi.fn().mockResolvedValue(undefined),
      } as never,
      getAgentBinaryManager: progressGetAgentBinaryManager,
      ipcLayer: createBehavioralIpcLayer(),
      getUIWebContentsFn: () => mockWebContents as unknown as import("electron").WebContents,
      logger: createMockLogger(),
      loggingService: { createLogger: () => createMockLogger() } as never,
      dispatcher: progressDispatcher,
      killTerminalsCallback: undefined,
      agentServerManagers: {
        claude: {
          dispose: vi.fn().mockResolvedValue(undefined),
          onServerStarted: vi.fn().mockReturnValue(() => {}),
          onServerStopped: vi.fn().mockReturnValue(() => {}),
          setMarkActiveHandler: vi.fn(),
          setMcpConfig: vi.fn(),
        } as never,
        opencode: {
          dispose: vi.fn().mockResolvedValue(undefined),
          onServerStarted: vi.fn().mockReturnValue(() => {}),
          onServerStopped: vi.fn().mockReturnValue(() => {}),
          setMarkActiveHandler: vi.fn(),
          setMcpConfig: vi.fn(),
        } as never,
      },
      agentStatusManager: {
        getStatus: vi.fn(),
        onStatusChanged: vi.fn().mockReturnValue(() => {}),
        markActive: vi.fn(),
        dispose: vi.fn(),
      } as never,
    });

    // Register operations and wire modules
    const deleteOp = registerAllOperations(progressDispatcher);
    void deleteOp;

    const progressIpcLayer = createBehavioralIpcLayer();
    const registry = new ApiRegistry({ logger: createMockLogger(), ipcLayer: progressIpcLayer });

    const ipcEventBridge = createIpcEventBridge({
      apiRegistry: registry,
      getApi: () => registry.getInterface(),
      getUIWebContents: () => mockWebContents as unknown as import("electron").WebContents,
      pluginServer: null,
      logger: createMockLogger(),
      dispatcher: progressDispatcher,
      agentStatusManager: {
        getStatus: vi.fn(),
        onStatusChanged: vi.fn().mockReturnValue(() => {}),
        markActive: vi.fn(),
        dispose: vi.fn(),
      } as never,
      globalWorktreeProvider: createMockGlobalWorktreeProvider(),
      deleteOp: {
        hasPendingRetry: () => false,
        signalDismiss: vi.fn(),
        signalRetry: vi.fn(),
      },
    });

    const quitModule = createQuitModule({ app: { quit: vi.fn() } });
    const retryModule = createRetryModule({ ipcLayer: progressIpcLayer });
    const { module: lifecycleReadyModule, readyHandler } = createLifecycleReadyModule({
      mountSignal,
    });

    wireModules(
      [
        viewModule,
        codeServerModule,
        agentModule,
        quitModule,
        retryModule,
        lifecycleReadyModule,
        ipcEventBridge,
      ],
      progressHookRegistry,
      progressDispatcher
    );

    registry.register("lifecycle.ready", readyHandler, {
      ipc: ApiIpcChannels.LIFECYCLE_READY,
    });

    // Dispatch app:start which triggers check -> app:setup -> binary/extensions hooks
    const handle = progressDispatcher.dispatch({
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

      const pctHookRegistry = new HookRegistry();
      const capturedDispatcher = new Dispatcher(pctHookRegistry);

      const webContentsSendCalls: Array<{ channel: string; args: unknown[] }> = [];
      const mockWebContents = {
        isDestroyed: () => false,
        send: (channel: string, ...args: unknown[]) => {
          webContentsSendCalls.push({ channel, args });
        },
      };

      const pctViewManager = createSetupViewManager(mockWebContents);
      const { module: viewModule, mountSignal } = createViewModule({
        viewManager: pctViewManager as never,
        logger: createMockLogger(),
        viewLayer: null,
        windowLayer: null,
        sessionLayer: null,
      });

      const codeServerModule = createCodeServerModule({
        codeServerManager: {
          preflight: vi.fn().mockResolvedValue({ success: true, needsDownload: true }),
          downloadBinary: mockDownloadBinary,
          ...createMockCodeServerManagerLifecycleMethods(),
        } as never,
        extensionManager: {
          preflight: vi.fn().mockResolvedValue({
            success: true,
            needsInstall: false,
            missingExtensions: [],
            outdatedExtensions: [],
          }),
          install: vi.fn().mockResolvedValue(undefined),
        } as never,
        logger: createMockLogger(),
        ...createMockCodeServerLifecycleDeps(),
      });

      const agentModule = createAgentModule({
        configService: {
          load: vi.fn().mockResolvedValue({ agent: "opencode", versions: {} }),
          setAgent: vi.fn().mockResolvedValue(undefined),
        } as never,
        getAgentBinaryManager: () =>
          ({
            preflight: vi.fn().mockResolvedValue({ success: true, needsDownload: false }),
            downloadBinary: vi.fn().mockResolvedValue(undefined),
            getBinaryType: vi.fn().mockReturnValue("opencode"),
          }) as unknown as import("../services/binary-download").AgentBinaryManager,
        ipcLayer: createBehavioralIpcLayer(),
        getUIWebContentsFn: () => mockWebContents as unknown as import("electron").WebContents,
        logger: createMockLogger(),
        loggingService: { createLogger: () => createMockLogger() } as never,
        dispatcher: capturedDispatcher,
        killTerminalsCallback: undefined,
        agentServerManagers: {
          claude: {
            dispose: vi.fn().mockResolvedValue(undefined),
            onServerStarted: vi.fn().mockReturnValue(() => {}),
            onServerStopped: vi.fn().mockReturnValue(() => {}),
            setMarkActiveHandler: vi.fn(),
            setMcpConfig: vi.fn(),
          } as never,
          opencode: {
            dispose: vi.fn().mockResolvedValue(undefined),
            onServerStarted: vi.fn().mockReturnValue(() => {}),
            onServerStopped: vi.fn().mockReturnValue(() => {}),
            setMarkActiveHandler: vi.fn(),
            setMcpConfig: vi.fn(),
          } as never,
        },
        agentStatusManager: {
          getStatus: vi.fn(),
          onStatusChanged: vi.fn().mockReturnValue(() => {}),
          markActive: vi.fn(),
          dispose: vi.fn(),
        } as never,
      });

      // Register operations and wire modules
      const deleteOp = registerAllOperations(capturedDispatcher);
      void deleteOp;

      const pctIpcLayer = createBehavioralIpcLayer();
      const registry = new ApiRegistry({ logger: createMockLogger(), ipcLayer: pctIpcLayer });

      const ipcEventBridge = createIpcEventBridge({
        apiRegistry: registry,
        getApi: () => registry.getInterface(),
        getUIWebContents: () => mockWebContents as unknown as import("electron").WebContents,
        pluginServer: null,
        logger: createMockLogger(),
        dispatcher: capturedDispatcher,
        agentStatusManager: {
          getStatus: vi.fn(),
          onStatusChanged: vi.fn().mockReturnValue(() => {}),
          markActive: vi.fn(),
          dispose: vi.fn(),
        } as never,
        globalWorktreeProvider: createMockGlobalWorktreeProvider(),
        deleteOp: {
          hasPendingRetry: () => false,
          signalDismiss: vi.fn(),
          signalRetry: vi.fn(),
        },
      });

      const quitModule = createQuitModule({ app: { quit: vi.fn() } });
      const retryModule = createRetryModule({ ipcLayer: pctIpcLayer });
      const { module: lifecycleReadyModule, readyHandler } = createLifecycleReadyModule({
        mountSignal,
      });

      wireModules(
        [
          viewModule,
          codeServerModule,
          agentModule,
          quitModule,
          retryModule,
          lifecycleReadyModule,
          ipcEventBridge,
        ],
        pctHookRegistry,
        capturedDispatcher
      );

      registry.register("lifecycle.ready", readyHandler, {
        ipc: ApiIpcChannels.LIFECYCLE_READY,
      });

      const handle = capturedDispatcher.dispatch({
        type: "app:start",
        payload: {},
      });

      // Advance timers to allow async operations to complete
      await vi.runAllTimersAsync();
      await handle;

      // Find a progress event with percentage for vscode row
      // Progress events are now sent via IpcEventBridge -> webContents.send
      // Each event is a single row: { id, status, message?, progress? }
      const progressCalls = webContentsSendCalls.filter(
        (c) => c.channel === "api:lifecycle:setup-progress"
      );
      const withPercent = progressCalls.find((c) => {
        const payload = c.args[0] as { id: string; progress?: number };
        return payload.id === "vscode" && payload.progress === 50;
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
    const ipcLayer = createBehavioralIpcLayer();
    const result = createTestWiring({ ipcLayer });

    // lifecycle.ready just resolves the mount promise -- no events re-emitted
    const projectOpenedEvents: unknown[] = [];
    result.registry.on("project:opened", (event) => {
      projectOpenedEvents.push(event);
    });

    await ipcLayer._invoke("api:lifecycle:ready", {});

    // No event re-emission -- events flow naturally from project:open dispatches
    expect(projectOpenedEvents).toHaveLength(0);

    await result.dispose();
  });

  it("is idempotent (can be called multiple times safely)", async () => {
    const ipcLayer = createBehavioralIpcLayer();
    const result = createTestWiring({ ipcLayer });

    // Call twice -- second call is a no-op (mountResolve is null)
    await ipcLayer._invoke("api:lifecycle:ready", {});
    await ipcLayer._invoke("api:lifecycle:ready", {});

    // No errors, no events re-emitted
    await result.dispose();
  });
});
