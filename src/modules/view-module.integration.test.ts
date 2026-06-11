// @vitest-environment node
/**
 * Integration tests for ViewModule through the Dispatcher.
 *
 * Tests verify the full pipeline: dispatcher -> operation -> hook handlers.
 * Covers: set-mode/set, app-start hooks, setup dialog hooks, active-workspace
 * bookkeeping (resolve / get-active / switch / delete / hibernate), the
 * workspace loading dialog (created → agent:status-updated / timeout), and
 * app-shutdown/stop disposal.
 */

import { createMockDispatcher } from "../intents/lib/dispatcher.test-utils";
import { describe, it, expect, vi } from "vitest";
import { Dispatcher } from "../intents/lib/dispatcher";
import type { Operation, OperationContext, HookContext } from "../intents/lib/operation";
import type { Intent } from "../intents/lib/types";
import { createMinimalOperation } from "../intents/lib/operation.test-utils";
import type { IntentModule } from "../intents/lib/module";
import { INTENT_SET_MODE, SET_MODE_OPERATION_ID } from "../intents/set-mode";
import type { SetModeIntent, SetModeHookResult } from "../intents/set-mode";
import { INTENT_APP_START, APP_START_OPERATION_ID } from "../intents/app-start";
import type { AppStartIntent, ShowUIHookResult } from "../intents/app-start";
import {
  AppShutdownOperation,
  INTENT_APP_SHUTDOWN,
  APP_SHUTDOWN_OPERATION_ID,
} from "../intents/app-shutdown";
import type { AppShutdownIntent } from "../intents/app-shutdown";
import { INTENT_SETUP, SETUP_OPERATION_ID } from "../intents/setup";
import type { SetupIntent, AgentSelectionHookContext, RegisterAgentResult } from "../intents/setup";
import { INTENT_GET_ACTIVE_WORKSPACE } from "../intents/get-active-workspace";
import type { GetActiveWorkspaceIntent } from "../intents/get-active-workspace";
import { GetActiveWorkspaceOperation } from "../intents/get-active-workspace";
import {
  INTENT_SWITCH_WORKSPACE,
  SWITCH_WORKSPACE_OPERATION_ID,
  EVENT_WORKSPACE_SWITCHED,
} from "../intents/switch-workspace";
import type {
  SwitchWorkspaceIntent,
  SwitchWorkspaceHookResult,
  ActivateHookInput,
  WorkspaceSwitchedEvent,
} from "../intents/switch-workspace";
import {
  INTENT_DELETE_WORKSPACE,
  DELETE_WORKSPACE_OPERATION_ID,
} from "../intents/delete-workspace";
import type {
  DeleteWorkspaceIntent,
  DeletePipelineHookInput,
  ShutdownHookResult,
} from "../intents/delete-workspace";
import { INTENT_OPEN_WORKSPACE, EVENT_WORKSPACE_CREATED } from "../intents/open-workspace";
import type { OpenWorkspaceIntent, WorkspaceCreatedEvent } from "../intents/open-workspace";
import { INTENT_OPEN_PROJECT, OPEN_PROJECT_OPERATION_ID } from "../intents/open-project";
import type { SelectFolderHookResult } from "../intents/open-project";
import {
  RESOLVE_WORKSPACE_OPERATION_ID,
  type ResolveHookInput,
  type ResolveHookResult,
} from "../intents/resolve-workspace";
import { EVENT_AGENT_STATUS_UPDATED } from "../intents/update-agent-status";
import type { AgentStatusUpdatedEvent } from "../intents/update-agent-status";
import { SILENT_LOGGER } from "../boundaries/platform/logging";
import { createMockViewManager } from "../boundaries/shell/view-manager.test-utils";
import { createViewModule, type ViewModuleDeps } from "./view-module";
import type { ProjectId, WorkspaceName } from "../shared/api/types";
import { ApiIpcChannels } from "../shared/ipc";
import type { WorkspacePath, AggregatedAgentStatus } from "../shared/ipc";

// =============================================================================
// Mock IViewManager
// =============================================================================

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

/** Result type for the agent selection operation. */
interface AgentSelectionResult {
  selectedAgent: string;
}

