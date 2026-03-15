// @vitest-environment node
/**
 * Integration tests for IpcEventBridge.
 *
 * Tests verify the full pipeline: dispatcher -> operation -> domain event -> sendToUI.
 * Also covers IPC handler registration and shutdown cleanup.
 *
 * Test plan items covered:
 * #2a: Renderer receives workspace status (idle)
 * #2b: Renderer receives workspace status (busy)
 * #2c: Renderer receives workspace status (mixed)
 * #2d: Renderer receives workspace status (none)
 * workspace:deleted sends workspace:removed to UI
 * app:shutdown removes IPC handlers
 */

import { describe, it, expect, vi } from "vitest";
import { Dispatcher } from "../intents/infrastructure/dispatcher";

import {
  UpdateAgentStatusOperation,
  INTENT_UPDATE_AGENT_STATUS,
} from "../operations/update-agent-status";
import type { UpdateAgentStatusIntent } from "../operations/update-agent-status";
import {
  ResolveWorkspaceOperation,
  RESOLVE_WORKSPACE_OPERATION_ID,
  INTENT_RESOLVE_WORKSPACE,
} from "../operations/resolve-workspace";
import type {
  ResolveHookResult as ResolveWorkspaceHookResult,
  ResolveHookInput as ResolveWorkspaceHookInput,
} from "../operations/resolve-workspace";
import {
  ResolveProjectOperation,
  RESOLVE_PROJECT_OPERATION_ID,
  INTENT_RESOLVE_PROJECT,
} from "../operations/resolve-project";
import type { ResolveHookResult as ResolveProjectHookResult } from "../operations/resolve-project";
import {
  INTENT_DELETE_WORKSPACE,
  EVENT_WORKSPACE_DELETED,
  EVENT_WORKSPACE_DELETION_PROGRESS,
  DELETE_WORKSPACE_OPERATION_ID,
} from "../operations/delete-workspace";
import type {
  DeleteWorkspaceIntent,
  WorkspaceDeletedEvent,
  WorkspaceDeletionProgressEvent,
} from "../operations/delete-workspace";
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
import type { IntentModule } from "../intents/infrastructure/module";
import type { HookContext } from "../intents/infrastructure/operation";
import { ApiIpcChannels, type WorkspacePath, type AggregatedAgentStatus } from "../../shared/ipc";
import {
  EVENT_SHORTCUT_KEY_PRESSED,
  type ShortcutKeyPressedEvent,
} from "../operations/shortcut-key";
import type { ProjectId, WorkspaceName } from "../../shared/api/types";
import { SILENT_LOGGER, createMockLogger } from "../../services/logging";
import {
  createBehavioralIpcLayer,
  type BehavioralIpcLayer,
} from "../../services/platform/ipc.test-utils";

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
  overrides?: Partial<IpcEventBridgeDeps>
): IpcEventBridgeDeps & { ipcLayer: BehavioralIpcLayer; sendToUI: SendToUIMock } {
  const ipcLayer = (overrides?.ipcLayer as BehavioralIpcLayer) ?? createBehavioralIpcLayer();
  const sendToUI: SendToUIMock =
    (overrides?.viewManager?.sendToUI as SendToUIMock) ??
    vi.fn<(channel: string, ...args: unknown[]) => void>();
  const base: IpcEventBridgeDeps = {
    ipcLayer,
    viewManager: { sendToUI },
    logger: SILENT_LOGGER,
    dispatcher: {} as unknown as IpcEventBridgeDeps["dispatcher"],
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
  const dispatcher = new Dispatcher({ logger: createMockLogger() });

  dispatcher.registerOperation(INTENT_UPDATE_AGENT_STATUS, new UpdateAgentStatusOperation());
  dispatcher.registerOperation(INTENT_RESOLVE_WORKSPACE, new ResolveWorkspaceOperation());
  dispatcher.registerOperation(INTENT_RESOLVE_PROJECT, new ResolveProjectOperation());

  const deps = createBridgeDeps({
    dispatcher: dispatcher as unknown as IpcEventBridgeDeps["dispatcher"],
  });
  const ipcEventBridge = createIpcEventBridge(deps);
  const resolveModule = createMockResolveModule();

  dispatcher.registerModule(ipcEventBridge);
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

describe("IpcEventBridge - agent:status-updated", () => {
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

describe("IpcEventBridge - workspace:deleted", () => {
  it("sends workspace:removed to UI on workspace:deleted event", async () => {
    const dispatcher = new Dispatcher({ logger: createMockLogger() });

    dispatcher.registerOperation(
      INTENT_DELETE_WORKSPACE,
      new MinimalDeleteOperation(TEST_PROJECT_ID, TEST_WORKSPACE_NAME, TEST_PROJECT_PATH)
    );
    dispatcher.registerOperation(INTENT_APP_SHUTDOWN, new AppShutdownOperation());

    const deps = createBridgeDeps({
      dispatcher: dispatcher as unknown as IpcEventBridgeDeps["dispatcher"],
    });
    const ipcEventBridge = createIpcEventBridge(deps);

    const quitModule: IntentModule = {
      name: "test-quit",
      hooks: {
        [APP_SHUTDOWN_OPERATION_ID]: {
          quit: { handler: async () => {} },
        },
      },
    };

    dispatcher.registerModule(ipcEventBridge);
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

describe("IpcEventBridge - bases:updated", () => {
  it("sends project:bases-updated to UI on bases:updated domain event", async () => {
    const deps = createBridgeDeps();
    const ipcEventBridge = createIpcEventBridge(deps);

    const bases = [
      { name: "main", isRemote: false },
      { name: "origin/main", isRemote: true },
    ];

    // Call the event handler directly
    await ipcEventBridge.events!["bases:updated"]!.handler({
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
});

// =============================================================================
// Tests - workspace:deletion-progress event
// =============================================================================

describe("IpcEventBridge - workspace:deletion-progress", () => {
  it("sends deletion progress to UI via sendToUI", async () => {
    const deps = createBridgeDeps();
    const ipcEventBridge = createIpcEventBridge(deps);

    const progressPayload = {
      workspacePath: TEST_WORKSPACE_PATH as WorkspacePath,
      workspaceName: TEST_WORKSPACE_NAME,
      projectId: TEST_PROJECT_ID,
      keepBranch: true,
      operations: [
        {
          id: "kill-terminals" as const,
          label: "Terminating processes",
          status: "done" as const,
        },
      ],
      completed: false,
      hasErrors: false,
    };
    const event: WorkspaceDeletionProgressEvent = {
      type: EVENT_WORKSPACE_DELETION_PROGRESS,
      payload: progressPayload,
    };

    await ipcEventBridge.events![EVENT_WORKSPACE_DELETION_PROGRESS]!.handler(event);

    expect(deps.sendToUI).toHaveBeenCalledWith(
      ApiIpcChannels.WORKSPACE_DELETION_PROGRESS,
      progressPayload
    );
  });

  it("ignores when sendToUI is a no-op", async () => {
    const deps = createBridgeDeps();
    const ipcEventBridge = createIpcEventBridge(deps);

    const event: WorkspaceDeletionProgressEvent = {
      type: EVENT_WORKSPACE_DELETION_PROGRESS,
      payload: {
        workspacePath: TEST_WORKSPACE_PATH as WorkspacePath,
        workspaceName: TEST_WORKSPACE_NAME,
        projectId: TEST_PROJECT_ID,
        keepBranch: false,
        operations: [],
        completed: true,
        hasErrors: false,
      },
    };
    await expect(
      ipcEventBridge.events![EVENT_WORKSPACE_DELETION_PROGRESS]!.handler(event)
    ).resolves.not.toThrow();
  });
});

// =============================================================================
// Tests - IPC handler registration
// =============================================================================

describe("IpcEventBridge - IPC handlers", () => {
  it("registers IPC handlers on ipcLayer", () => {
    const ipcLayer = createBehavioralIpcLayer();
    const deps = createBridgeDeps({ ipcLayer });
    createIpcEventBridge(deps);

    const state = ipcLayer._getState();
    expect(state.handlers.has(ApiIpcChannels.LIFECYCLE_READY)).toBe(true);
    expect(state.handlers.has(ApiIpcChannels.LIFECYCLE_QUIT)).toBe(true);
    expect(state.handlers.has(ApiIpcChannels.WORKSPACE_CREATE)).toBe(true);
    expect(state.handlers.has(ApiIpcChannels.WORKSPACE_REMOVE)).toBe(true);
    expect(state.handlers.has(ApiIpcChannels.PROJECT_OPEN)).toBe(true);
    expect(state.handlers.has(ApiIpcChannels.UI_SET_MODE)).toBe(true);
  });

  it("lifecycle.ready IPC handler dispatches app:ready intent", async () => {
    const ipcLayer = createBehavioralIpcLayer();
    const dispatcher = {
      dispatch: vi.fn().mockResolvedValue(undefined),
    } as unknown as IpcEventBridgeDeps["dispatcher"];
    const deps = createBridgeDeps({ ipcLayer, dispatcher });
    createIpcEventBridge(deps);

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

describe("IpcEventBridge - shutdown", () => {
  it("removes all IPC handlers on app:shutdown", async () => {
    const dispatcher = new Dispatcher({ logger: createMockLogger() });
    dispatcher.registerOperation(INTENT_APP_SHUTDOWN, new AppShutdownOperation());

    const ipcLayer = createBehavioralIpcLayer();
    const deps = createBridgeDeps({
      ipcLayer,
      dispatcher: dispatcher as unknown as IpcEventBridgeDeps["dispatcher"],
    });
    const ipcEventBridge = createIpcEventBridge(deps);

    const quitModule: IntentModule = {
      name: "test-quit",
      hooks: {
        [APP_SHUTDOWN_OPERATION_ID]: {
          quit: { handler: async () => {} },
        },
      },
    };

    dispatcher.registerModule(ipcEventBridge);
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
    const dispatcher = new Dispatcher({ logger: createMockLogger() });
    dispatcher.registerOperation(INTENT_APP_SHUTDOWN, new AppShutdownOperation());

    const ipcLayer = createBehavioralIpcLayer();
    const deps = createBridgeDeps({
      ipcLayer,
      dispatcher: dispatcher as unknown as IpcEventBridgeDeps["dispatcher"],
    });
    const ipcEventBridge = createIpcEventBridge(deps);

    const quitModule: IntentModule = {
      name: "test-quit",
      hooks: {
        [APP_SHUTDOWN_OPERATION_ID]: {
          quit: { handler: async () => {} },
        },
      },
    };

    dispatcher.registerModule(ipcEventBridge);
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

// =============================================================================
// setup:error -> lifecycle:setup-error bridge tests
// =============================================================================

describe("IpcEventBridge - setup:error", () => {
  function createSetupErrorTestSetup(): {
    dispatcher: Dispatcher;
    sendToUI: SendToUIMock;
  } {
    const dispatcher = new Dispatcher({ logger: createMockLogger() });

    dispatcher.registerOperation(INTENT_SETUP, new SetupOperation());

    const deps = createBridgeDeps({
      dispatcher: dispatcher as unknown as IpcEventBridgeDeps["dispatcher"],
    });
    const ipcEventBridge = createIpcEventBridge(deps);

    const failingSetupHook: IntentModule = {
      name: "test-failing-setup",
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

    dispatcher.registerModule(ipcEventBridge);
    dispatcher.registerModule(failingSetupHook);

    return { dispatcher, sendToUI: deps.sendToUI };
  }

  it("sends lifecycle:setup-error to UI when setup operation fails", async () => {
    const { dispatcher, sendToUI } = createSetupErrorTestSetup();

    const intent: SetupIntent = {
      type: INTENT_SETUP,
      payload: {},
    };

    await expect(dispatcher.dispatch(intent)).rejects.toThrow("Download failed");

    expect(sendToUI).toHaveBeenCalledWith(ApiIpcChannels.LIFECYCLE_SETUP_ERROR, {
      message: "Download failed",
    });
  });

  it("includes error code when present", async () => {
    const dispatcher = new Dispatcher({ logger: createMockLogger() });

    dispatcher.registerOperation(INTENT_SETUP, new SetupOperation());

    const deps = createBridgeDeps({
      dispatcher: dispatcher as unknown as IpcEventBridgeDeps["dispatcher"],
    });
    const ipcEventBridge = createIpcEventBridge(deps);

    const errorWithCode = Object.assign(new Error("Network timeout"), { code: "ETIMEDOUT" });
    const failingHook: IntentModule = {
      name: "test-failing-hook",
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

    dispatcher.registerModule(ipcEventBridge);
    dispatcher.registerModule(failingHook);

    const intent: SetupIntent = { type: INTENT_SETUP, payload: {} };
    await expect(dispatcher.dispatch(intent)).rejects.toThrow("Network timeout");

    expect(deps.sendToUI).toHaveBeenCalledWith(ApiIpcChannels.LIFECYCLE_SETUP_ERROR, {
      message: "Network timeout",
      code: "ETIMEDOUT",
    });
  });
});

// =============================================================================
// Tests - shortcut:key-pressed event
// =============================================================================

describe("IpcEventBridge - shortcut:key-pressed", () => {
  it("forwards recognized shortcut keys to renderer via sendToUI", async () => {
    const deps = createBridgeDeps();
    const ipcEventBridge = createIpcEventBridge(deps);

    const event: ShortcutKeyPressedEvent = {
      type: EVENT_SHORTCUT_KEY_PRESSED,
      payload: { key: "up" },
    };
    await ipcEventBridge.events![EVENT_SHORTCUT_KEY_PRESSED]!.handler(event);

    expect(deps.sendToUI).toHaveBeenCalledWith(ApiIpcChannels.SHORTCUT_KEY, "up");
  });

  it("forwards digit keys to renderer via sendToUI", async () => {
    const deps = createBridgeDeps();
    const ipcEventBridge = createIpcEventBridge(deps);

    const event: ShortcutKeyPressedEvent = {
      type: EVENT_SHORTCUT_KEY_PRESSED,
      payload: { key: "5" },
    };
    await ipcEventBridge.events![EVENT_SHORTCUT_KEY_PRESSED]!.handler(event);

    expect(deps.sendToUI).toHaveBeenCalledWith(ApiIpcChannels.SHORTCUT_KEY, "5");
  });

  it("does not forward unrecognized keys to renderer", async () => {
    const deps = createBridgeDeps();
    const ipcEventBridge = createIpcEventBridge(deps);

    const event: ShortcutKeyPressedEvent = {
      type: EVENT_SHORTCUT_KEY_PRESSED,
      payload: { key: "d" },
    };
    await ipcEventBridge.events![EVENT_SHORTCUT_KEY_PRESSED]!.handler(event);

    expect(deps.sendToUI).not.toHaveBeenCalled();
  });

  it("does not forward escape to renderer", async () => {
    const deps = createBridgeDeps();
    const ipcEventBridge = createIpcEventBridge(deps);

    const event: ShortcutKeyPressedEvent = {
      type: EVENT_SHORTCUT_KEY_PRESSED,
      payload: { key: "escape" },
    };
    await ipcEventBridge.events![EVENT_SHORTCUT_KEY_PRESSED]!.handler(event);

    expect(deps.sendToUI).not.toHaveBeenCalled();
  });
});

// =============================================================================
// executeCommand tests (via IPC handler)
// =============================================================================

describe("IpcEventBridge - executeCommand", () => {
  it("is not exposed via IPC (only used by MCP/Plugin)", () => {
    // executeCommand is registered as an apiRegistry method in the old code
    // but was not exposed via IPC. Now it's gone entirely from the bridge.
    // MCP/Plugin handlers dispatch intents directly.
    const ipcLayer = createBehavioralIpcLayer();
    const deps = createBridgeDeps({ ipcLayer });
    createIpcEventBridge(deps);

    // No IPC channel for executeCommand
    const state = ipcLayer._getState();
    const channels = [...state.handlers.keys()];
    expect(channels.every((ch) => !ch.includes("execute-command"))).toBe(true);
  });
});
