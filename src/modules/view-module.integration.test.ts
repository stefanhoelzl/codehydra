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
import { createAppBoundaryMock } from "../boundaries/shell/app.state-mock";
import { describe, it, expect, vi } from "vitest";
import { z } from "zod/v4";
import { Dispatcher } from "../intents/lib/dispatcher";
import type {
  Operation,
  OperationContext,
  OperationSchemas,
  IntentOf,
} from "../intents/lib/operation";
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
import { EVENT_IDE_SERVER_RESTARTED, EVENT_IDE_SERVER_SESSIONS_STALE } from "../intents/app-resume";
import type { IdeServerRestartedEvent, IdeServerSessionsStaleEvent } from "../intents/app-resume";
import {
  INTENT_OPEN_PROJECT,
  OPEN_PROJECT_OPERATION_ID,
  selectFolderHookResultSchema,
} from "../intents/open-project";
import type { SelectFolderHookResult } from "../intents/open-project";
import { SILENT_LOGGER } from "../boundaries/platform/logging";
import { createMockViewManager } from "../boundaries/shell/view-manager.test-utils";
import { createViewModule, type ViewModuleDeps } from "./view-module";
import { testPath } from "../shared/test-fixtures";
import type { ProjectPath } from "../intents/contract";

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

const selectFolderOpSchemas = {
  type: INTENT_OPEN_PROJECT,
  payload: z.unknown(),
  result: z.custom<SelectFolderHookResult | null>(),
  hooks: { "select-folder": { result: selectFolderHookResultSchema } },
} satisfies OperationSchemas;

