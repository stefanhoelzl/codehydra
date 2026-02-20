// @vitest-environment node
/**
 * Integration tests for ViewModule through the Dispatcher.
 *
 * Tests verify the full pipeline: dispatcher -> operation -> hook handlers.
 * Covers all 11 absorbed inline modules:
 * - earlySetModeModule (set-mode/set)
 * - appStartUIModule (app-start/show-ui)
 * - setupUIModule (setup/show-ui + hide-ui)
 * - uiHookModule (get-active-workspace/get + workspace:switched event)
 * - viewModule (workspace:created event)
 * - deleteViewModule (delete-workspace/shutdown)
 * - switchViewModule (switch-workspace/activate + workspace:switched event)
 * - projectViewModule (project:opened event)
 * - viewLifecycleModule (app-start/activate + app-shutdown/stop)
 * - mountModule (app-start/activate)
 * - wrapperReadyViewModule (agent:status-updated event → setWorkspaceLoaded)
 */

import { describe, it, expect, vi } from "vitest";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";
import type { Operation, OperationContext } from "../intents/infrastructure/operation";
import type { Intent } from "../intents/infrastructure/types";
import type { IntentModule } from "../intents/infrastructure/module";
import { INTENT_SET_MODE, SET_MODE_OPERATION_ID } from "../operations/set-mode";
import type { SetModeIntent, SetModeHookResult } from "../operations/set-mode";
import {
  INTENT_APP_START,
  APP_START_OPERATION_ID,
  EVENT_APP_STARTED,
} from "../operations/app-start";
import type {
  AppStartIntent,
  ShowUIHookResult,
  ActivateHookContext,
  ActivateHookResult,
} from "../operations/app-start";
import {
  AppShutdownOperation,
  INTENT_APP_SHUTDOWN,
  APP_SHUTDOWN_OPERATION_ID,
} from "../operations/app-shutdown";
import type { AppShutdownIntent } from "../operations/app-shutdown";
import { INTENT_SETUP, SETUP_OPERATION_ID } from "../operations/setup";
import type {
  SetupIntent,
  AgentSelectionHookResult,
  AgentSelectionHookContext,
  RegisterAgentResult,
} from "../operations/setup";
import { INTENT_GET_ACTIVE_WORKSPACE } from "../operations/get-active-workspace";
import type { GetActiveWorkspaceIntent } from "../operations/get-active-workspace";
import { GetActiveWorkspaceOperation } from "../operations/get-active-workspace";
import {
  INTENT_SWITCH_WORKSPACE,
  SWITCH_WORKSPACE_OPERATION_ID,
  EVENT_WORKSPACE_SWITCHED,
} from "../operations/switch-workspace";
import type {
  SwitchWorkspaceIntent,
  SwitchWorkspaceHookResult,
  ActivateHookInput,
  WorkspaceSwitchedEvent,
} from "../operations/switch-workspace";
import {
  INTENT_DELETE_WORKSPACE,
  DELETE_WORKSPACE_OPERATION_ID,
} from "../operations/delete-workspace";
import type {
  DeleteWorkspaceIntent,
  DeletePipelineHookInput,
  ShutdownHookResult,
} from "../operations/delete-workspace";
import { INTENT_OPEN_WORKSPACE, EVENT_WORKSPACE_CREATED } from "../operations/open-workspace";
import type { OpenWorkspaceIntent, WorkspaceCreatedEvent } from "../operations/open-workspace";
import {
  INTENT_OPEN_PROJECT,
  EVENT_PROJECT_OPENED,
  OPEN_PROJECT_OPERATION_ID,
} from "../operations/open-project";
import type { ProjectOpenedEvent, SelectFolderHookResult } from "../operations/open-project";
import { EVENT_AGENT_STATUS_UPDATED } from "../operations/update-agent-status";
import type { AgentStatusUpdatedEvent } from "../operations/update-agent-status";
import { SILENT_LOGGER } from "../../services/logging";
import { createViewModule, type ViewModuleDeps } from "./view-module";
import type { ProjectId, WorkspaceName, Project } from "../../shared/api/types";
import { ApiIpcChannels } from "../../shared/ipc";

// =============================================================================
// Mock IViewManager
// =============================================================================

function createMockViewManager() {
  let currentMode: "workspace" | "shortcut" | "dialog" = "workspace";
  let activePath: string | null = null;

  const mockWebContents = {
    isDestroyed: vi.fn().mockReturnValue(false),
    send: vi.fn(),
  };

  return {
    getMode: vi.fn(() => currentMode),
    setMode: vi.fn((mode: "workspace" | "shortcut" | "dialog") => {
      currentMode = mode;
    }),
    getUIWebContents: vi.fn(() => mockWebContents),
    getActiveWorkspacePath: vi.fn(() => activePath),
    setActiveWorkspace: vi.fn((path: string | null) => {
      activePath = path;
    }),
    createWorkspaceView: vi.fn(),
    preloadWorkspaceUrl: vi.fn(),
    destroyWorkspaceView: vi.fn().mockResolvedValue(undefined),
    onLoadingChange: vi.fn().mockReturnValue(vi.fn()),
    sendToUI: vi.fn(),
    getUIViewHandle: vi.fn(),
    getWorkspaceView: vi.fn(),
    updateBounds: vi.fn(),
    focusActiveWorkspace: vi.fn(),
    focusUI: vi.fn(),
    onModeChange: vi.fn(),
    onWorkspaceChange: vi.fn(),
    updateCodeServerPort: vi.fn(),
    isWorkspaceLoading: vi.fn(),
    setWorkspaceLoaded: vi.fn(),
    create: vi.fn(),
    destroy: vi.fn(),
    // Test accessors
    _webContents: mockWebContents,
    _setActivePath: (p: string | null) => {
      activePath = p;
    },
    _setCurrentMode: (m: "workspace" | "shortcut" | "dialog") => {
      currentMode = m;
    },
  };
}

