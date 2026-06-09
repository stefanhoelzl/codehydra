// @vitest-environment node
/**
 * Integration tests for UiIpcModule.
 *
 * Tests verify the full pipeline: dispatcher -> operation -> domain event -> sendToUI.
 * Also covers IPC handler registration, log listeners, and shutdown cleanup.
 *
 * Test plan items covered:
 * #2a: Renderer receives workspace status (idle)
 * #2b: Renderer receives workspace status (busy)
 * #2c: Renderer receives workspace status (mixed)
 * #2d: Renderer receives workspace status (none)
 * workspace:deleted sends workspace:removed to UI
 * app:shutdown removes IPC handlers and log listeners
 * log listeners delegate to LoggingService
 */

import { createMockDispatcher } from "../intents/lib/dispatcher.test-utils";
import { describe, it, expect, vi } from "vitest";
import { Dispatcher } from "../intents/lib/dispatcher";

import {
  UpdateAgentStatusOperation,
  INTENT_UPDATE_AGENT_STATUS,
} from "../intents/update-agent-status";
import type { UpdateAgentStatusIntent } from "../intents/update-agent-status";
import {
  ResolveWorkspaceOperation,
  RESOLVE_WORKSPACE_OPERATION_ID,
  INTENT_RESOLVE_WORKSPACE,
} from "../intents/resolve-workspace";
import type {
  ResolveHookResult as ResolveWorkspaceHookResult,
  ResolveHookInput as ResolveWorkspaceHookInput,
} from "../intents/resolve-workspace";
import {
  ResolveProjectOperation,
  RESOLVE_PROJECT_OPERATION_ID,
  INTENT_RESOLVE_PROJECT,
} from "../intents/resolve-project";
import type { ResolveHookResult as ResolveProjectHookResult } from "../intents/resolve-project";
import {
  INTENT_DELETE_WORKSPACE,
  EVENT_WORKSPACE_DELETED,
  DELETE_WORKSPACE_OPERATION_ID,
} from "../intents/delete-workspace";
import type { DeleteWorkspaceIntent, WorkspaceDeletedEvent } from "../intents/delete-workspace";
import {
  AppShutdownOperation,
  INTENT_APP_SHUTDOWN,
  APP_SHUTDOWN_OPERATION_ID,
} from "../intents/app-shutdown";
import type { AppShutdownIntent } from "../intents/app-shutdown";
import type { Operation, OperationContext } from "../intents/lib/operation";
import { createUiIpcModule, type UiIpcModuleDeps } from "./ui-ipc-module";
import { createMockLogging } from "../boundaries/platform/logging";
import type { IntentModule } from "../intents/lib/module";
import type { HookContext } from "../intents/lib/operation";
import { ApiIpcChannels, type WorkspacePath, type AggregatedAgentStatus } from "../shared/ipc";
import { EVENT_SHORTCUT_KEY_PRESSED, type ShortcutKeyPressedEvent } from "../intents/shortcut-key";
import { EVENT_WORKSPACE_CREATE_FAILED } from "../intents/open-workspace";
import type { ProjectId, WorkspaceName } from "../shared/api/types";
import { SILENT_LOGGER } from "../boundaries/platform/logging";
import {
  createBehavioralIpcBoundary,
  type BehavioralIpcBoundary,
} from "../boundaries/shell/ipc.test-utils";

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

// =============================================================================
// Test Setup helpers
// =============================================================================

const TEST_PROJECT_ID = "test-project-12345678" as ProjectId;
const TEST_PROJECT_PATH = "/projects/test";
const TEST_WORKSPACE_NAME = "feature-branch" as WorkspaceName;
const TEST_WORKSPACE_PATH = "/projects/test/workspaces/feature-branch";

function createMockResolveModule(): IntentModule {
  return {
    name: "test-resolve",
    hooks: {
      [RESOLVE_WORKSPACE_OPERATION_ID]: {
        resolve: {
          handler: async (ctx: HookContext): Promise<ResolveWorkspaceHookResult> => {
            void (ctx as ResolveWorkspaceHookInput);
            return {
              projectPath: TEST_PROJECT_PATH,
              workspaceName: TEST_WORKSPACE_NAME,
            };
          },
        },
      },
      [RESOLVE_PROJECT_OPERATION_ID]: {
        resolve: {
          handler: async (): Promise<ResolveProjectHookResult> => {
            return { projectId: TEST_PROJECT_ID };
          },
        },
      },
    },
  };
}