/** Runs "select-folder" hook point (matches OpenProjectOperation's conditional hook). */
class MinimalSelectFolderOperation implements Operation<typeof selectFolderOpSchemas> {
  readonly id = OPEN_PROJECT_OPERATION_ID;
  readonly schemas = selectFolderOpSchemas;
  async execute(
    ctx: OperationContext<IntentOf<typeof selectFolderOpSchemas>, typeof selectFolderOpSchemas>
  ): Promise<SelectFolderHookResult | null> {
    const { results, errors } = await ctx.hooks.collect("select-folder", {
      intent: ctx.intent,
    });
    if (errors.length > 0) throw errors[0]!;
    let folderPath: ProjectPath | null = null;
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

function createTestSetup<S extends OperationSchemas = OperationSchemas>(
  operationOverride?: { intentType: string; operation: Operation<S> },
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
    dispatcher.registerOperation(operationOverride.operation);
  }

  dispatcher.registerModule(module);

  return { dispatcher, viewManager, layers, module };
}

// =============================================================================
// Tests
// =============================================================================

describe("ViewModule Integration", () => {
  // -------------------------------------------------------------------------
  // ide-server:restarted → reload workspace iframes
  // -------------------------------------------------------------------------
  describe("ide-server:restarted", () => {
    it("asks the view manager to reload frames", async () => {
      const { viewManager, module } = createTestSetup();

      const event: IdeServerRestartedEvent = {
        type: EVENT_IDE_SERVER_RESTARTED,
        payload: {},
      };
      await module.events![EVENT_IDE_SERVER_RESTARTED]!.handler(event);

      expect(viewManager.reloadFrames).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // ide-server:sessions-stale → reload workspace iframes. Same remedy as a
  // restart, different cause: the server survived the suspend but every frame's
  // session outlasted what the IDE can reconnect across.
  // -------------------------------------------------------------------------
  describe("ide-server:sessions-stale", () => {
    it("asks the view manager to reload frames", async () => {
      const { viewManager, module } = createTestSetup();

      const event: IdeServerSessionsStaleEvent = {
        type: EVENT_IDE_SERVER_SESSIONS_STALE,
        payload: {},
      };
      await module.events![EVENT_IDE_SERVER_SESSIONS_STALE]!.handler(event);

      expect(viewManager.reloadFrames).toHaveBeenCalledTimes(1);
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

      dispatcher.registerOperation(new AppShutdownOperation());

      const module = createViewModule({
        viewManager: viewManager as unknown as ViewModuleDeps["viewManager"],
        logger: SILENT_LOGGER,
        viewLayer: layers.viewLayer as unknown as ViewModuleDeps["viewLayer"],
        windowLayer: layers.windowLayer as unknown as ViewModuleDeps["windowLayer"],
        sessionLayer: layers.sessionLayer as unknown as ViewModuleDeps["sessionLayer"],
      });

      dispatcher.registerModule(module);
      dispatcher.registerModule(quitModule);

      await dispatcher.dispatch<AppShutdownIntent>({
        type: INTENT_APP_SHUTDOWN,
        payload: {},
      });

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

      dispatcher.registerOperation(new AppShutdownOperation());

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
        dispatcher.dispatch<AppShutdownIntent>({
          type: INTENT_APP_SHUTDOWN,
          payload: {},
        })
      ).resolves.not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Reactivation: another launch (or a macOS dock activation) asks the running
  // instance to come forward.
  // -------------------------------------------------------------------------
  describe("reactivation", () => {
    function createWindowManager() {
      return {
        create: vi.fn(),
        maximizeAsync: vi.fn().mockResolvedValue(undefined),
        focus: vi.fn(),
        present: vi.fn(),
      };
    }

    it("presents the window when another launch asks it to come forward", async () => {
      const dispatcher = createMockDispatcher();
      const viewManager = createMockViewManager();
      const windowManager = createWindowManager();
      const appLayer = createAppBoundaryMock();

      dispatcher.registerOperation(
        createMinimalOperation(APP_START_OPERATION_ID, INTENT_APP_START, "init", {
          hookContext: (ctx) => ({ intent: ctx.intent, capabilities: { "app-ready": true } }),
        })
      );
      dispatcher.registerModule(
        createViewModule({
          viewManager: viewManager as unknown as ViewModuleDeps["viewManager"],
          logger: SILENT_LOGGER,
          viewLayer: null,
          windowLayer: null,
          sessionLayer: null,
          windowManager,
          appLayer,
        })
      );

      await dispatcher.dispatch<AppStartIntent>({ type: INTENT_APP_START, payload: {} });

      // present(), not focus(): the window is typically minimized or buried
      // when a second launch arrives, and focus() alone would not surface it.
      expect(windowManager.present).not.toHaveBeenCalled();
      appLayer.$.triggerReactivate();
      expect(windowManager.present).toHaveBeenCalledTimes(1);
    });

    it("ignores a reactivation that arrives before the window exists", async () => {
      // The lock is claimed in before-ready but the window is only created in
      // init, so a launch landing in that gap has nothing to present.
      const windowManager = createWindowManager();
      const appLayer = createAppBoundaryMock();

      createViewModule({
        viewManager: createMockViewManager() as unknown as ViewModuleDeps["viewManager"],
        logger: SILENT_LOGGER,
        viewLayer: null,
        windowLayer: null,
        sessionLayer: null,
        windowManager,
        appLayer,
      });

      expect(() => {
        appLayer.$.triggerReactivate();
      }).not.toThrow();
      expect(windowManager.present).not.toHaveBeenCalled();
    });

    it("stops presenting once the app has shut down", async () => {
      const dispatcher = createMockDispatcher();
      const viewManager = createMockViewManager();
      const windowManager = createWindowManager();
      const appLayer = createAppBoundaryMock();

      dispatcher.registerOperation(
        createMinimalOperation(APP_START_OPERATION_ID, INTENT_APP_START, "init", {
          hookContext: (ctx) => ({ intent: ctx.intent, capabilities: { "app-ready": true } }),
        })
      );
      dispatcher.registerOperation(new AppShutdownOperation());
      dispatcher.registerModule(
        createViewModule({
          viewManager: viewManager as unknown as ViewModuleDeps["viewManager"],
          logger: SILENT_LOGGER,
          viewLayer: null,
          windowLayer: null,
          sessionLayer: null,
          windowManager,
          appLayer,
        })
      );
      dispatcher.registerModule({
        name: "test",
        hooks: { [APP_SHUTDOWN_OPERATION_ID]: { quit: { handler: async () => {} } } },
      });

      await dispatcher.dispatch<AppStartIntent>({ type: INTENT_APP_START, payload: {} });
      await dispatcher.dispatch<AppShutdownIntent>({ type: INTENT_APP_SHUTDOWN, payload: {} });

      appLayer.$.triggerReactivate();
      expect(windowManager.present).not.toHaveBeenCalled();
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
        createMinimalOperation(APP_START_OPERATION_ID, INTENT_APP_START, "init", {
          hookContext: (ctx) => ({ intent: ctx.intent, capabilities: { "app-ready": true } }),
        })
      );

      const menuLayer = { setApplicationMenu: vi.fn() };
      const windowManager = {
        create: vi.fn(),
        maximizeAsync: vi.fn().mockResolvedValue(undefined),
        focus: vi.fn(),
        present: vi.fn(),
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

      await dispatcher.dispatch<AppStartIntent>({
        type: INTENT_APP_START,
        payload: {},
      });

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
        createMinimalOperation(APP_START_OPERATION_ID, INTENT_APP_START, "init", {
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
        dispatcher.dispatch<AppStartIntent>({
          type: INTENT_APP_START,
          payload: {},
        })
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
        showDialog: vi.fn().mockResolvedValue({
          canceled: false,
          filePaths: [{ toString: () => testPath("/selected/project").toNative() }],
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

      expect(result.folderPath).toBe(testPath("/selected/project").toNative());
      expect(mockDialogBoundary.showDialog).toHaveBeenCalledWith({
        properties: ["openDirectory"],
      });
    });

    it("returns null when dialog canceled", async () => {
      const mockDialogBoundary = {
        showDialog: vi.fn().mockResolvedValue({
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
