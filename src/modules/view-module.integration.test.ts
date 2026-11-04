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
import { createBehavioralDialogBoundary } from "../boundaries/shell/dialog.test-utils";
import { describe, it, expect, vi } from "vitest";
import type { Dispatcher } from "../intents/lib/dispatcher";
import type { Operation, OperationSchemas } from "../intents/lib/operation";
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
// Deps
// =============================================================================

const UI_HTML_PATH = "file:///app/ui.html";
const UI_PRELOAD_PATH = "/app/preload/index.cjs";

/** Everything a ViewModule gets in production, as behavioral mocks. */
function createDeps() {
  return {
    viewManager: createMockViewManager(),
    logger: SILENT_LOGGER,
    viewLayer: { dispose: vi.fn().mockResolvedValue(undefined) },
    windowLayer: { dispose: vi.fn().mockResolvedValue(undefined) },
    sessionLayer: { dispose: vi.fn().mockResolvedValue(undefined) },
    dialogLayer: createBehavioralDialogBoundary() as ViewModuleDeps["dialogLayer"],
    menuLayer: { setApplicationMenu: vi.fn() },
    windowManager: {
      create: vi.fn(),
      maximizeAsync: vi.fn().mockResolvedValue(undefined),
      focus: vi.fn(),
      present: vi.fn(),
    },
    appLayer: createAppBoundaryMock(),
    uiHtmlPath: UI_HTML_PATH,
    uiPreloadPath: UI_PRELOAD_PATH,
  };
}

type Deps = ReturnType<typeof createDeps>;

function buildModule(deps: Deps): IntentModule {
  return createViewModule({
    ...deps,
    viewManager: deps.viewManager as unknown as ViewModuleDeps["viewManager"],
  });
}

// =============================================================================
// Minimal Test Operations
// =============================================================================

/** Runs "select-folder" hook point (matches OpenProjectOperation's conditional hook). */
function minimalSelectFolder(): Operation<OperationSchemas> {
  return createMinimalOperation<SelectFolderHookResult, SelectFolderHookResult>(
    OPEN_PROJECT_OPERATION_ID,
    INTENT_OPEN_PROJECT,
    "select-folder",
    {
      hookContext: (ctx) => ({ intent: ctx.intent }),
      hookSchemas: { result: selectFolderHookResultSchema },
      select: ({ results }) => {
        let folderPath: ProjectPath | null = null;
        for (const r of results) {
          if (r.folderPath) folderPath = r.folderPath;
        }
        return { folderPath };
      },
    }
  );
}

/** Runs "init" with the app ready. */
function minimalInit(): Operation<OperationSchemas> {
  return createMinimalOperation(APP_START_OPERATION_ID, INTENT_APP_START, "init", {
    hookContext: (ctx) => ({ intent: ctx.intent, capabilities: { "app-ready": true } }),
  });
}

/** A no-op quit hook, so the shutdown operation has every hook point it needs. */
const QUIT_MODULE: IntentModule = {
  name: "test",
  hooks: {
    [APP_SHUTDOWN_OPERATION_ID]: {
      quit: { handler: async () => {} },
    },
  },
};

// =============================================================================
// Test Setup
// =============================================================================

interface TestSetup {
  dispatcher: Dispatcher;
  deps: Deps;
  module: IntentModule;
}

