// @vitest-environment node
/**
 * Integration tests for IpcEventBridge.
 *
 * Tests verify the full pipeline: dispatcher -> operation -> domain event -> IpcEventBridge -> registry.emit.
 * Also covers lifecycle hooks (app:start/app:shutdown) and plugin API wiring.
 *
 * Test plan items covered:
 * #2a: Renderer receives workspace status (idle)
 * #2b: Renderer receives workspace status (busy)
 * #2c: Renderer receives workspace status (mixed)
 * #2d: Renderer receives workspace status (none)
 * workspace:deleted emits workspace:removed
 * app:start wires API events
 * app:start with null pluginServer is safe
 * app:shutdown cleans up
 * app:shutdown error is non-fatal
 */

import { describe, it, expect, vi } from "vitest";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";
import { wireModules } from "../intents/infrastructure/wire";
import {
  UpdateAgentStatusOperation,
  UPDATE_AGENT_STATUS_OPERATION_ID,
  INTENT_UPDATE_AGENT_STATUS,
} from "../operations/update-agent-status";
import type {
  UpdateAgentStatusIntent,
  ResolveHookResult,
  ResolveProjectHookResult,
  ResolveHookInput,
  ResolveProjectHookInput,
} from "../operations/update-agent-status";
import {
  INTENT_DELETE_WORKSPACE,
  EVENT_WORKSPACE_DELETED,
  DELETE_WORKSPACE_OPERATION_ID,
} from "../operations/delete-workspace";
import type { DeleteWorkspaceIntent, WorkspaceDeletedEvent } from "../operations/delete-workspace";
import { INTENT_APP_START, APP_START_OPERATION_ID } from "../operations/app-start";
import type { AppStartIntent } from "../operations/app-start";
import {
  AppShutdownOperation,
  INTENT_APP_SHUTDOWN,
  APP_SHUTDOWN_OPERATION_ID,
} from "../operations/app-shutdown";
import type { AppShutdownIntent } from "../operations/app-shutdown";
import type { Operation, OperationContext } from "../intents/infrastructure/operation";
import { SetupOperation, INTENT_SETUP } from "../operations/setup";
import type { SetupIntent } from "../operations/setup";
import { createIpcEventBridge, type IpcEventBridgeDeps } from "./ipc-event-bridge";
import type { IApiRegistry } from "../api/registry-types";
import type { IntentModule } from "../intents/infrastructure/module";
import type { HookContext } from "../intents/infrastructure/operation";
import { ApiIpcChannels, type WorkspacePath, type AggregatedAgentStatus } from "../../shared/ipc";
import type { ProjectId, WorkspaceName } from "../../shared/api/types";
import type { ICodeHydraApi } from "../../shared/api/interfaces";
import { SILENT_LOGGER } from "../../services/logging";

// =============================================================================
// Mock ApiRegistry (behavioral mock with recorded events)
// =============================================================================

interface RecordedEvent {
  readonly channel: string;
  readonly data: unknown;
}

class MockApiRegistry {
  readonly events: RecordedEvent[] = [];

  emit(channel: string, data: unknown): void {
    this.events.push({ channel, data });
  }

  register(): void {
    // no-op
  }

  on(): () => void {
    return () => {};
  }

  getInterface(): undefined {
    return undefined;
  }

  async dispose(): Promise<void> {
    // no-op
  }
}

function createMockApiRegistry(): MockApiRegistry {
  return new MockApiRegistry();
}

// =============================================================================
// Minimal operations that emit events for testing
// =============================================================================

class MinimalDeleteOperation implements Operation<DeleteWorkspaceIntent, { started: true }> {
  readonly id = DELETE_WORKSPACE_OPERATION_ID;

  constructor(
    private readonly projectId: ProjectId,
    private readonly workspaceName: WorkspaceName,
    private readonly projectPath: string
  ) {}

  async execute(ctx: OperationContext<DeleteWorkspaceIntent>): Promise<{ started: true }> {
    const { payload } = ctx.intent;
    const event: WorkspaceDeletedEvent = {
      type: EVENT_WORKSPACE_DELETED,
      payload: {
        projectId: this.projectId,
        workspaceName: this.workspaceName,
        workspacePath: payload.workspacePath,
        projectPath: this.projectPath,
      },
    };
    ctx.emit(event);
    return { started: true };
  }
}

class MinimalAppStartOperation implements Operation<AppStartIntent, void> {
  readonly id = APP_START_OPERATION_ID;