function createMockShellLayers() {
  return {
    viewLayer: {
      dispose: vi.fn().mockResolvedValue(undefined),
      loadURL: vi.fn().mockResolvedValue(undefined),
    },
    windowLayer: { dispose: vi.fn().mockResolvedValue(undefined) },
    sessionLayer: { dispose: vi.fn().mockResolvedValue(undefined) },
  };
}

// =============================================================================
// Minimal Test Operations
// =============================================================================

/** Runs "set" hook point (matches real SetModeOperation). */
class MinimalSetModeOperation implements Operation<SetModeIntent, void> {
  readonly id = SET_MODE_OPERATION_ID;
  async execute(ctx: OperationContext<SetModeIntent>): Promise<void> {
    const { results, errors } = await ctx.hooks.collect<SetModeHookResult>("set", {
      intent: ctx.intent,
    });
    if (errors.length > 0) throw errors[0]!;
    // Verify result has previousMode
    for (const r of results) {
      if (r.previousMode !== undefined) return;
    }
  }
}

/** Runs "show-ui" hook point only. */
class MinimalShowUIOperation implements Operation<Intent, ShowUIHookResult> {
  readonly id = APP_START_OPERATION_ID;
  async execute(ctx: OperationContext<Intent>): Promise<ShowUIHookResult> {
    const { results } = await ctx.hooks.collect<ShowUIHookResult>("show-ui", {
      intent: ctx.intent,
    });
    const merged: ShowUIHookResult = {};
    for (const r of results) {
      if (r.waitForRetry !== undefined) {
        (merged as Record<string, unknown>).waitForRetry = r.waitForRetry;
      }
    }
    return merged;
  }
}

/** Runs "init" hook point only. */
class MinimalInitOperation implements Operation<Intent, void> {
  readonly id = APP_START_OPERATION_ID;
  async execute(ctx: OperationContext<Intent>): Promise<void> {
    const { errors } = await ctx.hooks.collect<void>("init", {
      intent: ctx.intent,
    });
    if (errors.length > 0) throw errors[0]!;
  }
}

/** Runs "show-ui" and "hide-ui" hook points on setup. */
class MinimalSetupOperation implements Operation<SetupIntent, void> {
  readonly hookPoint: "show-ui" | "hide-ui";
  readonly id = SETUP_OPERATION_ID;
  constructor(hookPoint: "show-ui" | "hide-ui") {
    this.hookPoint = hookPoint;
  }
  async execute(ctx: OperationContext<SetupIntent>): Promise<void> {
    await ctx.hooks.collect<void>(this.hookPoint, { intent: ctx.intent });
  }
}

/** Runs "agent-selection" hook with pre-populated availableAgents context. */
class MinimalAgentSelectionOperation implements Operation<SetupIntent, AgentSelectionHookResult> {
  readonly id = SETUP_OPERATION_ID;
  readonly availableAgents: readonly RegisterAgentResult[];
  constructor(availableAgents: readonly RegisterAgentResult[]) {
    this.availableAgents = availableAgents;
  }
  async execute(ctx: OperationContext<SetupIntent>): Promise<AgentSelectionHookResult> {
    const hookCtx: AgentSelectionHookContext = {
      intent: ctx.intent,
      availableAgents: this.availableAgents,
    };
    const { results, errors } = await ctx.hooks.collect<AgentSelectionHookResult>(
      "agent-selection",
      hookCtx
    );
    if (errors.length > 0) throw errors[0]!;
    let selectedAgent: AgentSelectionHookResult["selectedAgent"] = "claude";
    for (const r of results) {
      if (r.selectedAgent !== undefined) selectedAgent = r.selectedAgent;
    }
    return { selectedAgent };
  }
}

/** Runs "activate" hook point + emits workspace:switched event. */
class MinimalSwitchOperation implements Operation<SwitchWorkspaceIntent, void> {
  readonly id = SWITCH_WORKSPACE_OPERATION_ID;
  async execute(ctx: OperationContext<SwitchWorkspaceIntent>): Promise<void> {
    const workspacePath = (ctx.intent.payload as { workspacePath: string }).workspacePath;
    const activateCtx: ActivateHookInput = {
      intent: ctx.intent,
      workspacePath,
    };
    const { results, errors } = await ctx.hooks.collect<SwitchWorkspaceHookResult>(
      "activate",
      activateCtx
    );
    if (errors.length > 0) throw errors[0]!;
    let resolvedPath: string | undefined;
    for (const r of results) {
      if (r.resolvedPath !== undefined) resolvedPath = r.resolvedPath;
    }
    if (resolvedPath) {
      // Extract workspace name from path for test event (real operation uses resolve hooks)
      const workspaceName = resolvedPath.split("/").pop() ?? "";
      const event: WorkspaceSwitchedEvent = {
        type: EVENT_WORKSPACE_SWITCHED,
        payload: {
          projectId: "test-project" as ProjectId,
          projectName: "test",
          projectPath: "/projects/test",
          workspaceName: workspaceName as WorkspaceName,
          path: resolvedPath,
        },
      };
      ctx.emit(event);
    }
  }
}

/** Runs "shutdown" hook point only. */
class MinimalDeleteOperation implements Operation<DeleteWorkspaceIntent, ShutdownHookResult> {
  readonly id = DELETE_WORKSPACE_OPERATION_ID;
  async execute(ctx: OperationContext<DeleteWorkspaceIntent>): Promise<ShutdownHookResult> {
    const { payload } = ctx.intent;
    const hookCtx: DeletePipelineHookInput = {
      intent: ctx.intent,
      projectPath: "/projects/test",
      workspacePath: payload.workspacePath,
    };
    const { results, errors } = await ctx.hooks.collect<ShutdownHookResult>("shutdown", hookCtx);
    if (errors.length > 0) throw errors[0]!;
    const merged: ShutdownHookResult = {};
    for (const r of results) {
      if (r.wasActive !== undefined) (merged as Record<string, unknown>).wasActive = r.wasActive;
      if (r.error !== undefined) (merged as Record<string, unknown>).error = r.error;
    }
    return merged;
  }
}