type SendToUIMock = ReturnType<typeof vi.fn<(channel: string, ...args: unknown[]) => void>>;

function createBridgeDeps(
  overrides?: Partial<UiIpcModuleDeps>
): UiIpcModuleDeps & { ipcLayer: BehavioralIpcBoundary; sendToUI: SendToUIMock } {
  const ipcLayer = (overrides?.ipcLayer as BehavioralIpcBoundary) ?? createBehavioralIpcBoundary();
  const sendToUI: SendToUIMock =
    (overrides?.viewManager?.sendToUI as SendToUIMock) ??
    vi.fn<(channel: string, ...args: unknown[]) => void>();
  const base: UiIpcModuleDeps = {
    ipcLayer,
    viewManager: { sendToUI },
    logger: SILENT_LOGGER,
    dispatcher: {} as unknown as UiIpcModuleDeps["dispatcher"],
    loggingService: overrides?.loggingService ?? createMockLogging(),
    pathProvider: overrides?.pathProvider ?? ({} as unknown as UiIpcModuleDeps["pathProvider"]),
    ...overrides,
  };
  return { ...base, ipcLayer, sendToUI };
}

// =============================================================================
// Test Setup for agent:status-updated tests
// =============================================================================

interface StatusTestSetup {
  dispatcher: Dispatcher;
  sendToUI: SendToUIMock;
}