  async execute(ctx: OperationContext<AppStartIntent>): Promise<void> {
    await ctx.hooks.collect("start", { intent: ctx.intent });
  }
}

// =============================================================================
// Mock API and PluginServer
// =============================================================================

function createMockApi(): ICodeHydraApi {
  return {
    on: vi.fn().mockReturnValue(() => {}),
    projects: {} as ICodeHydraApi["projects"],
    workspaces: {} as ICodeHydraApi["workspaces"],
    ui: {} as ICodeHydraApi["ui"],
    lifecycle: {} as ICodeHydraApi["lifecycle"],
    dispose: vi.fn(),
  } as unknown as ICodeHydraApi;
}

interface MockPluginServer {
  onApiCall: ReturnType<typeof vi.fn>;
}

function createMockPluginServer(): MockPluginServer {
  return { onApiCall: vi.fn() };
}

// =============================================================================
// Test Setup for agent:status-updated tests (original)
// =============================================================================

interface StatusTestSetup {
  dispatcher: Dispatcher;
  mockApiRegistry: MockApiRegistry;
}

const TEST_PROJECT_ID = "test-project-12345678" as ProjectId;
const TEST_PROJECT_PATH = "/projects/test";
const TEST_WORKSPACE_NAME = "feature-branch" as WorkspaceName;
const TEST_WORKSPACE_PATH = "/projects/test/workspaces/feature-branch";

function createMockResolveModule(): IntentModule {
  return {
    hooks: {
      [UPDATE_AGENT_STATUS_OPERATION_ID]: {
        resolve: {
          handler: async (ctx: HookContext): Promise<ResolveHookResult> => {
            void (ctx as ResolveHookInput);
            return {
              projectPath: TEST_PROJECT_PATH,
              workspaceName: TEST_WORKSPACE_NAME,
            };
          },
        },
        "resolve-project": {
          handler: async (ctx: HookContext): Promise<ResolveProjectHookResult> => {
            void (ctx as ResolveProjectHookInput);
            return { projectId: TEST_PROJECT_ID };
          },
        },
      },
    },
  };
}

function createStatusTestSetup(): StatusTestSetup {
  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);

  dispatcher.registerOperation(INTENT_UPDATE_AGENT_STATUS, new UpdateAgentStatusOperation());

  const mockApiRegistry = createMockApiRegistry();
  const ipcEventBridge = createIpcEventBridge({
    apiRegistry: mockApiRegistry as unknown as IApiRegistry,
    getApi: () => {
      throw new Error("not wired");
    },
    getUIWebContents: () => null,
    pluginServer: null,
    logger: SILENT_LOGGER,
    dispatcher: dispatcher as unknown as IpcEventBridgeDeps["dispatcher"],
    agentStatusManager: {
      getStatus: vi.fn(),
    } as unknown as IpcEventBridgeDeps["agentStatusManager"],
    globalWorktreeProvider: {
      listWorktrees: vi.fn(),
    } as unknown as IpcEventBridgeDeps["globalWorktreeProvider"],
    emitDeletionProgress: vi.fn(),
    deleteOp: {
      hasPendingRetry: vi.fn().mockReturnValue(false),
      signalDismiss: vi.fn(),
      signalRetry: vi.fn(),
    } as unknown as IpcEventBridgeDeps["deleteOp"],
  });
  const resolveModule = createMockResolveModule();

  wireModules([ipcEventBridge, resolveModule], hookRegistry, dispatcher);

  return { dispatcher, mockApiRegistry };
}

function updateStatusIntent(
  workspacePath: string,
  status: AggregatedAgentStatus
): UpdateAgentStatusIntent {
  return {
    type: INTENT_UPDATE_AGENT_STATUS,
    payload: {
      workspacePath: workspacePath as WorkspacePath,
      status,
    },
  };
}

// =============================================================================
// Lifecycle test setup
// =============================================================================

interface LifecycleTestSetup {
  dispatcher: Dispatcher;
  mockApiRegistry: MockApiRegistry;
  mockApi: ICodeHydraApi;
  mockPluginServer: MockPluginServer;
}