/** Runs "agent-selection" hook with pre-populated availableAgents context. */
class MinimalAgentSelectionOperation implements Operation<SetupIntent, AgentSelectionResult> {
  readonly id = SETUP_OPERATION_ID;
  readonly availableAgents: readonly RegisterAgentResult[];
  constructor(availableAgents: readonly RegisterAgentResult[]) {
    this.availableAgents = availableAgents;
  }
  async execute(ctx: OperationContext<SetupIntent>): Promise<AgentSelectionResult> {
    const hookCtx: AgentSelectionHookContext = {
      intent: ctx.intent,
      availableAgents: this.availableAgents,
    };
    const { errors, capabilities } = await ctx.hooks.collect<void>("agent-selection", hookCtx);
    if (errors.length > 0) throw errors[0]!;
    const selectedAgent = (capabilities.agentType as string) ?? "claude";
    return { selectedAgent };
  }
}

/** Runs "activate" hook point + emits workspace:switched event. */
class MinimalSwitchOperation implements Operation<SwitchWorkspaceIntent, void> {
  readonly id = SWITCH_WORKSPACE_OPERATION_ID;
  constructor(private readonly active: boolean = false) {}
  async execute(ctx: OperationContext<SwitchWorkspaceIntent>): Promise<void> {
    const workspacePath = (ctx.intent.payload as { workspacePath: string }).workspacePath;
    const activateCtx: ActivateHookInput = {
      intent: ctx.intent,
      workspacePath,
      active: this.active,
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
  constructor(private readonly active: boolean = false) {}
  async execute(ctx: OperationContext<DeleteWorkspaceIntent>): Promise<ShutdownHookResult> {
    const { payload } = ctx.intent;
    const hookCtx: DeletePipelineHookInput = {
      intent: ctx.intent,
      projectPath: "/projects/test",
      workspacePath: payload.workspacePath,
      active: this.active,
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

/** Runs "start" hook only (for mount + loading change wiring). */
class MinimalActivateOperation implements Operation<Intent, void> {
  readonly id = APP_START_OPERATION_ID;
  async execute(ctx: OperationContext<Intent>): Promise<void> {
    // Pre-populate codeServerPort capability so handlers with requires run
    const hookCtx: HookContext = {
      intent: ctx.intent,
      capabilities: { codeServerPort: null },
    };
    const { errors } = await ctx.hooks.collect<void>("start", hookCtx);
    if (errors.length > 0) throw errors[0]!;
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
        projectId: "test-12345678" as unknown as ProjectId,
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
  viewManager: ReturnType<typeof createMockViewManager>;
  layers: ReturnType<typeof createMockShellLayers>;
  module: IntentModule;
}

function createTestSetup(
  operationOverride?: { intentType: string; operation: Operation<Intent, unknown> },
  options?: {
    nullLayers?: boolean;
    dialogLayer?: ViewModuleDeps["dialogLayer"];
  }
): TestSetup {
  const dispatcher = createMockDispatcher();

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

  const module = createViewModule(deps);

  if (operationOverride) {
    dispatcher.registerOperation(operationOverride.intentType, operationOverride.operation);
  }

  dispatcher.registerModule(module);

  return { dispatcher, viewManager, layers, module };
}

/** Run the module's resolve-workspace hook and return the `active` flag. */
async function resolveActive(module: IntentModule, workspacePath: string): Promise<boolean> {
  const hookCtx = {
    intent: { type: "workspace:resolve", payload: { workspacePath } },
    workspacePath,
  } as unknown as ResolveHookInput;
  const result = (await module.hooks![RESOLVE_WORKSPACE_OPERATION_ID]!.resolve!.handler(
    hookCtx
  )) as ResolveHookResult;
  return result.active === true;
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

      viewManager.setMode("workspace");

      await dispatcher.dispatch({
        type: INTENT_SET_MODE,
        payload: { mode: "shortcut" },
      } as SetModeIntent);

      expect(viewManager.setMode).toHaveBeenCalledWith("shortcut");
      expect(viewManager.getMode).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Test 2: app-start show-ui → opens dialog via DialogManager (or no-op without it)
  // -------------------------------------------------------------------------
  describe("app-start/show-ui", () => {
    it("returns ShowUIHookResult (no-op without dialogManager)", async () => {
      const { dispatcher } = createTestSetup({
        intentType: INTENT_APP_START,
        operation: new MinimalShowUIOperation(),
      });

      const result = await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      // Without dialogManager, returns empty result
      expect(result).toEqual({});
    });
  });

  // -------------------------------------------------------------------------
  // Test 3: setup/show-ui → opens setup dialog via DialogManager (no-op without it)
  // -------------------------------------------------------------------------
  describe("setup/show-ui", () => {
    it("completes without error when no dialogManager", async () => {
      const { dispatcher } = createTestSetup({
        intentType: INTENT_SETUP,
        operation: new MinimalSetupOperation("show-ui"),
      });

      await expect(
        dispatcher.dispatch({
          type: INTENT_SETUP,
          payload: {},
        } as SetupIntent)
      ).resolves.not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Test 4: setup/hide-ui → closes setup dialog (no-op without dialogManager)
  // -------------------------------------------------------------------------
  describe("setup/hide-ui", () => {
    it("completes without error when no dialogManager", async () => {
      const { dispatcher } = createTestSetup({
        intentType: INTENT_SETUP,
        operation: new MinimalSetupOperation("hide-ui"),
      });

      await expect(
        dispatcher.dispatch({
          type: INTENT_SETUP,
          payload: {},
        } as SetupIntent)
      ).resolves.not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Test 4b: setup/agent-selection → uses DialogManager for agent selection
  // -------------------------------------------------------------------------
  describe("setup/agent-selection", () => {
    it("throws SetupError when dialogManager not available", async () => {
      const availableAgents: RegisterAgentResult[] = [
        { agent: "claude", label: "Claude", icon: "sparkle" },
        { agent: "opencode", label: "OpenCode", icon: "terminal" },
      ];

      const dispatcher = createMockDispatcher();
      const viewManager = createMockViewManager();

      dispatcher.registerOperation(
        INTENT_SETUP,
        new MinimalAgentSelectionOperation(availableAgents)
      );

      const module = createViewModule({
        viewManager: viewManager as unknown as ViewModuleDeps["viewManager"],
        logger: SILENT_LOGGER,
        viewLayer: null,
        windowLayer: null,
        sessionLayer: null,
        // No dialogManager provided
      });

      dispatcher.registerModule(module);

      await expect(
        dispatcher.dispatch({
          type: INTENT_SETUP,
          payload: {},
        } as SetupIntent)
      ).rejects.toThrow("DialogManager not available");
    });

    it("reads the selected agent from the dialog event values", async () => {
      const availableAgents: RegisterAgentResult[] = [
        { agent: "claude", label: "Claude", icon: "sparkle" },
        { agent: "opencode", label: "OpenCode", icon: "terminal" },
      ];

      const dispatcher = createMockDispatcher();
      const viewManager = createMockViewManager();

      dispatcher.registerOperation(
        INTENT_SETUP,
        new MinimalAgentSelectionOperation(availableAgents)
      );

      // Selection dialog resolves to the "opencode" field value (keyed by id "agent").
      const dialogManager = {
        open: vi.fn(() => ({
          id: "dlg-agent",
          update: vi.fn(),
          close: vi.fn(),
          onEvent: vi.fn(() => () => {}),
          nextEvent: vi.fn().mockResolvedValue({
            dialogId: "dlg-agent",
            actionId: "select",
            data: { agent: "opencode" },
          }),
          closed: Promise.resolve(),
        })),
      };

      const module = createViewModule({
        viewManager: viewManager as unknown as ViewModuleDeps["viewManager"],
        logger: SILENT_LOGGER,
        viewLayer: null,
        windowLayer: null,
        sessionLayer: null,
        dialogManager: dialogManager as unknown as NonNullable<ViewModuleDeps["dialogManager"]>,
      });

      dispatcher.registerModule(module);

      const result = (await dispatcher.dispatch({
        type: INTENT_SETUP,
        payload: {},
      } as SetupIntent)) as unknown as AgentSelectionResult;

      expect(result.selectedAgent).toBe("opencode");
      expect(dialogManager.open).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Test 5: workspace:created → createWorkspaceView + preloadWorkspaceUrl
  // -------------------------------------------------------------------------
  describe("workspace loading dialog", () => {
    function createLoadingHarness() {
      const dispatcher = createMockDispatcher();
      const viewManager = createMockViewManager();
      const handle = {
        id: "dlg-loading",
        update: vi.fn(),
        close: vi.fn(),
        onEvent: vi.fn(() => () => {}),
        nextEvent: vi.fn(),
        closed: Promise.resolve(),
      };
      const dialogManager = { open: vi.fn(() => handle) };

      dispatcher.registerOperation(INTENT_OPEN_WORKSPACE, new MinimalOpenOperation());
      dispatcher.registerOperation(INTENT_SWITCH_WORKSPACE, new MinimalSwitchOperation());

      const module = createViewModule({
        viewManager: viewManager as unknown as ViewModuleDeps["viewManager"],
        logger: SILENT_LOGGER,
        viewLayer: null,
        windowLayer: null,
        sessionLayer: null,
        dialogManager: dialogManager as unknown as NonNullable<ViewModuleDeps["dialogManager"]>,
      });
      dispatcher.registerModule(module);

      const emitAgentStatus = async (path: string): Promise<void> => {
        const event: AgentStatusUpdatedEvent = {
          type: EVENT_AGENT_STATUS_UPDATED,
          payload: {
            workspace: {
              path: path as WorkspacePath,
              projectId: "test-project" as ProjectId,
              name: "ws1" as WorkspaceName,
              active: true,
            },
            status: { status: "idle" } as AggregatedAgentStatus,
          },
        };
        await module.events![EVENT_AGENT_STATUS_UPDATED]!.handler(event);
      };

      return { dispatcher, dialogManager, handle, module, emitAgentStatus };
    }

    it("opens for the active workspace and closes on first agent status", async () => {
      const { dispatcher, dialogManager, handle, emitAgentStatus } = createLoadingHarness();

      // Make ws1 the active workspace (switched event populates cachedActiveRef)
      await dispatcher.dispatch({
        type: INTENT_SWITCH_WORKSPACE,
        payload: { workspacePath: "/workspaces/ws1" },
      } as SwitchWorkspaceIntent);

      // ws1 starts loading → dialog for the active workspace
      await dispatcher.dispatch({
        type: INTENT_OPEN_WORKSPACE,
        payload: { workspaceName: "ws1", base: "main", projectPath: "/projects/test" },
      } as OpenWorkspaceIntent);
      expect(dialogManager.open).toHaveBeenCalledTimes(1);

      // First agent status closes the dialog
      await emitAgentStatus("/workspaces/ws1");
      expect(handle.close).toHaveBeenCalled();
    });

    it("does not open a dialog for background workspaces", async () => {
      const { dispatcher, dialogManager } = createLoadingHarness();

      // No switch — ws1 loads in the background
      await dispatcher.dispatch({
        type: INTENT_OPEN_WORKSPACE,
        payload: { workspaceName: "ws1", base: "main", projectPath: "/projects/test" },
      } as OpenWorkspaceIntent);

      expect(dialogManager.open).not.toHaveBeenCalled();
    });

    it("ignores hibernated workspaces", async () => {
      const { dispatcher, dialogManager, module } = createLoadingHarness();

      await dispatcher.dispatch({
        type: INTENT_SWITCH_WORKSPACE,
        payload: { workspacePath: "/workspaces/ws1" },
      } as SwitchWorkspaceIntent);

      const event: WorkspaceCreatedEvent = {
        type: EVENT_WORKSPACE_CREATED,
        payload: {
          projectId: "test-project" as ProjectId,
          workspaceName: "ws1" as WorkspaceName,
          workspacePath: "/workspaces/ws1",
          projectPath: "/projects/test",
          branch: "main",
          base: "main",
          metadata: { hibernated: "true" },
          workspaceUrl: "http://127.0.0.1:0/?folder=/workspaces/ws1",
        },
      };
      await module.events![EVENT_WORKSPACE_CREATED]!.handler(event);

      expect(dialogManager.open).not.toHaveBeenCalled();
    });

    it("falls through on the loading timeout", async () => {
      vi.useFakeTimers();
      try {
        const { dispatcher, dialogManager, handle } = createLoadingHarness();

        await dispatcher.dispatch({
          type: INTENT_SWITCH_WORKSPACE,
          payload: { workspacePath: "/workspaces/ws1" },
        } as SwitchWorkspaceIntent);
        await dispatcher.dispatch({
          type: INTENT_OPEN_WORKSPACE,
          payload: { workspaceName: "ws1", base: "main", projectPath: "/projects/test" },
        } as OpenWorkspaceIntent);
        expect(dialogManager.open).toHaveBeenCalledTimes(1);

        vi.runAllTimers();
        expect(handle.close).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Test 6: delete-workspace/shutdown → destroyWorkspaceView, returns wasActive
  // -------------------------------------------------------------------------
  describe("delete-workspace/shutdown", () => {
    it("returns wasActive when the deleted workspace was active", async () => {
      const { dispatcher } = createTestSetup({
        intentType: INTENT_DELETE_WORKSPACE,
        operation: new MinimalDeleteOperation(true),
      });

      const result = await dispatcher.dispatch({
        type: INTENT_DELETE_WORKSPACE,
        payload: {
          workspacePath: "/workspaces/ws1",
          keepBranch: false,
          force: false,
          removeWorktree: true,
        },
      } as DeleteWorkspaceIntent);

      expect(result).toEqual(expect.objectContaining({ wasActive: true }));
    });

    it("clears the active surface so resolve reports inactive", async () => {
      const { dispatcher, module } = createTestSetup({
        intentType: INTENT_SWITCH_WORKSPACE,
        operation: new MinimalSwitchOperation(),
      });
      dispatcher.registerOperation(INTENT_DELETE_WORKSPACE, new MinimalDeleteOperation(true));

      await dispatcher.dispatch({
        type: INTENT_SWITCH_WORKSPACE,
        payload: { workspacePath: "/workspaces/ws1" },
      } as SwitchWorkspaceIntent);
      expect(await resolveActive(module, "/workspaces/ws1")).toBe(true);

      await dispatcher.dispatch({
        type: INTENT_DELETE_WORKSPACE,
        payload: {
          workspacePath: "/workspaces/ws1",
          keepBranch: false,
          force: false,
          removeWorktree: true,
        },
      } as DeleteWorkspaceIntent);

      expect(await resolveActive(module, "/workspaces/ws1")).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Test 8: switch-workspace/activate → setActiveWorkspace called
  // -------------------------------------------------------------------------
  describe("switch-workspace/activate", () => {
    it("records the new active surface (resolve reports active)", async () => {
      const { dispatcher, module } = createTestSetup({
        intentType: INTENT_SWITCH_WORKSPACE,
        operation: new MinimalSwitchOperation(),
      });

      await dispatcher.dispatch({
        type: INTENT_SWITCH_WORKSPACE,
        payload: {
          workspacePath: "/workspaces/ws1",
        },
      } as SwitchWorkspaceIntent);

      expect(await resolveActive(module, "/workspaces/ws1")).toBe(true);
      expect(await resolveActive(module, "/workspaces/ws2")).toBe(false);
    });

    it("does not record anything when already active (short-circuit)", async () => {
      const { dispatcher, module } = createTestSetup({
        intentType: INTENT_SWITCH_WORKSPACE,
        operation: new MinimalSwitchOperation(true),
      });

      await dispatcher.dispatch({
        type: INTENT_SWITCH_WORKSPACE,
        payload: {
          workspacePath: "/workspaces/ws1",
        },
      } as SwitchWorkspaceIntent);

      // The hook short-circuited: module state was not updated by activate
      // (the switched event also isn't emitted in this minimal operation).
      expect(await resolveActive(module, "/workspaces/ws1")).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Test 10: workspace:switched null → cachedActiveRef cleared + setActiveWorkspace(null)
  // -------------------------------------------------------------------------
  describe("workspace:switched event (null)", () => {
    it("clears cached ref and sets active workspace to null", async () => {
      // First set up a cached active ref by doing a switch
      const { dispatcher, module } = createTestSetup({
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

      // Verify the active surface was cleared too
      expect(await resolveActive(module, "/workspaces/ws1")).toBe(false);
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
  // Test 14: app-start/activate → onLoadingChange wired, mount signal set
  // -------------------------------------------------------------------------
  describe("app-start/activate", () => {
    it("sends LIFECYCLE_SHOW_MAIN_VIEW to mount the renderer", async () => {
      const { dispatcher, viewManager } = createTestSetup({
        intentType: INTENT_APP_START,
        operation: new MinimalActivateOperation(),
      });

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      expect(viewManager.sendToUI).toHaveBeenCalledWith(ApiIpcChannels.LIFECYCLE_SHOW_MAIN_VIEW);
    });
  });

  // -------------------------------------------------------------------------
  // Test 15: app-shutdown/stop → viewManager.destroy() + layers disposed
  // -------------------------------------------------------------------------
  describe("app-shutdown/stop", () => {
    it("calls viewManager.destroy() and disposes shell layers", async () => {
      // Need a quit module to prevent missing handler error
      const quitModule: IntentModule = {
        name: "test",
        hooks: {
          [APP_SHUTDOWN_OPERATION_ID]: {
            quit: { handler: async () => {} },
          },
        },
      };

      const dispatcher = createMockDispatcher();
      const viewManager = createMockViewManager();
      const layers = createMockShellLayers();

      dispatcher.registerOperation(INTENT_APP_SHUTDOWN, new AppShutdownOperation());

      const module = createViewModule({
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
  // Null layers - shutdown succeeds when layers are null
  // -------------------------------------------------------------------------
  describe("app-shutdown with null layers", () => {
    it("does not throw when layers are null", async () => {
      const quitModule: IntentModule = {
        name: "test",
        hooks: {
          [APP_SHUTDOWN_OPERATION_ID]: {
            quit: { handler: async () => {} },
          },
        },
      };

      const dispatcher = createMockDispatcher();
      const viewManager = createMockViewManager();

      dispatcher.registerOperation(INTENT_APP_SHUTDOWN, new AppShutdownOperation());

      const module = createViewModule({
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
      const dispatcher = createMockDispatcher();
      const viewManager = createMockViewManager();
      const layers = createMockShellLayers();

      dispatcher.registerOperation(
        INTENT_APP_START,
        createMinimalOperation(APP_START_OPERATION_ID, "init", {
          hookContext: (ctx) => ({ intent: ctx.intent, capabilities: { "app-ready": true } }),
        })
      );

      const menuLayer = { setApplicationMenu: vi.fn() };
      const windowManager = {
        create: vi.fn(),
        maximizeAsync: vi.fn().mockResolvedValue(undefined),
        focus: vi.fn(),
      };
      const module = createViewModule({
        viewManager: viewManager as unknown as ViewModuleDeps["viewManager"],
        logger: SILENT_LOGGER,
        viewLayer: layers.viewLayer as unknown as ViewModuleDeps["viewLayer"],
        windowLayer: null,
        sessionLayer: null,
        menuLayer,
        windowManager,
        uiHtmlPath: "file:///app/ui.html",
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
      expect(windowManager.focus).toHaveBeenCalled();
      expect(viewManager.loadUIContent).toHaveBeenCalledWith("file:///app/ui.html");
      expect(viewManager.focus).toHaveBeenCalled();
    });

    it("skips optional deps when not provided", async () => {
      const dispatcher = createMockDispatcher();
      const viewManager = createMockViewManager();

      dispatcher.registerOperation(
        INTENT_APP_START,
        createMinimalOperation(APP_START_OPERATION_ID, "init", {
          hookContext: (ctx) => ({ intent: ctx.intent, capabilities: { "app-ready": true } }),
        })
      );

      const module = createViewModule({
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

      // viewManager.create() and focus() are always called
      expect(viewManager.create).toHaveBeenCalled();
      expect(viewManager.focus).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // open-project → select-folder hook
  // -------------------------------------------------------------------------
  describe("open-project/select-folder", () => {
    it("returns selected folder path from dialog", async () => {
      const mockDialogBoundary = {
        showOpenDialog: vi.fn().mockResolvedValue({
          canceled: false,
          filePaths: [{ toString: () => "/selected/project" }],
        }),
      };

      const { dispatcher } = createTestSetup(
        { intentType: INTENT_OPEN_PROJECT, operation: new MinimalSelectFolderOperation() },
        { dialogLayer: mockDialogBoundary }
      );

      const result = (await dispatcher.dispatch({
        type: INTENT_OPEN_PROJECT,
        payload: {},
      })) as SelectFolderHookResult;

      expect(result.folderPath).toBe("/selected/project");
      expect(mockDialogBoundary.showOpenDialog).toHaveBeenCalledWith({
        properties: ["openDirectory"],
      });
    });

    it("returns null when dialog canceled", async () => {
      const mockDialogBoundary = {
        showOpenDialog: vi.fn().mockResolvedValue({
          canceled: true,
          filePaths: [],
        }),
      };

      const { dispatcher } = createTestSetup(
        { intentType: INTENT_OPEN_PROJECT, operation: new MinimalSelectFolderOperation() },
        { dialogLayer: mockDialogBoundary }
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
  // Retry (now uses DialogManager instead of IPC)
  // -------------------------------------------------------------------------
  describe("app-start/show-ui (retry)", () => {
    it("show-ui hook returns empty object when dialogManager is not provided", async () => {
      const { dispatcher } = createTestSetup({
        intentType: INTENT_APP_START,
        operation: new MinimalShowUIOperation(),
      });

      const result = (await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent)) as unknown as ShowUIHookResult;

      expect(result.waitForRetry).toBeUndefined();
    });
  });
});