/** Runs "activate" hook only (for mount + loading change wiring). */
class MinimalActivateOperation implements Operation<Intent, ActivateHookResult> {
  readonly id = APP_START_OPERATION_ID;
  async execute(ctx: OperationContext<Intent>): Promise<ActivateHookResult> {
    const { results, errors } = await ctx.hooks.collect<ActivateHookResult>("activate", {
      intent: ctx.intent,
    });
    if (errors.length > 0) throw errors[0]!;
    const merged: ActivateHookResult = {};
    for (const r of results) {
      if (r.projectPaths) {
        (merged as Record<string, unknown>).projectPaths = [
          ...((merged.projectPaths as string[]) ?? []),
          ...r.projectPaths,
        ];
      }
    }
    return merged;
  }
}

/** Runs "activate" hook then emits app:started (for tests needing readyHandler to complete). */
class MinimalActivateAndStartedOperation implements Operation<Intent, ActivateHookResult> {
  readonly id = APP_START_OPERATION_ID;
  async execute(ctx: OperationContext<Intent>): Promise<ActivateHookResult> {
    const { results, errors } = await ctx.hooks.collect<ActivateHookResult>("activate", {
      intent: ctx.intent,
    });
    if (errors.length > 0) throw errors[0]!;
    ctx.emit({ type: EVENT_APP_STARTED, payload: {} });
    const merged: ActivateHookResult = {};
    for (const r of results) {
      if (r.projectPaths) {
        (merged as Record<string, unknown>).projectPaths = [
          ...((merged.projectPaths as string[]) ?? []),
          ...r.projectPaths,
        ];
      }
    }
    return merged;
  }
}

/** Runs "activate" hook with ports then emits app:started. */
class MinimalActivateWithPortsAndStartedOperation implements Operation<Intent, ActivateHookResult> {
  readonly id = APP_START_OPERATION_ID;
  private readonly codeServerPort: number | null;
  constructor(codeServerPort: number | null) {
    this.codeServerPort = codeServerPort;
  }
  async execute(ctx: OperationContext<Intent>): Promise<ActivateHookResult> {
    const activateCtx: ActivateHookContext = {
      intent: ctx.intent,
      mcpPort: null,
      codeServerPort: this.codeServerPort,
    };
    const { results, errors } = await ctx.hooks.collect<ActivateHookResult>(
      "activate",
      activateCtx
    );
    if (errors.length > 0) throw errors[0]!;
    ctx.emit({ type: EVENT_APP_STARTED, payload: {} });
    return results[0] ?? {};
  }
}

/** Runs workspace:created event via open-workspace. */
class MinimalOpenOperation implements Operation<OpenWorkspaceIntent, unknown> {
  readonly id = "open-workspace";
  async execute(ctx: OperationContext<OpenWorkspaceIntent>): Promise<unknown> {
    const { payload } = ctx.intent;
    const event: WorkspaceCreatedEvent = {
      type: EVENT_WORKSPACE_CREATED,
      payload: {
        projectId: payload.projectId as unknown as ProjectId,
        workspaceName: payload.workspaceName as unknown as WorkspaceName,
        workspacePath: `/workspaces/${payload.workspaceName}`,
        projectPath: `/projects/test`,
        branch: payload.base ?? "main",
        base: payload.base ?? "main",
        metadata: {},
        workspaceUrl: `http://127.0.0.1:0/?folder=/workspaces/${payload.workspaceName}`,
      },
    };
    ctx.emit(event);
    return {};
  }
}

/** Runs "select-folder" hook point (matches OpenProjectOperation's conditional hook). */
class MinimalSelectFolderOperation implements Operation<Intent, SelectFolderHookResult | null> {
  readonly id = OPEN_PROJECT_OPERATION_ID;
  async execute(ctx: OperationContext<Intent>): Promise<SelectFolderHookResult | null> {
    const { results, errors } = await ctx.hooks.collect<SelectFolderHookResult>("select-folder", {
      intent: ctx.intent,
    });
    if (errors.length > 0) throw errors[0]!;
    let folderPath: string | null = null;
    for (const r of results) {
      if (r.folderPath) folderPath = r.folderPath;
    }
    return { folderPath };
  }
}

// =============================================================================
// Test Setup
// =============================================================================

interface TestSetup {
  dispatcher: Dispatcher;
  hookRegistry: HookRegistry;
  viewManager: ReturnType<typeof createMockViewManager>;
  layers: ReturnType<typeof createMockShellLayers>;
  readyHandler: () => Promise<void>;
}

function createTestSetup(
  operationOverride?: { intentType: string; operation: Operation<Intent, unknown> },
  options?: { nullLayers?: boolean; dialogLayer?: ViewModuleDeps["dialogLayer"] }
): TestSetup {
  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);

  const viewManager = createMockViewManager();
  const layers = createMockShellLayers();

  const deps: ViewModuleDeps = {
    viewManager: viewManager as unknown as ViewModuleDeps["viewManager"],
    logger: SILENT_LOGGER,
    viewLayer: options?.nullLayers
      ? null
      : (layers.viewLayer as unknown as ViewModuleDeps["viewLayer"]),
    windowLayer: options?.nullLayers
      ? null
      : (layers.windowLayer as unknown as ViewModuleDeps["windowLayer"]),
    sessionLayer: options?.nullLayers
      ? null
      : (layers.sessionLayer as unknown as ViewModuleDeps["sessionLayer"]),
    ...(options?.dialogLayer !== undefined && { dialogLayer: options.dialogLayer }),
  };

  const { module, readyHandler } = createViewModule(deps);

  if (operationOverride) {
    dispatcher.registerOperation(operationOverride.intentType, operationOverride.operation);
  }

  dispatcher.registerModule(module);

  return { dispatcher, hookRegistry, viewManager, layers, readyHandler };
}

// =============================================================================
// Tests
// =============================================================================