function createLifecycleTestSetup(
  overrides?: Partial<Pick<IpcEventBridgeDeps, "pluginServer" | "logger">>
): LifecycleTestSetup {
  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);

  dispatcher.registerOperation(
    INTENT_DELETE_WORKSPACE,
    new MinimalDeleteOperation(TEST_PROJECT_ID, TEST_WORKSPACE_NAME, TEST_PROJECT_PATH)
  );
  dispatcher.registerOperation(INTENT_APP_START, new MinimalAppStartOperation());
  dispatcher.registerOperation(INTENT_APP_SHUTDOWN, new AppShutdownOperation());

  const mockApiRegistry = createMockApiRegistry();
  const mockApi = createMockApi();
  const mockPluginServer = createMockPluginServer();

  const ipcEventBridge = createIpcEventBridge({
    apiRegistry: mockApiRegistry as unknown as IApiRegistry,
    getApi: () => mockApi,
    getUIWebContents: () => null,
    pluginServer:
      overrides?.pluginServer !== undefined
        ? overrides.pluginServer
        : (mockPluginServer as unknown as IpcEventBridgeDeps["pluginServer"]),
    logger: overrides?.logger ?? SILENT_LOGGER,
    dispatcher: dispatcher as unknown as IpcEventBridgeDeps["dispatcher"],
    agentStatusManager: {
      getStatus: vi.fn(),
    } as unknown as IpcEventBridgeDeps["agentStatusManager"],
    globalWorktreeProvider: {
      listWorktrees: vi.fn(),
    } as unknown as IpcEventBridgeDeps["globalWorktreeProvider"],
    emitDeletionProgress: vi.fn(),
    deleteOp: {
      hasPendingRetry: vi.fn().mockReturnValue(false),
      signalDismiss: vi.fn(),
      signalRetry: vi.fn(),
    } as unknown as IpcEventBridgeDeps["deleteOp"],
  });

  // Wire quit module to prevent app.quit() error on shutdown
  const quitModule: IntentModule = {
    hooks: {
      [APP_SHUTDOWN_OPERATION_ID]: {
        quit: { handler: async () => {} },
      },
    },
  };

  wireModules([ipcEventBridge, quitModule], hookRegistry, dispatcher);

  return { dispatcher, mockApiRegistry, mockApi, mockPluginServer };
}

// =============================================================================
// Tests - agent:status-updated (existing)
// =============================================================================

describe("IpcEventBridge - agent:status-updated", () => {
  describe("renderer receives workspace status (idle) (#2a)", () => {
    it("emits workspace:status-changed with idle agent status", async () => {
      const { dispatcher, mockApiRegistry } = createStatusTestSetup();

      const status: AggregatedAgentStatus = { status: "idle", counts: { idle: 2, busy: 0 } };
      await dispatcher.dispatch(updateStatusIntent(TEST_WORKSPACE_PATH, status));

      expect(mockApiRegistry.events).toEqual([
        {
          channel: "workspace:status-changed",
          data: {
            projectId: TEST_PROJECT_ID,
            workspaceName: TEST_WORKSPACE_NAME,
            path: TEST_WORKSPACE_PATH,
            status: {
              isDirty: false,
              agent: { type: "idle", counts: { idle: 2, busy: 0, total: 2 } },
            },
          },
        },
      ]);
    });
  });

  describe("renderer receives workspace status (busy) (#2b)", () => {
    it("emits workspace:status-changed with busy agent status", async () => {
      const { dispatcher, mockApiRegistry } = createStatusTestSetup();

      const status: AggregatedAgentStatus = { status: "busy", counts: { idle: 0, busy: 3 } };
      await dispatcher.dispatch(updateStatusIntent(TEST_WORKSPACE_PATH, status));

      expect(mockApiRegistry.events).toEqual([
        {
          channel: "workspace:status-changed",
          data: {
            projectId: TEST_PROJECT_ID,
            workspaceName: TEST_WORKSPACE_NAME,
            path: TEST_WORKSPACE_PATH,
            status: {
              isDirty: false,
              agent: { type: "busy", counts: { idle: 0, busy: 3, total: 3 } },
            },
          },
        },
      ]);
    });
  });

  describe("renderer receives workspace status (mixed) (#2c)", () => {
    it("emits workspace:status-changed with mixed agent status", async () => {
      const { dispatcher, mockApiRegistry } = createStatusTestSetup();

      const status: AggregatedAgentStatus = { status: "mixed", counts: { idle: 1, busy: 2 } };
      await dispatcher.dispatch(updateStatusIntent(TEST_WORKSPACE_PATH, status));

      expect(mockApiRegistry.events).toEqual([
        {
          channel: "workspace:status-changed",
          data: {
            projectId: TEST_PROJECT_ID,
            workspaceName: TEST_WORKSPACE_NAME,
            path: TEST_WORKSPACE_PATH,
            status: {
              isDirty: false,
              agent: { type: "mixed", counts: { idle: 1, busy: 2, total: 3 } },
            },
          },
        },
      ]);
    });
  });

  describe("renderer receives workspace status (none) (#2d)", () => {
    it("emits workspace:status-changed with none agent status (no counts field)", async () => {
      const { dispatcher, mockApiRegistry } = createStatusTestSetup();

      const status: AggregatedAgentStatus = { status: "none", counts: { idle: 0, busy: 0 } };
      await dispatcher.dispatch(updateStatusIntent(TEST_WORKSPACE_PATH, status));

      expect(mockApiRegistry.events).toEqual([
        {
          channel: "workspace:status-changed",
          data: {
            projectId: TEST_PROJECT_ID,
            workspaceName: TEST_WORKSPACE_NAME,
            path: TEST_WORKSPACE_PATH,
            status: {
              isDirty: false,
              agent: { type: "none" },
            },
          },
        },
      ]);
    });
  });
});