function createTestSetup(
  operations: readonly Operation<OperationSchemas>[] = [],
  overrides: Partial<Deps> = {}
): TestSetup {
  const dispatcher = createMockDispatcher();
  const deps = { ...createDeps(), ...overrides };
  const module = buildModule(deps);

  for (const operation of operations) {
    dispatcher.registerOperation(operation);
  }
  dispatcher.registerModule(module);

  return { dispatcher, deps, module };
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
      const { deps, module } = createTestSetup();

      const event: IdeServerRestartedEvent = {
        type: EVENT_IDE_SERVER_RESTARTED,
        payload: {},
      };
      await module.events![EVENT_IDE_SERVER_RESTARTED]!.handler(event);

      expect(deps.viewManager.reloadFrames).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // ide-server:sessions-stale → reload workspace iframes. Same remedy as a
  // restart, different cause: the server survived the suspend but every frame's
  // session outlasted what the IDE can reconnect across.
  // -------------------------------------------------------------------------
  describe("ide-server:sessions-stale", () => {
    it("asks the view manager to reload frames", async () => {
      const { deps, module } = createTestSetup();

      const event: IdeServerSessionsStaleEvent = {
        type: EVENT_IDE_SERVER_SESSIONS_STALE,
        payload: {},
      };
      await module.events![EVENT_IDE_SERVER_SESSIONS_STALE]!.handler(event);

      expect(deps.viewManager.reloadFrames).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // app-shutdown/stop → viewManager.destroy() + layers disposed
  // -------------------------------------------------------------------------
  describe("app-shutdown/stop", () => {
    it("destroys the UI view, then disposes the view, window and session layers in order", async () => {
      const { dispatcher, deps } = createTestSetup([new AppShutdownOperation()]);
      dispatcher.registerModule(QUIT_MODULE);

      await dispatcher.dispatch<AppShutdownIntent>({
        type: INTENT_APP_SHUTDOWN,
        payload: {},
      });

      const order = [
        deps.viewManager.destroy,
        deps.viewLayer.dispose,
        deps.windowLayer.dispose,
        deps.sessionLayer.dispose,
      ].map((fn) => vi.mocked(fn).mock.invocationCallOrder[0]);
      expect(order.every((n) => n !== undefined)).toBe(true);
      expect(order).toEqual([...order].sort((a, b) => a! - b!));
    });
  });

  // -------------------------------------------------------------------------
  // Reactivation: another launch (or a macOS dock activation) asks the running
  // instance to come forward.
  // -------------------------------------------------------------------------
  describe("reactivation", () => {
    it("presents the window when another launch asks it to come forward", async () => {
      const { dispatcher, deps } = createTestSetup([minimalInit()]);

      await dispatcher.dispatch<AppStartIntent>({ type: INTENT_APP_START, payload: {} });

      // present(), not focus(): the window is typically minimized or buried
      // when a second launch arrives, and focus() alone would not surface it.
      expect(deps.windowManager.present).not.toHaveBeenCalled();
      deps.appLayer.$.triggerReactivate();
      expect(deps.windowManager.present).toHaveBeenCalledTimes(1);
    });

    it("ignores a reactivation that arrives before the window exists", () => {
      // The lock is claimed in before-ready but the window is only created in
      // init, so a launch landing in that gap has nothing to present.
      const { deps } = createTestSetup();

      expect(() => {
        deps.appLayer.$.triggerReactivate();
      }).not.toThrow();
      expect(deps.windowManager.present).not.toHaveBeenCalled();
    });

    it("stops presenting once the app has shut down", async () => {
      const { dispatcher, deps } = createTestSetup([minimalInit(), new AppShutdownOperation()]);
      dispatcher.registerModule(QUIT_MODULE);

      await dispatcher.dispatch<AppStartIntent>({ type: INTENT_APP_START, payload: {} });
      await dispatcher.dispatch<AppShutdownIntent>({ type: INTENT_APP_SHUTDOWN, payload: {} });

      deps.appLayer.$.triggerReactivate();
      expect(deps.windowManager.present).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // app-start/init → creates window/views, maximizes, loads UI, focuses
  // -------------------------------------------------------------------------
  describe("app-start/init", () => {
    it("calls menuLayer, windowManager, viewManager, and viewLayer in order", async () => {
      const { dispatcher, deps } = createTestSetup([minimalInit()]);

      await dispatcher.dispatch<AppStartIntent>({
        type: INTENT_APP_START,
        payload: {},
      });

      expect(deps.menuLayer.setApplicationMenu).toHaveBeenCalledWith(null);
      expect(deps.windowManager.create).toHaveBeenCalledWith(
        expect.objectContaining({ preload: UI_PRELOAD_PATH })
      );
      expect(deps.viewManager.create).toHaveBeenCalled();
      expect(deps.windowManager.maximizeAsync).toHaveBeenCalled();
      expect(deps.windowManager.focus).toHaveBeenCalled();
      expect(deps.viewManager.loadUIContent).toHaveBeenCalledWith(UI_HTML_PATH);
      expect(deps.viewManager.focus).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // open-project → select-folder hook
  // -------------------------------------------------------------------------
  describe("open-project/select-folder", () => {
    it("returns selected folder path from dialog", async () => {
      const dialogLayer = {
        showDialog: vi.fn().mockResolvedValue({
          canceled: false,
          filePaths: [{ toString: () => testPath("/selected/project").toNative() }],
        }),
      };

      const { dispatcher } = createTestSetup([minimalSelectFolder()], { dialogLayer });

      const result = (await dispatcher.dispatch({
        type: INTENT_OPEN_PROJECT,
        payload: {},
      })) as SelectFolderHookResult;

      expect(result.folderPath).toBe(testPath("/selected/project").toNative());
      expect(dialogLayer.showDialog).toHaveBeenCalledWith({
        properties: ["openDirectory"],
      });
    });

    it("returns null when dialog canceled", async () => {
      // The behavioral dialog boundary answers "canceled" by default.
      const { dispatcher } = createTestSetup([minimalSelectFolder()]);

      const result = (await dispatcher.dispatch({
        type: INTENT_OPEN_PROJECT,
        payload: {},
      })) as SelectFolderHookResult;

      expect(result.folderPath).toBeNull();
    });
  });
});