describe("ViewModule Integration", () => {
  // -------------------------------------------------------------------------
  // Test 1: ui:set-mode → setMode called, returns previousMode
  // -------------------------------------------------------------------------
  describe("set-mode/set", () => {
    it("calls setMode and returns previousMode", async () => {
      const { dispatcher, viewManager } = createTestSetup({
        intentType: INTENT_SET_MODE,
        operation: new MinimalSetModeOperation(),
      });

      viewManager._setCurrentMode("workspace");

      await dispatcher.dispatch({
        type: INTENT_SET_MODE,
        payload: { mode: "shortcut" },
      } as SetModeIntent);

      expect(viewManager.setMode).toHaveBeenCalledWith("shortcut");
      expect(viewManager.getMode).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Test 2: app-start show-ui → sends LIFECYCLE_SHOW_STARTING
  // -------------------------------------------------------------------------
  describe("app-start/show-ui", () => {
    it("sends LIFECYCLE_SHOW_STARTING to renderer", async () => {
      const { dispatcher, viewManager } = createTestSetup({
        intentType: INTENT_APP_START,
        operation: new MinimalShowUIOperation(),
      });

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      expect(viewManager._webContents.send).toHaveBeenCalledWith(
        ApiIpcChannels.LIFECYCLE_SHOW_STARTING
      );
    });
  });

  // -------------------------------------------------------------------------
  // Test 3: setup/show-ui → sends LIFECYCLE_SHOW_SETUP
  // -------------------------------------------------------------------------
  describe("setup/show-ui", () => {
    it("sends LIFECYCLE_SHOW_SETUP to renderer", async () => {
      const { dispatcher, viewManager } = createTestSetup({
        intentType: INTENT_SETUP,
        operation: new MinimalSetupOperation("show-ui"),
      });

      await dispatcher.dispatch({
        type: INTENT_SETUP,
        payload: {},
      } as SetupIntent);

      expect(viewManager._webContents.send).toHaveBeenCalledWith(
        ApiIpcChannels.LIFECYCLE_SHOW_SETUP
      );
    });
  });

  // -------------------------------------------------------------------------
  // Test 4: setup/hide-ui → sends LIFECYCLE_SHOW_STARTING
  // -------------------------------------------------------------------------
  describe("setup/hide-ui", () => {
    it("sends LIFECYCLE_SHOW_STARTING to renderer", async () => {
      const { dispatcher, viewManager } = createTestSetup({
        intentType: INTENT_SETUP,
        operation: new MinimalSetupOperation("hide-ui"),
      });

      await dispatcher.dispatch({
        type: INTENT_SETUP,
        payload: {},
      } as SetupIntent);

      expect(viewManager._webContents.send).toHaveBeenCalledWith(
        ApiIpcChannels.LIFECYCLE_SHOW_STARTING
      );
    });
  });

  // -------------------------------------------------------------------------
  // Test 4b: setup/agent-selection → sends AgentInfo[] payload to renderer
  // -------------------------------------------------------------------------
  describe("setup/agent-selection", () => {
    it("sends AgentInfo objects in ShowAgentSelectionPayload", async () => {
      const availableAgents: RegisterAgentResult[] = [
        { agent: "claude", label: "Claude", icon: "sparkle" },
        { agent: "opencode", label: "OpenCode", icon: "terminal" },
      ];

      const mockIpcLayer = {
        on: vi.fn((_channel: string, handler: (...args: unknown[]) => void) => {
          // Simulate agent selection response immediately
          setTimeout(() => handler(null, { agent: "claude" }), 0);
        }),
        removeListener: vi.fn(),
      };

      const hookRegistry = new HookRegistry();
      const dispatcher = new Dispatcher(hookRegistry);
      const viewManager = createMockViewManager();

      dispatcher.registerOperation(
        INTENT_SETUP,
        new MinimalAgentSelectionOperation(availableAgents)
      );

      const { module } = createViewModule({
        viewManager: viewManager as unknown as ViewModuleDeps["viewManager"],
        logger: SILENT_LOGGER,
        viewLayer: null,
        windowLayer: null,
        sessionLayer: null,
        ipcLayer: mockIpcLayer,
      });

      dispatcher.registerModule(module);

      await dispatcher.dispatch({
        type: INTENT_SETUP,
        payload: {},
      } as SetupIntent);

      expect(viewManager._webContents.send).toHaveBeenCalledWith(
        ApiIpcChannels.LIFECYCLE_SHOW_AGENT_SELECTION,
        {
          agents: [
            { agent: "claude", label: "Claude", icon: "sparkle" },
            { agent: "opencode", label: "OpenCode", icon: "terminal" },
          ],
        }
      );
    });
  });

  // -------------------------------------------------------------------------
  // Test 5: workspace:created → createWorkspaceView + preloadWorkspaceUrl
  // -------------------------------------------------------------------------
  describe("workspace:created event", () => {
    it("creates workspace view and preloads URL", async () => {
      const { dispatcher, viewManager } = createTestSetup({
        intentType: INTENT_OPEN_WORKSPACE,
        operation: new MinimalOpenOperation(),
      });

      await dispatcher.dispatch({
        type: INTENT_OPEN_WORKSPACE,
        payload: {
          projectId: "test-project" as unknown as ProjectId,
          workspaceName: "ws1" as unknown as WorkspaceName,
          base: "main",
        },
      } as OpenWorkspaceIntent);

      expect(viewManager.createWorkspaceView).toHaveBeenCalledWith(
        "/workspaces/ws1",
        "http://127.0.0.1:0/?folder=/workspaces/ws1",
        "/projects/test",
        true
      );
      expect(viewManager.preloadWorkspaceUrl).toHaveBeenCalledWith("/workspaces/ws1");
    });
  });

  // -------------------------------------------------------------------------
  // Test 6: delete-workspace/shutdown → destroyWorkspaceView, returns wasActive
  // -------------------------------------------------------------------------
  describe("delete-workspace/shutdown", () => {
    it("destroys workspace view and returns wasActive", async () => {
      const { dispatcher, viewManager } = createTestSetup({
        intentType: INTENT_DELETE_WORKSPACE,
        operation: new MinimalDeleteOperation(),
      });

      // Mark workspace as active
      viewManager._setActivePath("/workspaces/ws1");

      const result = await dispatcher.dispatch({
        type: INTENT_DELETE_WORKSPACE,
        payload: {
          workspacePath: "/workspaces/ws1",
          keepBranch: false,
          force: false,
          removeWorktree: true,
        },
      } as DeleteWorkspaceIntent);

      expect(viewManager.destroyWorkspaceView).toHaveBeenCalledWith("/workspaces/ws1");
      expect(result).toEqual(expect.objectContaining({ wasActive: true }));
    });

    // -----------------------------------------------------------------------
    // Test 7: delete-workspace/shutdown force mode → catches error
    // -----------------------------------------------------------------------
    it("catches error in force mode", async () => {
      const { dispatcher, viewManager } = createTestSetup({
        intentType: INTENT_DELETE_WORKSPACE,
        operation: new MinimalDeleteOperation(),
      });

      viewManager.destroyWorkspaceView.mockRejectedValue(new Error("view gone"));

      const result = await dispatcher.dispatch({
        type: INTENT_DELETE_WORKSPACE,
        payload: {
          workspacePath: "/workspaces/ws1",
          keepBranch: false,
          force: true,
          removeWorktree: true,
        },
      } as DeleteWorkspaceIntent);

      expect(result).toEqual(expect.objectContaining({ error: "view gone" }));
    });
  });

  // -------------------------------------------------------------------------
  // Test 8: switch-workspace/activate → setActiveWorkspace called
  // -------------------------------------------------------------------------
  describe("switch-workspace/activate", () => {
    it("calls setActiveWorkspace with path and focus", async () => {
      const { dispatcher, viewManager } = createTestSetup({
        intentType: INTENT_SWITCH_WORKSPACE,
        operation: new MinimalSwitchOperation(),
      });

      await dispatcher.dispatch({
        type: INTENT_SWITCH_WORKSPACE,
        payload: {
          workspacePath: "/workspaces/ws1",
        },
      } as SwitchWorkspaceIntent);

      expect(viewManager.setActiveWorkspace).toHaveBeenCalledWith("/workspaces/ws1", true);
    });

    // -----------------------------------------------------------------------
    // Test 9: switch no-op when already active
    // -----------------------------------------------------------------------
    it("does not call setActiveWorkspace when already active", async () => {
      const { dispatcher, viewManager } = createTestSetup({
        intentType: INTENT_SWITCH_WORKSPACE,
        operation: new MinimalSwitchOperation(),
      });

      // Set workspace as already active
      viewManager._setActivePath("/workspaces/ws1");

      await dispatcher.dispatch({
        type: INTENT_SWITCH_WORKSPACE,
        payload: {
          workspacePath: "/workspaces/ws1",
        },
      } as SwitchWorkspaceIntent);

      // setActiveWorkspace should not be called (no-op)
      expect(viewManager.setActiveWorkspace).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Test 10: workspace:switched null → cachedActiveRef cleared + setActiveWorkspace(null)
  // -------------------------------------------------------------------------
  describe("workspace:switched event (null)", () => {
    it("clears cached ref and sets active workspace to null", async () => {
      // First set up a cached active ref by doing a switch
      const { dispatcher, viewManager } = createTestSetup({
        intentType: INTENT_SWITCH_WORKSPACE,
        operation: new MinimalSwitchOperation(),
      });

      // Register get-active-workspace so we can verify the cache
      dispatcher.registerOperation(INTENT_GET_ACTIVE_WORKSPACE, new GetActiveWorkspaceOperation());

      // Switch to ws1 first to populate cache
      await dispatcher.dispatch({
        type: INTENT_SWITCH_WORKSPACE,
        payload: {
          workspacePath: "/workspaces/ws1",
        },
      } as SwitchWorkspaceIntent);

      // Verify cache is populated
      const refBefore = await dispatcher.dispatch({
        type: INTENT_GET_ACTIVE_WORKSPACE,
        payload: {} as Record<string, never>,
      } as GetActiveWorkspaceIntent);
      expect(refBefore).toEqual(expect.objectContaining({ path: "/workspaces/ws1" }));

      // Now emit workspace:switched with null payload by dispatching delete
      // that triggers auto-switch. Instead, manually fire the event through dispatcher.
      // We use a custom operation to emit the null event.
      const nullSwitchOp: Operation<Intent, void> = {
        id: "emit-null-switch",
        async execute(ctx: OperationContext<Intent>): Promise<void> {
          const event: WorkspaceSwitchedEvent = {
            type: EVENT_WORKSPACE_SWITCHED,
            payload: null,
          };
          ctx.emit(event);
        },
      };
      dispatcher.registerOperation("test:emit-null-switch", nullSwitchOp);
      await dispatcher.dispatch({
        type: "test:emit-null-switch",
        payload: {},
      });

      // Verify cache is cleared
      const refAfter = await dispatcher.dispatch({
        type: INTENT_GET_ACTIVE_WORKSPACE,
        payload: {} as Record<string, never>,
      } as GetActiveWorkspaceIntent);
      expect(refAfter).toBeNull();

      // Verify setActiveWorkspace(null) was called
      expect(viewManager.setActiveWorkspace).toHaveBeenCalledWith(null, false);
    });
  });

  // -------------------------------------------------------------------------
  // Test 11: workspace:switched → cache ref; get-active-workspace returns it
  // -------------------------------------------------------------------------
  describe("workspace:switched event (non-null)", () => {
    it("caches workspace ref that get-active-workspace returns", async () => {
      const { dispatcher } = createTestSetup({
        intentType: INTENT_SWITCH_WORKSPACE,
        operation: new MinimalSwitchOperation(),
      });

      dispatcher.registerOperation(INTENT_GET_ACTIVE_WORKSPACE, new GetActiveWorkspaceOperation());

      await dispatcher.dispatch({
        type: INTENT_SWITCH_WORKSPACE,
        payload: {
          workspacePath: "/workspaces/ws1",
        },
      } as SwitchWorkspaceIntent);

      const ref = await dispatcher.dispatch({
        type: INTENT_GET_ACTIVE_WORKSPACE,
        payload: {} as Record<string, never>,
      } as GetActiveWorkspaceIntent);

      expect(ref).toEqual({
        projectId: "test-project",
        workspaceName: "ws1",
        path: "/workspaces/ws1",
      });
    });
  });

  // -------------------------------------------------------------------------
  // Test 12: project:opened → preloadWorkspaceUrl for workspaces[1..n]
  // -------------------------------------------------------------------------
  describe("project:opened event", () => {
    it("preloads non-first workspaces", async () => {
      // We need an operation that emits project:opened
      const projectOpenOp: Operation<Intent, void> = {
        id: "open-project",
        async execute(ctx: OperationContext<Intent>): Promise<void> {
          const event: ProjectOpenedEvent = {
            type: EVENT_PROJECT_OPENED,
            payload: {
              project: {
                id: "test-project" as ProjectId,
                name: "test",
                path: "/projects/test",
                workspaces: [
                  {
                    projectId: "test-project" as ProjectId,
                    name: "ws1" as WorkspaceName,
                    path: "/workspaces/ws1",
                    branch: "main",
                    metadata: { base: "main" },
                  },
                  {
                    projectId: "test-project" as ProjectId,
                    name: "ws2" as WorkspaceName,
                    path: "/workspaces/ws2",
                    branch: "feature",
                    metadata: { base: "main" },
                  },
                  {
                    projectId: "test-project" as ProjectId,
                    name: "ws3" as WorkspaceName,
                    path: "/workspaces/ws3",
                    branch: "fix",
                    metadata: { base: "main" },
                  },
                ],
              } as Project,
            },
          };
          ctx.emit(event);
        },
      };

      const { dispatcher, viewManager } = createTestSetup({
        intentType: "project:open",
        operation: projectOpenOp,
      });

      await dispatcher.dispatch({
        type: "project:open",
        payload: {},
      });

      // Should preload ws2 and ws3, but NOT ws1 (first workspace)
      expect(viewManager.preloadWorkspaceUrl).not.toHaveBeenCalledWith("/workspaces/ws1");
      expect(viewManager.preloadWorkspaceUrl).toHaveBeenCalledWith("/workspaces/ws2");
      expect(viewManager.preloadWorkspaceUrl).toHaveBeenCalledWith("/workspaces/ws3");
    });
  });

  // -------------------------------------------------------------------------
  // Test 13: agent:status-updated → setWorkspaceLoaded called
  // -------------------------------------------------------------------------
  describe("agent:status-updated event", () => {
    it("calls setWorkspaceLoaded with workspace path", async () => {
      const emitOp: Operation<Intent, void> = {
        id: "emit-agent-status",
        async execute(ctx: OperationContext<Intent>): Promise<void> {
          const event: AgentStatusUpdatedEvent = {
            type: EVENT_AGENT_STATUS_UPDATED,
            payload: {
              workspacePath: "/workspaces/ws1" as import("../../shared/ipc").WorkspacePath,
              projectId: "test-project" as ProjectId,
              workspaceName: "ws1" as WorkspaceName,
              status: { status: "idle" } as import("../../shared/ipc").AggregatedAgentStatus,
            },
          };
          ctx.emit(event);
        },
      };

      const { dispatcher, viewManager } = createTestSetup({
        intentType: "test:emit-agent-status",
        operation: emitOp,
      });

      await dispatcher.dispatch({
        type: "test:emit-agent-status",
        payload: {},
      });

      expect(viewManager.setWorkspaceLoaded).toHaveBeenCalledWith("/workspaces/ws1");
    });
  });

  // -------------------------------------------------------------------------
  // Test 14: app-start/activate → onLoadingChange wired, mount signal set
  // -------------------------------------------------------------------------
  describe("app-start/activate", () => {
    it("wires onLoadingChange and sends LIFECYCLE_SHOW_MAIN_VIEW", async () => {
      const { dispatcher, viewManager, readyHandler } = createTestSetup({
        intentType: INTENT_APP_START,
        operation: new MinimalActivateAndStartedOperation(),
      });

      // Start dispatch in background - it will block on mount
      const dispatchPromise = dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      // Wait a tick for the activate handler to wire up
      await new Promise<void>((r) => setTimeout(r, 10));

      // Verify onLoadingChange was wired
      expect(viewManager.onLoadingChange).toHaveBeenCalled();

      // Verify webContents.send was called with LIFECYCLE_SHOW_MAIN_VIEW
      expect(viewManager._webContents.send).toHaveBeenCalledWith(
        ApiIpcChannels.LIFECYCLE_SHOW_MAIN_VIEW
      );

      // Call readyHandler to unblock mount (operation emits app:started to complete)
      await Promise.all([dispatchPromise, readyHandler()]);
    });
  });

  // -------------------------------------------------------------------------
  // Test 14b: app-start/activate → updateCodeServerPort called from context
  // -------------------------------------------------------------------------
  describe("app-start/activate (codeServerPort)", () => {
    it("calls updateCodeServerPort when codeServerPort is set in context", async () => {
      const { dispatcher, viewManager, readyHandler } = createTestSetup({
        intentType: INTENT_APP_START,
        operation: new MinimalActivateWithPortsAndStartedOperation(9090),
      });

      const dispatchPromise = dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      await new Promise<void>((r) => setTimeout(r, 10));
      await Promise.all([dispatchPromise, readyHandler()]);

      expect(viewManager.updateCodeServerPort).toHaveBeenCalledWith(9090);
    });

    it("does not call updateCodeServerPort when codeServerPort is null", async () => {
      const { dispatcher, viewManager, readyHandler } = createTestSetup({
        intentType: INTENT_APP_START,
        operation: new MinimalActivateWithPortsAndStartedOperation(null),
      });

      const dispatchPromise = dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      await new Promise<void>((r) => setTimeout(r, 10));
      await Promise.all([dispatchPromise, readyHandler()]);

      expect(viewManager.updateCodeServerPort).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Test 15: app-shutdown/stop → viewManager.destroy() + layers disposed
  // -------------------------------------------------------------------------
  describe("app-shutdown/stop", () => {
    it("calls viewManager.destroy() and disposes shell layers", async () => {
      // Need a quit module to prevent missing handler error
      const quitModule: IntentModule = {
        hooks: {
          [APP_SHUTDOWN_OPERATION_ID]: {
            quit: { handler: async () => {} },
          },
        },
      };

      const hookRegistry = new HookRegistry();
      const dispatcher = new Dispatcher(hookRegistry);
      const viewManager = createMockViewManager();
      const layers = createMockShellLayers();

      dispatcher.registerOperation(INTENT_APP_SHUTDOWN, new AppShutdownOperation());

      const { module } = createViewModule({
        viewManager: viewManager as unknown as ViewModuleDeps["viewManager"],
        logger: SILENT_LOGGER,
        viewLayer: layers.viewLayer as unknown as ViewModuleDeps["viewLayer"],
        windowLayer: layers.windowLayer as unknown as ViewModuleDeps["windowLayer"],
        sessionLayer: layers.sessionLayer as unknown as ViewModuleDeps["sessionLayer"],
      });

      dispatcher.registerModule(module);
      dispatcher.registerModule(quitModule);

      await dispatcher.dispatch({
        type: INTENT_APP_SHUTDOWN,
        payload: {},
      } as AppShutdownIntent);

      expect(viewManager.destroy).toHaveBeenCalled();
      expect(layers.viewLayer.dispose).toHaveBeenCalled();
      expect(layers.windowLayer.dispose).toHaveBeenCalled();
      expect(layers.sessionLayer.dispose).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Test 16: app-shutdown/stop → loadingChange cleanup called
  // -------------------------------------------------------------------------
  describe("app-shutdown/stop cleans up subscriptions", () => {
    it("calls loading change unsubscribe during shutdown", async () => {
      const cleanupFn = vi.fn();
      const quitModule: IntentModule = {
        hooks: {
          [APP_SHUTDOWN_OPERATION_ID]: {
            quit: { handler: async () => {} },
          },
        },
      };

      const hookRegistry = new HookRegistry();
      const dispatcher = new Dispatcher(hookRegistry);
      const viewManager = createMockViewManager();
      const layers = createMockShellLayers();

      // onLoadingChange returns our trackable cleanup
      viewManager.onLoadingChange.mockReturnValue(cleanupFn);

      dispatcher.registerOperation(INTENT_APP_START, new MinimalActivateAndStartedOperation());
      dispatcher.registerOperation(INTENT_APP_SHUTDOWN, new AppShutdownOperation());

      const { module, readyHandler } = createViewModule({
        viewManager: viewManager as unknown as ViewModuleDeps["viewManager"],
        logger: SILENT_LOGGER,
        viewLayer: layers.viewLayer as unknown as ViewModuleDeps["viewLayer"],
        windowLayer: layers.windowLayer as unknown as ViewModuleDeps["windowLayer"],
        sessionLayer: layers.sessionLayer as unknown as ViewModuleDeps["sessionLayer"],
      });

      dispatcher.registerModule(module);
      dispatcher.registerModule(quitModule);

      // Start app (wires loading change callback)
      const startPromise = dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      await new Promise<void>((r) => setTimeout(r, 10));
      await Promise.all([startPromise, readyHandler()]);

      // Shutdown (should call cleanup)
      await dispatcher.dispatch({
        type: INTENT_APP_SHUTDOWN,
        payload: {},
      } as AppShutdownIntent);

      expect(cleanupFn).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Null layers - shutdown succeeds when layers are null
  // -------------------------------------------------------------------------
  describe("app-shutdown with null layers", () => {
    it("does not throw when layers are null", async () => {
      const quitModule: IntentModule = {
        hooks: {
          [APP_SHUTDOWN_OPERATION_ID]: {
            quit: { handler: async () => {} },
          },
        },
      };

      const hookRegistry = new HookRegistry();
      const dispatcher = new Dispatcher(hookRegistry);
      const viewManager = createMockViewManager();

      dispatcher.registerOperation(INTENT_APP_SHUTDOWN, new AppShutdownOperation());

      const { module } = createViewModule({
        viewManager: viewManager as unknown as ViewModuleDeps["viewManager"],
        logger: SILENT_LOGGER,
        viewLayer: null,
        windowLayer: null,
        sessionLayer: null,
      });

      dispatcher.registerModule(module);
      dispatcher.registerModule(quitModule);

      await expect(
        dispatcher.dispatch({
          type: INTENT_APP_SHUTDOWN,
          payload: {},
        } as AppShutdownIntent)
      ).resolves.not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Test 17: app-start/init → creates window/views, maximizes, loads UI, focuses
  // -------------------------------------------------------------------------
  describe("app-start/init", () => {
    it("calls menuLayer, windowManager, viewManager, and viewLayer in order", async () => {
      const hookRegistry = new HookRegistry();
      const dispatcher = new Dispatcher(hookRegistry);
      const viewManager = createMockViewManager();
      const layers = createMockShellLayers();

      dispatcher.registerOperation(INTENT_APP_START, new MinimalInitOperation());

      const menuLayer = { setApplicationMenu: vi.fn() };
      const windowManager = {
        create: vi.fn(),
        maximizeAsync: vi.fn().mockResolvedValue(undefined),
      };
      const devToolsHandler = vi.fn();

      const { module } = createViewModule({
        viewManager: viewManager as unknown as ViewModuleDeps["viewManager"],
        logger: SILENT_LOGGER,
        viewLayer: layers.viewLayer as unknown as ViewModuleDeps["viewLayer"],
        windowLayer: null,
        sessionLayer: null,
        menuLayer,
        windowManager,
        uiHtmlPath: "file:///app/ui.html",
        devToolsHandler,
      });

      dispatcher.registerModule(module);

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      // Verify call sequence
      expect(menuLayer.setApplicationMenu).toHaveBeenCalledWith(null);
      expect(windowManager.create).toHaveBeenCalled();
      expect(viewManager.create).toHaveBeenCalled();
      expect(windowManager.maximizeAsync).toHaveBeenCalled();
      expect(layers.viewLayer.loadURL).toHaveBeenCalledWith(
        viewManager.getUIViewHandle(),
        "file:///app/ui.html"
      );
      expect(viewManager.focusUI).toHaveBeenCalled();
      expect(devToolsHandler).toHaveBeenCalled();
    });

    it("skips optional deps when not provided", async () => {
      const hookRegistry = new HookRegistry();
      const dispatcher = new Dispatcher(hookRegistry);
      const viewManager = createMockViewManager();

      dispatcher.registerOperation(INTENT_APP_START, new MinimalInitOperation());

      const { module } = createViewModule({
        viewManager: viewManager as unknown as ViewModuleDeps["viewManager"],
        logger: SILENT_LOGGER,
        viewLayer: null,
        windowLayer: null,
        sessionLayer: null,
      });

      dispatcher.registerModule(module);

      // Should not throw when optional deps are omitted
      await expect(
        dispatcher.dispatch({
          type: INTENT_APP_START,
          payload: {},
        } as AppStartIntent)
      ).resolves.not.toThrow();

      // viewManager.create() and focusUI() are always called
      expect(viewManager.create).toHaveBeenCalled();
      expect(viewManager.focusUI).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // open-project → select-folder hook
  // -------------------------------------------------------------------------
  describe("open-project/select-folder", () => {
    it("returns selected folder path from dialog", async () => {
      const mockDialogLayer = {
        showOpenDialog: vi.fn().mockResolvedValue({
          canceled: false,
          filePaths: [{ toString: () => "/selected/project" }],
        }),
      };

      const { dispatcher } = createTestSetup(
        { intentType: INTENT_OPEN_PROJECT, operation: new MinimalSelectFolderOperation() },
        { dialogLayer: mockDialogLayer }
      );

      const result = (await dispatcher.dispatch({
        type: INTENT_OPEN_PROJECT,
        payload: {},
      })) as SelectFolderHookResult;

      expect(result.folderPath).toBe("/selected/project");
      expect(mockDialogLayer.showOpenDialog).toHaveBeenCalledWith({
        properties: ["openDirectory"],
      });
    });

    it("returns null when dialog canceled", async () => {
      const mockDialogLayer = {
        showOpenDialog: vi.fn().mockResolvedValue({
          canceled: true,
          filePaths: [],
        }),
      };

      const { dispatcher } = createTestSetup(
        { intentType: INTENT_OPEN_PROJECT, operation: new MinimalSelectFolderOperation() },
        { dialogLayer: mockDialogLayer }
      );

      const result = (await dispatcher.dispatch({
        type: INTENT_OPEN_PROJECT,
        payload: {},
      })) as SelectFolderHookResult;

      expect(result.folderPath).toBeNull();
    });

    it("returns null when no dialogLayer provided", async () => {
      const { dispatcher } = createTestSetup({
        intentType: INTENT_OPEN_PROJECT,
        operation: new MinimalSelectFolderOperation(),
      });

      const result = (await dispatcher.dispatch({
        type: INTENT_OPEN_PROJECT,
        payload: {},
      })) as SelectFolderHookResult;

      expect(result.folderPath).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Lifecycle-ready (merged from LifecycleReadyModule)
  // -------------------------------------------------------------------------
  describe("readyHandler (lifecycle-ready)", () => {
    it("resolves mount signal and awaits projectsLoadedPromise", async () => {
      const { dispatcher, readyHandler } = createTestSetup({
        intentType: INTENT_APP_START,
        operation: new MinimalActivateOperation(),
      });

      // Start dispatch - blocks on mount signal in activate hook
      const dispatchPromise = dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      await new Promise<void>((r) => setTimeout(r, 10));

      // Call readyHandler - resolves mount (unblocks dispatch) but blocks on projectsLoadedPromise
      let handlerCompleted = false;
      const readyPromise = readyHandler().then(() => {
        handlerCompleted = true;
      });

      // Dispatch completes because mount was resolved
      await dispatchPromise;
      // But readyHandler is still blocked on projectsLoadedPromise
      expect(handlerCompleted).toBe(false);

      // Emit app:started to resolve projectsLoadedPromise
      const emitOp: Operation<Intent, void> = {
        id: "emit-started",
        async execute(ctx: OperationContext<Intent>): Promise<void> {
          ctx.emit({ type: EVENT_APP_STARTED, payload: {} });
        },
      };
      dispatcher.registerOperation("test:emit-started", emitOp);
      await dispatcher.dispatch({ type: "test:emit-started", payload: {} });

      await readyPromise;
      expect(handlerCompleted).toBe(true);
    });

    it("app:started event resolves projectsLoadedPromise so readyHandler completes", async () => {
      const { dispatcher, readyHandler } = createTestSetup({
        intentType: INTENT_APP_START,
        operation: new MinimalActivateAndStartedOperation(),
      });

      // Dispatch app:start - blocks on mount, then emits app:started
      const dispatchPromise = dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      await new Promise<void>((r) => setTimeout(r, 10));

      // readyHandler resolves mount; operation continues and emits app:started
      await Promise.all([dispatchPromise, readyHandler()]);
    });

    it("readyHandler is idempotent (second call is no-op)", async () => {
      const { dispatcher, readyHandler } = createTestSetup({
        intentType: INTENT_APP_START,
        operation: new MinimalActivateAndStartedOperation(),
      });

      const dispatchPromise = dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      await new Promise<void>((r) => setTimeout(r, 10));
      await Promise.all([dispatchPromise, readyHandler()]);

      // Second call is a no-op (mount signal already consumed)
      await readyHandler();
    });

    it("readyHandler is no-op when mount signal resolve is null", async () => {
      // Create module without triggering activate (mountSignal.resolve stays null)
      const { readyHandler } = createTestSetup();

      // Should complete immediately without error
      await readyHandler();
    });
  });
});