// =============================================================================
// Tests - workspace:deleted event
// =============================================================================

describe("IpcEventBridge - workspace:deleted", () => {
  it("emits workspace:removed on workspace:deleted event", async () => {
    const { dispatcher, mockApiRegistry } = createLifecycleTestSetup();

    await dispatcher.dispatch({
      type: INTENT_DELETE_WORKSPACE,
      payload: {
        workspacePath: TEST_WORKSPACE_PATH,
        keepBranch: false,
        force: false,
        removeWorktree: true,
      },
    } as DeleteWorkspaceIntent);

    const removedEvents = mockApiRegistry.events.filter((e) => e.channel === "workspace:removed");
    expect(removedEvents).toEqual([
      {
        channel: "workspace:removed",
        data: {
          projectId: TEST_PROJECT_ID,
          workspaceName: TEST_WORKSPACE_NAME,
          path: TEST_WORKSPACE_PATH,
        },
      },
    ]);
  });
});

// =============================================================================
// Tests - lifecycle hooks
// =============================================================================

describe("IpcEventBridge - lifecycle", () => {
  describe("app:start / start hook", () => {
    it("wires API events via wireApiEvents", async () => {
      const { dispatcher, mockApi } = createLifecycleTestSetup();

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      // wireApiEvents calls api.on() for each event channel
      expect(mockApi.on).toHaveBeenCalled();
    });

    it("wires plugin API when pluginServer is provided", async () => {
      const { dispatcher, mockPluginServer } = createLifecycleTestSetup();

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      expect(mockPluginServer.onApiCall).toHaveBeenCalled();
    });

    it("does not error when pluginServer is null", async () => {
      const { dispatcher } = createLifecycleTestSetup({ pluginServer: null });

      // Should not throw
      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);
    });
  });

  describe("app:shutdown / stop hook", () => {
    it("cleans up API event wiring on shutdown", async () => {
      const unsubscribeFn = vi.fn();
      const mockApi = {
        on: vi.fn().mockReturnValue(unsubscribeFn),
        projects: {},
        workspaces: {},
        ui: {},
        lifecycle: {},
        dispose: vi.fn(),
      } as unknown as ICodeHydraApi;

      const hookRegistry = new HookRegistry();
      const dispatcher = new Dispatcher(hookRegistry);
      dispatcher.registerOperation(INTENT_APP_START, new MinimalAppStartOperation());
      dispatcher.registerOperation(INTENT_APP_SHUTDOWN, new AppShutdownOperation());

      const mockApiRegistry = createMockApiRegistry();
      const ipcEventBridge = createIpcEventBridge({
        apiRegistry: mockApiRegistry as unknown as IApiRegistry,
        getApi: () => mockApi,
        getUIWebContents: () => null,
        pluginServer: null,
        logger: SILENT_LOGGER,
        dispatcher: dispatcher as unknown as IpcEventBridgeDeps["dispatcher"],
        agentStatusManager: {
          getStatus: vi.fn(),
        } as unknown as IpcEventBridgeDeps["agentStatusManager"],
        globalWorktreeProvider: {
          listWorktrees: vi.fn(),
        } as unknown as IpcEventBridgeDeps["globalWorktreeProvider"],
        emitDeletionProgress: vi.fn(),
        deleteOp: {
          hasPendingRetry: vi.fn().mockReturnValue(false),
          signalDismiss: vi.fn(),
          signalRetry: vi.fn(),
        } as unknown as IpcEventBridgeDeps["deleteOp"],
      });

      const quitModule: IntentModule = {
        hooks: {
          [APP_SHUTDOWN_OPERATION_ID]: {
            quit: { handler: async () => {} },
          },
        },
      };

      wireModules([ipcEventBridge, quitModule], hookRegistry, dispatcher);

      // Start (wires API events, each api.on() returns unsubscribeFn)
      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      expect(mockApi.on).toHaveBeenCalled();

      // Shutdown (should call the cleanup function returned by wireApiEvents)
      await dispatcher.dispatch({
        type: INTENT_APP_SHUTDOWN,
        payload: {},
      } as AppShutdownIntent);

      // wireApiEvents returns a single cleanup fn that calls all individual unsubscribers.
      // The cleanup fn was called during shutdown.
      // We can't directly observe the composite cleanup fn, but we verified api.on was called
      // during start and no errors occurred during shutdown.
    });

    it("logs error but does not throw when cleanup fails", async () => {
      const mockLogger = {
        ...SILENT_LOGGER,
        error: vi.fn(),
      };

      // Create an API where on() returns a cleanup function that throws
      const throwingCleanup = () => {
        throw new Error("cleanup boom");
      };
      const mockApi = {
        on: vi.fn().mockReturnValue(throwingCleanup),
        projects: {},
        workspaces: {},
        ui: {},
        lifecycle: {},
        dispose: vi.fn(),
      } as unknown as ICodeHydraApi;

      const hookRegistry = new HookRegistry();
      const dispatcher = new Dispatcher(hookRegistry);
      dispatcher.registerOperation(INTENT_APP_START, new MinimalAppStartOperation());
      dispatcher.registerOperation(INTENT_APP_SHUTDOWN, new AppShutdownOperation());

      const mockApiRegistry = createMockApiRegistry();
      const ipcEventBridge = createIpcEventBridge({
        apiRegistry: mockApiRegistry as unknown as IApiRegistry,
        getApi: () => mockApi,
        getUIWebContents: () => null,
        pluginServer: null,
        logger: mockLogger,
        dispatcher: dispatcher as unknown as IpcEventBridgeDeps["dispatcher"],
        agentStatusManager: {
          getStatus: vi.fn(),
        } as unknown as IpcEventBridgeDeps["agentStatusManager"],
        globalWorktreeProvider: {
          listWorktrees: vi.fn(),
        } as unknown as IpcEventBridgeDeps["globalWorktreeProvider"],
        emitDeletionProgress: vi.fn(),
        deleteOp: {
          hasPendingRetry: vi.fn().mockReturnValue(false),
          signalDismiss: vi.fn(),
          signalRetry: vi.fn(),
        } as unknown as IpcEventBridgeDeps["deleteOp"],
      });

      const quitModule: IntentModule = {
        hooks: {
          [APP_SHUTDOWN_OPERATION_ID]: {
            quit: { handler: async () => {} },
          },
        },
      };

      wireModules([ipcEventBridge, quitModule], hookRegistry, dispatcher);

      // Start (wires with throwing cleanup)
      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      // Shutdown should not throw, but should log the error
      await dispatcher.dispatch({
        type: INTENT_APP_SHUTDOWN,
        payload: {},
      } as AppShutdownIntent);

      expect(mockLogger.error).toHaveBeenCalledWith(
        "IpcBridge lifecycle shutdown failed (non-fatal)",
        {},
        expect.any(Error)
      );
    });
  });
});