function createStatusTestSetup(): StatusTestSetup {
  const dispatcher = createMockDispatcher();

  dispatcher.registerOperation(INTENT_UPDATE_AGENT_STATUS, new UpdateAgentStatusOperation());
  dispatcher.registerOperation(INTENT_RESOLVE_WORKSPACE, new ResolveWorkspaceOperation());
  dispatcher.registerOperation(INTENT_RESOLVE_PROJECT, new ResolveProjectOperation());

  const deps = createBridgeDeps({
    dispatcher: dispatcher as unknown as UiIpcModuleDeps["dispatcher"],
  });
  const uiIpcModule = createUiIpcModule(deps);
  const resolveModule = createMockResolveModule();

  dispatcher.registerModule(uiIpcModule);
  dispatcher.registerModule(resolveModule);

  return { dispatcher, sendToUI: deps.sendToUI };
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
// Tests - agent:status-updated
// =============================================================================

describe("UiIpcModule - agent:status-updated", () => {
  describe("renderer receives workspace status (idle) (#2a)", () => {
    it("sends workspace:status-changed with idle agent status via sendToUI", async () => {
      const { dispatcher, sendToUI } = createStatusTestSetup();

      const status: AggregatedAgentStatus = { status: "idle", counts: { idle: 2, busy: 0 } };
      await dispatcher.dispatch(updateStatusIntent(TEST_WORKSPACE_PATH, status));

      expect(sendToUI).toHaveBeenCalledWith(ApiIpcChannels.WORKSPACE_STATUS_CHANGED, {
        projectId: TEST_PROJECT_ID,
        workspaceName: TEST_WORKSPACE_NAME,
        path: TEST_WORKSPACE_PATH,
        status: {
          isDirty: false,
          unmergedCommits: 0,
          agent: { type: "idle", counts: { idle: 2, busy: 0, total: 2 } },
        },
      });
    });
  });

  describe("renderer receives workspace status (busy) (#2b)", () => {
    it("sends workspace:status-changed with busy agent status via sendToUI", async () => {
      const { dispatcher, sendToUI } = createStatusTestSetup();

      const status: AggregatedAgentStatus = { status: "busy", counts: { idle: 0, busy: 3 } };
      await dispatcher.dispatch(updateStatusIntent(TEST_WORKSPACE_PATH, status));

      expect(sendToUI).toHaveBeenCalledWith(ApiIpcChannels.WORKSPACE_STATUS_CHANGED, {
        projectId: TEST_PROJECT_ID,
        workspaceName: TEST_WORKSPACE_NAME,
        path: TEST_WORKSPACE_PATH,
        status: {
          isDirty: false,
          unmergedCommits: 0,
          agent: { type: "busy", counts: { idle: 0, busy: 3, total: 3 } },
        },
      });
    });
  });

  describe("renderer receives workspace status (mixed) (#2c)", () => {
    it("sends workspace:status-changed with mixed agent status via sendToUI", async () => {
      const { dispatcher, sendToUI } = createStatusTestSetup();

      const status: AggregatedAgentStatus = { status: "mixed", counts: { idle: 1, busy: 2 } };
      await dispatcher.dispatch(updateStatusIntent(TEST_WORKSPACE_PATH, status));

      expect(sendToUI).toHaveBeenCalledWith(ApiIpcChannels.WORKSPACE_STATUS_CHANGED, {
        projectId: TEST_PROJECT_ID,
        workspaceName: TEST_WORKSPACE_NAME,
        path: TEST_WORKSPACE_PATH,
        status: {
          isDirty: false,
          unmergedCommits: 0,
          agent: { type: "mixed", counts: { idle: 1, busy: 2, total: 3 } },
        },
      });
    });
  });

  describe("renderer receives workspace status (none) (#2d)", () => {
    it("sends workspace:status-changed with none agent status via sendToUI", async () => {
      const { dispatcher, sendToUI } = createStatusTestSetup();

      const status: AggregatedAgentStatus = { status: "none", counts: { idle: 0, busy: 0 } };
      await dispatcher.dispatch(updateStatusIntent(TEST_WORKSPACE_PATH, status));

      expect(sendToUI).toHaveBeenCalledWith(ApiIpcChannels.WORKSPACE_STATUS_CHANGED, {
        projectId: TEST_PROJECT_ID,
        workspaceName: TEST_WORKSPACE_NAME,
        path: TEST_WORKSPACE_PATH,
        status: {
          isDirty: false,
          unmergedCommits: 0,
          agent: { type: "none" },
        },
      });
    });
  });
});

// =============================================================================
// Tests - workspace:deleted event
// =============================================================================

describe("UiIpcModule - workspace:deleted", () => {
  it("sends workspace:removed to UI on workspace:deleted event", async () => {
    const dispatcher = createMockDispatcher();

    dispatcher.registerOperation(
      INTENT_DELETE_WORKSPACE,
      new MinimalDeleteOperation(TEST_PROJECT_ID, TEST_WORKSPACE_NAME, TEST_PROJECT_PATH)
    );
    dispatcher.registerOperation(INTENT_APP_SHUTDOWN, new AppShutdownOperation());

    const deps = createBridgeDeps({
      dispatcher: dispatcher as unknown as UiIpcModuleDeps["dispatcher"],
    });
    const uiIpcModule = createUiIpcModule(deps);

    const quitModule: IntentModule = {
      name: "test-quit",
      hooks: {
        [APP_SHUTDOWN_OPERATION_ID]: {
          quit: { handler: async () => {} },
        },
      },
    };

    dispatcher.registerModule(uiIpcModule);
    dispatcher.registerModule(quitModule);

    await dispatcher.dispatch({
      type: INTENT_DELETE_WORKSPACE,
      payload: {
        workspacePath: TEST_WORKSPACE_PATH,
        keepBranch: false,
        force: false,
        removeWorktree: true,
      },
    } as DeleteWorkspaceIntent);

    expect(deps.sendToUI).toHaveBeenCalledWith(ApiIpcChannels.WORKSPACE_REMOVED, {
      projectId: TEST_PROJECT_ID,
      workspaceName: TEST_WORKSPACE_NAME,
      path: TEST_WORKSPACE_PATH,
    });
  });
});

// =============================================================================
// Tests - bases:updated event
// =============================================================================

describe("UiIpcModule - bases:updated", () => {
  it("sends project:bases-updated to UI on bases:updated domain event", async () => {
    const deps = createBridgeDeps();
    const uiIpcModule = createUiIpcModule(deps);

    const bases = [
      { name: "main", isRemote: false },
      { name: "origin/main", isRemote: true },
    ];

    // Call the event handler directly
    await uiIpcModule.events!["bases:updated"]!.handler({
      type: "bases:updated",
      payload: {
        projectId: TEST_PROJECT_ID,
        projectPath: TEST_PROJECT_PATH,
        bases,
      },
    });

    expect(deps.sendToUI).toHaveBeenCalledWith(ApiIpcChannels.PROJECT_BASES_UPDATED, {
      projectId: TEST_PROJECT_ID,
      projectPath: TEST_PROJECT_PATH,
      bases,
    });
  });

  it("forwards defaultBaseBranch when the event carries one", async () => {
    const deps = createBridgeDeps();
    const uiIpcModule = createUiIpcModule(deps);

    const bases = [{ name: "origin/main", isRemote: true }];

    await uiIpcModule.events!["bases:updated"]!.handler({
      type: "bases:updated",
      payload: {
        projectId: TEST_PROJECT_ID,
        projectPath: TEST_PROJECT_PATH,
        bases,
        defaultBaseBranch: "origin/main",
      },
    });

    expect(deps.sendToUI).toHaveBeenCalledWith(ApiIpcChannels.PROJECT_BASES_UPDATED, {
      projectId: TEST_PROJECT_ID,
      projectPath: TEST_PROJECT_PATH,
      bases,
      defaultBaseBranch: "origin/main",
    });
  });
});

// =============================================================================
// Tests - workspace:create-failed event
// =============================================================================

describe("UiIpcModule - workspace:create-failed", () => {
  it("forwards workspace:create-failed to the UI", async () => {
    const deps = createBridgeDeps();
    const uiIpcModule = createUiIpcModule(deps);

    // Call the event handler directly (mirrors bases:updated test style)
    await uiIpcModule.events![EVENT_WORKSPACE_CREATE_FAILED]!.handler({
      type: EVENT_WORKSPACE_CREATE_FAILED,
      payload: {
        workspaceName: TEST_WORKSPACE_NAME,
        projectPath: TEST_PROJECT_PATH,
        error: "boom",
      },
    });

    expect(deps.sendToUI).toHaveBeenCalledWith(ApiIpcChannels.WORKSPACE_CREATE_FAILED, {
      workspaceName: TEST_WORKSPACE_NAME,
      projectPath: TEST_PROJECT_PATH,
      error: "boom",
    });
  });
});

// NOTE: workspace:deletion-progress tests removed — now handled by deletion-dialog-module

// =============================================================================
// Tests - IPC handler registration
// =============================================================================

describe("UiIpcModule - IPC handlers", () => {
  it("registers IPC handlers on ipcLayer", () => {
    const ipcLayer = createBehavioralIpcBoundary();
    const deps = createBridgeDeps({ ipcLayer });
    createUiIpcModule(deps);

    const state = ipcLayer._getState();
    expect(state.handlers.has(ApiIpcChannels.LIFECYCLE_READY)).toBe(true);
    expect(state.handlers.has(ApiIpcChannels.LIFECYCLE_QUIT)).toBe(true);
    expect(state.handlers.has(ApiIpcChannels.WORKSPACE_CREATE)).toBe(true);
    expect(state.handlers.has(ApiIpcChannels.WORKSPACE_REMOVE)).toBe(true);
    expect(state.handlers.has(ApiIpcChannels.PROJECT_OPEN)).toBe(true);
    expect(state.handlers.has(ApiIpcChannels.UI_SET_MODE)).toBe(true);
  });

  it("lifecycle.ready IPC handler dispatches app:ready intent", async () => {
    const ipcLayer = createBehavioralIpcBoundary();
    const dispatcher = {
      dispatch: vi.fn().mockResolvedValue(undefined),
    } as unknown as UiIpcModuleDeps["dispatcher"];
    const deps = createBridgeDeps({ ipcLayer, dispatcher });
    createUiIpcModule(deps);

    await ipcLayer._invoke(ApiIpcChannels.LIFECYCLE_READY, undefined);

    expect(dispatcher.dispatch).toHaveBeenCalledWith({
      type: "app:ready",
      payload: {},
    });
  });
});

// =============================================================================
// Tests - shutdown cleanup
// =============================================================================

describe("UiIpcModule - shutdown", () => {
  it("removes all IPC handlers on app:shutdown", async () => {
    const dispatcher = createMockDispatcher();
    dispatcher.registerOperation(INTENT_APP_SHUTDOWN, new AppShutdownOperation());

    const ipcLayer = createBehavioralIpcBoundary();
    const deps = createBridgeDeps({
      ipcLayer,
      dispatcher: dispatcher as unknown as UiIpcModuleDeps["dispatcher"],
    });
    const uiIpcModule = createUiIpcModule(deps);

    const quitModule: IntentModule = {
      name: "test-quit",
      hooks: {
        [APP_SHUTDOWN_OPERATION_ID]: {
          quit: { handler: async () => {} },
        },
      },
    };

    dispatcher.registerModule(uiIpcModule);
    dispatcher.registerModule(quitModule);

    // Verify handlers are registered
    const stateBefore = ipcLayer._getState();
    expect(stateBefore.handlers.size).toBeGreaterThan(0);

    // Shutdown
    await dispatcher.dispatch({
      type: INTENT_APP_SHUTDOWN,
      payload: {},
    } as AppShutdownIntent);

    // All handlers should be removed
    const stateAfter = ipcLayer._getState();
    expect(stateAfter.handlers.size).toBe(0);
  });

  it("shutdown with already-removed handler does not throw", async () => {
    const dispatcher = createMockDispatcher();
    dispatcher.registerOperation(INTENT_APP_SHUTDOWN, new AppShutdownOperation());

    const ipcLayer = createBehavioralIpcBoundary();
    const deps = createBridgeDeps({
      ipcLayer,
      dispatcher: dispatcher as unknown as UiIpcModuleDeps["dispatcher"],
    });
    const uiIpcModule = createUiIpcModule(deps);

    const quitModule: IntentModule = {
      name: "test-quit",
      hooks: {
        [APP_SHUTDOWN_OPERATION_ID]: {
          quit: { handler: async () => {} },
        },
      },
    };

    dispatcher.registerModule(uiIpcModule);
    dispatcher.registerModule(quitModule);

    // Remove a handler manually before shutdown
    ipcLayer.removeHandler(ApiIpcChannels.LIFECYCLE_READY);

    // Shutdown should still succeed (catches the error for the already-removed handler)
    await expect(
      dispatcher.dispatch({
        type: INTENT_APP_SHUTDOWN,
        payload: {},
      } as AppShutdownIntent)
    ).resolves.not.toThrow();
  });
});

// NOTE: setup:error forwarding tests removed — setup:error is now handled by view-module
// via DialogManager, not the IPC event bridge.

// =============================================================================
// Tests - shortcut:key-pressed event
// =============================================================================

describe("UiIpcModule - shortcut:key-pressed", () => {
  it("forwards recognized shortcut keys to renderer via sendToUI", async () => {
    const deps = createBridgeDeps();
    const uiIpcModule = createUiIpcModule(deps);

    const event: ShortcutKeyPressedEvent = {
      type: EVENT_SHORTCUT_KEY_PRESSED,
      payload: { key: "up" },
    };
    await uiIpcModule.events![EVENT_SHORTCUT_KEY_PRESSED]!.handler(event);

    expect(deps.sendToUI).toHaveBeenCalledWith(ApiIpcChannels.SHORTCUT_KEY, "up");
  });

  it("forwards digit keys to renderer via sendToUI", async () => {
    const deps = createBridgeDeps();
    const uiIpcModule = createUiIpcModule(deps);

    const event: ShortcutKeyPressedEvent = {
      type: EVENT_SHORTCUT_KEY_PRESSED,
      payload: { key: "5" },
    };
    await uiIpcModule.events![EVENT_SHORTCUT_KEY_PRESSED]!.handler(event);

    expect(deps.sendToUI).toHaveBeenCalledWith(ApiIpcChannels.SHORTCUT_KEY, "5");
  });

  it("does not forward unrecognized keys to renderer", async () => {
    const deps = createBridgeDeps();
    const uiIpcModule = createUiIpcModule(deps);

    const event: ShortcutKeyPressedEvent = {
      type: EVENT_SHORTCUT_KEY_PRESSED,
      payload: { key: "d" },
    };
    await uiIpcModule.events![EVENT_SHORTCUT_KEY_PRESSED]!.handler(event);

    expect(deps.sendToUI).not.toHaveBeenCalled();
  });

  it("does not forward escape to renderer", async () => {
    const deps = createBridgeDeps();
    const uiIpcModule = createUiIpcModule(deps);

    const event: ShortcutKeyPressedEvent = {
      type: EVENT_SHORTCUT_KEY_PRESSED,
      payload: { key: "escape" },
    };
    await uiIpcModule.events![EVENT_SHORTCUT_KEY_PRESSED]!.handler(event);

    expect(deps.sendToUI).not.toHaveBeenCalled();
  });
});

// =============================================================================
// executeCommand tests (via IPC handler)
// =============================================================================

describe("UiIpcModule - executeCommand", () => {
  it("is not exposed via IPC (only used by MCP/Plugin)", () => {
    // executeCommand is registered as an apiRegistry method in the old code
    // but was not exposed via IPC. Now it's gone entirely from the bridge.
    // MCP/Plugin handlers dispatch intents directly.
    const ipcLayer = createBehavioralIpcBoundary();
    const deps = createBridgeDeps({ ipcLayer });
    createUiIpcModule(deps);

    // No IPC channel for executeCommand
    const state = ipcLayer._getState();
    const channels = [...state.handlers.keys()];
    expect(channels.every((ch) => !ch.includes("execute-command"))).toBe(true);
  });
});

// =============================================================================
// Tests - log listeners
// =============================================================================

describe("UiIpcModule - log listeners", () => {
  it("registers listeners on all four log channels", () => {
    const ipcLayer = createBehavioralIpcBoundary();
    const deps = createBridgeDeps({ ipcLayer });
    createUiIpcModule(deps);

    expect(ipcLayer._getListeners(ApiIpcChannels.LOG_DEBUG)).toHaveLength(1);
    expect(ipcLayer._getListeners(ApiIpcChannels.LOG_INFO)).toHaveLength(1);
    expect(ipcLayer._getListeners(ApiIpcChannels.LOG_WARN)).toHaveLength(1);
    expect(ipcLayer._getListeners(ApiIpcChannels.LOG_ERROR)).toHaveLength(1);
  });

  it("delegates log messages to the correct logger method", () => {
    const ipcLayer = createBehavioralIpcBoundary();
    const loggingService = createMockLogging();
    const deps = createBridgeDeps({ ipcLayer, loggingService });
    createUiIpcModule(deps);

    ipcLayer._emit(ApiIpcChannels.LOG_INFO, {
      logger: "ui",
      message: "test message",
      context: { key: "value" },
    });

    expect(loggingService.createLogger).toHaveBeenCalledWith("ui");
    const logger = loggingService.getLogger("ui");
    expect(logger?.info).toHaveBeenCalledWith("test message", { key: "value" });
  });

  it("falls back to 'ui' logger for invalid logger names", () => {
    const ipcLayer = createBehavioralIpcBoundary();
    const loggingService = createMockLogging();
    const deps = createBridgeDeps({ ipcLayer, loggingService });
    createUiIpcModule(deps);

    ipcLayer._emit(ApiIpcChannels.LOG_WARN, {
      logger: "invalid-name",
      message: "fallback test",
    });

    expect(loggingService.createLogger).toHaveBeenCalledWith("ui");
    const logger = loggingService.getLogger("ui");
    expect(logger?.warn).toHaveBeenCalledWith("fallback test", undefined);
  });

  it("accepts 'api' as a valid renderer logger name", () => {
    const ipcLayer = createBehavioralIpcBoundary();
    const loggingService = createMockLogging();
    const deps = createBridgeDeps({ ipcLayer, loggingService });
    createUiIpcModule(deps);

    ipcLayer._emit(ApiIpcChannels.LOG_DEBUG, {
      logger: "api",
      message: "api log",
    });

    expect(loggingService.createLogger).toHaveBeenCalledWith("api");
  });

  it("swallows errors from logging service", () => {
    const ipcLayer = createBehavioralIpcBoundary();
    const loggingService = createMockLogging();
    loggingService.createLogger = vi.fn(() => {
      throw new Error("logging broke");
    });
    const deps = createBridgeDeps({ ipcLayer, loggingService });
    createUiIpcModule(deps);

    // Should not throw
    expect(() => {
      ipcLayer._emit(ApiIpcChannels.LOG_ERROR, {
        logger: "ui",
        message: "should not crash",
      });
    }).not.toThrow();
  });

  it("removes log listeners on app:shutdown", async () => {
    const dispatcher = createMockDispatcher();
    dispatcher.registerOperation(INTENT_APP_SHUTDOWN, new AppShutdownOperation());

    const ipcLayer = createBehavioralIpcBoundary();
    const deps = createBridgeDeps({
      ipcLayer,
      dispatcher: dispatcher as unknown as UiIpcModuleDeps["dispatcher"],
    });
    const uiIpcModule = createUiIpcModule(deps);

    const quitModule: IntentModule = {
      name: "test-quit",
      hooks: {
        [APP_SHUTDOWN_OPERATION_ID]: {
          quit: { handler: async () => {} },
        },
      },
    };

    dispatcher.registerModule(uiIpcModule);
    dispatcher.registerModule(quitModule);

    // Verify listeners are registered
    expect(ipcLayer._getListeners(ApiIpcChannels.LOG_DEBUG)).toHaveLength(1);

    // Shutdown
    await dispatcher.dispatch({
      type: INTENT_APP_SHUTDOWN,
      payload: {},
    } as AppShutdownIntent);

    // All log listeners should be removed
    expect(ipcLayer._getListeners(ApiIpcChannels.LOG_DEBUG)).toHaveLength(0);
    expect(ipcLayer._getListeners(ApiIpcChannels.LOG_INFO)).toHaveLength(0);
    expect(ipcLayer._getListeners(ApiIpcChannels.LOG_WARN)).toHaveLength(0);
    expect(ipcLayer._getListeners(ApiIpcChannels.LOG_ERROR)).toHaveLength(0);
  });
});
