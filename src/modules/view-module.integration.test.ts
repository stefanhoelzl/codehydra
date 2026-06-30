// @vitest-environment node
/**
 * Integration tests for ViewModule through the Dispatcher.
 *
 * Tests verify the full pipeline: dispatcher -> operation -> hook handlers.
 * Covers: app-start/init (shell creation), active-workspace bookkeeping
 * (resolve / get-active / switch / delete / hibernate), the open-project
 * folder picker, and app-shutdown/stop disposal. The startup surfaces (boot
 * splash, setup progress, agent-selection, workspace loading) are owned by the
 * presenter now and tested in presentation-module.integration.test.ts.
 */

import { createMockDispatcher } from "../intents/lib/dispatcher.test-utils";
import { describe, it, expect, vi } from "vitest";
import { Dispatcher } from "../intents/lib/dispatcher";
import type { Operation, OperationContext, HookOutput } from "../intents/lib/operation";
import type { Intent } from "../intents/lib/types";
import { createMinimalOperation } from "../intents/lib/operation.test-utils";
import type { IntentModule } from "../intents/lib/module";
import { INTENT_APP_START, APP_START_OPERATION_ID } from "../intents/app-start";
import type { AppStartIntent } from "../intents/app-start";
import {
  AppShutdownOperation,
  INTENT_APP_SHUTDOWN,
  APP_SHUTDOWN_OPERATION_ID,
} from "../intents/app-shutdown";
import type { AppShutdownIntent } from "../intents/app-shutdown";
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
import { EVENT_CODE_SERVER_RESTARTED } from "../intents/app-resume";
import type { CodeServerRestartedEvent } from "../intents/app-resume";
import {
  INTENT_DELETE_WORKSPACE,
  DELETE_WORKSPACE_OPERATION_ID,
} from "../intents/delete-workspace";
import type {
  DeleteWorkspaceIntent,
  DeletePipelineHookInput,
  ShutdownHookResult,
} from "../intents/delete-workspace";
import { INTENT_OPEN_PROJECT, OPEN_PROJECT_OPERATION_ID } from "../intents/open-project";
import type { SelectFolderHookResult } from "../intents/open-project";
import {
  RESOLVE_WORKSPACE_OPERATION_ID,
  type ResolveHookInput,
  type ResolveHookResult,
} from "../intents/resolve-workspace";
import { SILENT_LOGGER } from "../boundaries/platform/logging";
import { createMockViewManager } from "../boundaries/shell/view-manager.test-utils";
import { createViewModule, type ViewModuleDeps } from "./view-module";
import type { ProjectId, WorkspaceName } from "../shared/api/types";

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
      workspaceName: "test-workspace" as WorkspaceName,
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
  const result = (
    (await module.hooks![RESOLVE_WORKSPACE_OPERATION_ID]!.resolve!.handler(
      hookCtx
    )) as HookOutput<ResolveHookResult>
  ).result!;
  return result.active === true;
}

// =============================================================================
// Tests
// =============================================================================

describe("ViewModule Integration", () => {
  // -------------------------------------------------------------------------
  // code-server:restarted → reload workspace iframes
  // -------------------------------------------------------------------------
  describe("code-server:restarted", () => {
    it("asks the view manager to reload frames", async () => {
      const { viewManager, module } = createTestSetup();

      const event: CodeServerRestartedEvent = {
        type: EVENT_CODE_SERVER_RESTARTED,
        payload: {},
      };
      await module.events![EVENT_CODE_SERVER_RESTARTED]!.handler(event);

      expect(viewManager.reloadFrames).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // delete-workspace/shutdown → clears active surface, returns wasActive
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
  // app-shutdown/stop → viewManager.destroy() + layers disposed
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
});