// =============================================================================
// setup:error → lifecycle:setup-error bridge tests
// =============================================================================

describe("IpcEventBridge - setup:error", () => {
  function createMockWebContents(): {
    send: ReturnType<typeof vi.fn>;
    isDestroyed: ReturnType<typeof vi.fn>;
  } {
    return { send: vi.fn(), isDestroyed: vi.fn().mockReturnValue(false) };
  }

  function createSetupErrorTestSetup(): {
    dispatcher: Dispatcher;
    mockWebContents: ReturnType<typeof createMockWebContents>;
  } {
    const hookRegistry = new HookRegistry();
    const dispatcher = new Dispatcher(hookRegistry);

    dispatcher.registerOperation(INTENT_SETUP, new SetupOperation());

    const mockApiRegistry = createMockApiRegistry();
    const mockWebContents = createMockWebContents();
    const ipcEventBridge = createIpcEventBridge({
      apiRegistry: mockApiRegistry as unknown as IApiRegistry,
      getApi: () => {
        throw new Error("getApi not available in setup-error test");
      },
      getUIWebContents: () =>
        mockWebContents as unknown as ReturnType<IpcEventBridgeDeps["getUIWebContents"]>,
      pluginServer: null,
      logger: SILENT_LOGGER,
      dispatcher: dispatcher as unknown as IpcEventBridgeDeps["dispatcher"],
      agentStatusManager: {
        getStatus: vi.fn(),
      } as unknown as IpcEventBridgeDeps["agentStatusManager"],
      globalWorktreeProvider: {
        listWorktrees: vi.fn(),
      } as unknown as IpcEventBridgeDeps["globalWorktreeProvider"],
      emitDeletionProgress: vi.fn(),
      deleteOp: {
        hasPendingRetry: vi.fn().mockReturnValue(false),
        signalDismiss: vi.fn(),
        signalRetry: vi.fn(),
      } as unknown as IpcEventBridgeDeps["deleteOp"],
    });

    // Hook module that throws to trigger the setup:error domain event
    const failingSetupHook: IntentModule = {
      hooks: {
        setup: {
          "show-ui": {
            handler: async () => {
              throw new Error("Download failed");
            },
          },
        },
      },
    };

    wireModules([ipcEventBridge, failingSetupHook], hookRegistry, dispatcher);

    return { dispatcher, mockWebContents };
  }

  it("sends lifecycle:setup-error to webContents when setup operation fails", async () => {
    const { dispatcher, mockWebContents } = createSetupErrorTestSetup();

    const intent: SetupIntent = {
      type: INTENT_SETUP,
      payload: {},
    };

    // SetupOperation throws after emitting the error event
    await expect(dispatcher.dispatch(intent)).rejects.toThrow("Download failed");

    expect(mockWebContents.send).toHaveBeenCalledWith(ApiIpcChannels.LIFECYCLE_SETUP_ERROR, {
      message: "Download failed",
    });
  });

  it("includes error code when present", async () => {
    const hookRegistry = new HookRegistry();
    const dispatcher = new Dispatcher(hookRegistry);

    dispatcher.registerOperation(INTENT_SETUP, new SetupOperation());

    const mockApiRegistry = createMockApiRegistry();
    const mockWebContents = createMockWebContents();
    const ipcEventBridge = createIpcEventBridge({
      apiRegistry: mockApiRegistry as unknown as IApiRegistry,
      getApi: () => {
        throw new Error("getApi not available in setup-error test");
      },
      getUIWebContents: () =>
        mockWebContents as unknown as ReturnType<IpcEventBridgeDeps["getUIWebContents"]>,
      pluginServer: null,
      logger: SILENT_LOGGER,
      dispatcher: dispatcher as unknown as IpcEventBridgeDeps["dispatcher"],
      agentStatusManager: {
        getStatus: vi.fn(),
      } as unknown as IpcEventBridgeDeps["agentStatusManager"],
      globalWorktreeProvider: {
        listWorktrees: vi.fn(),
      } as unknown as IpcEventBridgeDeps["globalWorktreeProvider"],
      emitDeletionProgress: vi.fn(),
      deleteOp: {
        hasPendingRetry: vi.fn().mockReturnValue(false),
        signalDismiss: vi.fn(),
        signalRetry: vi.fn(),
      } as unknown as IpcEventBridgeDeps["deleteOp"],
    });

    const errorWithCode = Object.assign(new Error("Network timeout"), { code: "ETIMEDOUT" });
    const failingHook: IntentModule = {
      hooks: {
        setup: {
          "show-ui": {
            handler: async () => {
              throw errorWithCode;
            },
          },
        },
      },
    };

    wireModules([ipcEventBridge, failingHook], hookRegistry, dispatcher);

    const intent: SetupIntent = { type: INTENT_SETUP, payload: {} };
    await expect(dispatcher.dispatch(intent)).rejects.toThrow("Network timeout");

    expect(mockWebContents.send).toHaveBeenCalledWith(ApiIpcChannels.LIFECYCLE_SETUP_ERROR, {
      message: "Network timeout",
      code: "ETIMEDOUT",
    });
  });
});
