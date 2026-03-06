// @vitest-environment node
/**
 * Integration tests for ShortcutModule DevTools toggling.
 *
 * Tests the onRawShortcutKey callback wiring that enables
 * Alt+X → D/W DevTools shortcuts in development mode.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";
import { createMinimalOperation } from "../intents/infrastructure/operation.test-utils";
import {
  INTENT_APP_START,
  APP_START_OPERATION_ID,
  type AppStartIntent,
} from "../operations/app-start";
import { AppShutdownOperation, INTENT_APP_SHUTDOWN } from "../operations/app-shutdown";
import { SILENT_LOGGER } from "../../services/logging";
import { createShortcutModule, type ShortcutModuleDeps } from "./shortcut-module";
import type { ViewHandle, WindowHandle } from "../../services/shell/types";
import type { KeyboardInput, Unsubscribe } from "../../services/shell/view";
import type { UIMode } from "../../shared/ipc";

// =============================================================================
// Helpers
// =============================================================================

function createViewHandle(id: string): ViewHandle {
  return { id, __brand: "ViewHandle" as const };
}

function createWindowHandle(id: string = "window-1"): WindowHandle {
  return { id, __brand: "WindowHandle" as const };
}

/**
 * Captures before-input-event callbacks so we can simulate keyboard input
 * after the controller is constructed.
 */
function createMockViewLayer() {
  const inputCallbacks = new Map<
    string,
    (input: KeyboardInput, preventDefault: () => void) => void
  >();

  return {
    onBeforeInputEvent: vi.fn(
      (
        handle: ViewHandle,
        callback: (input: KeyboardInput, preventDefault: () => void) => void
      ): Unsubscribe => {
        inputCallbacks.set(handle.id, callback);
        return vi.fn();
      }
    ),
    onDestroyed: vi.fn((): Unsubscribe => vi.fn()),
    openDevTools: vi.fn(),
    closeDevTools: vi.fn(),
    isDevToolsOpened: vi.fn().mockReturnValue(false),
    /** Simulate a key press on a registered view */
    simulateKey(viewId: string, key: string): void {
      const cb = inputCallbacks.get(viewId);
      if (!cb) throw new Error(`No input callback for view ${viewId}`);
      cb(
        {
          type: "keyDown",
          key,
          isAutoRepeat: false,
          control: false,
          shift: false,
          alt: false,
          meta: false,
        },
        vi.fn()
      );
    },
  };
}

function createMockViewManager(uiHandle: ViewHandle) {
  let currentMode: UIMode = "shortcut";
  let activePath: string | null = "/test/workspace";
  const wsHandle = createViewHandle("ws-view");

  return {
    getUIViewHandle: vi.fn().mockReturnValue(uiHandle),
    getMode: vi.fn(() => currentMode),
    sendToUI: vi.fn(),
    getWorkspaceView: vi.fn((path: string) => (path === activePath ? wsHandle : null)),
    getActiveWorkspacePath: vi.fn(() => activePath),
    /** Test helper to set the active workspace path */
    _setActivePath(path: string | null) {
      activePath = path;
    },
    /** Test helper to set the mode */
    _setMode(mode: UIMode) {
      currentMode = mode;
    },
    /** The workspace view handle */
    _wsHandle: wsHandle,
  };
}

function createMockWindowLayer() {
  return {
    onBlur: vi.fn((): Unsubscribe => vi.fn()),
  };
}

interface TestHarness {
  viewLayer: ReturnType<typeof createMockViewLayer>;
  viewManager: ReturnType<typeof createMockViewManager>;
  dispatcher: Dispatcher;
  uiHandle: ViewHandle;
}

async function createHarness(isDevelopment: boolean): Promise<TestHarness> {
  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);
  const uiHandle = createViewHandle("ui-view");
  const viewLayer = createMockViewLayer();
  const viewManager = createMockViewManager(uiHandle);
  const windowLayer = createMockWindowLayer();

  dispatcher.registerOperation(
    INTENT_APP_START,
    createMinimalOperation(APP_START_OPERATION_ID, "init")
  );
  dispatcher.registerOperation(INTENT_APP_SHUTDOWN, new AppShutdownOperation());

  const module = createShortcutModule({
    viewManager: viewManager as unknown as ShortcutModuleDeps["viewManager"],
    viewLayer: viewLayer as unknown as ShortcutModuleDeps["viewLayer"],
    windowLayer,
    getWindowHandle: () => createWindowHandle(),
    dispatch: (intent) => dispatcher.dispatch(intent),
    logger: SILENT_LOGGER,
    isDevelopment,
  });

  dispatcher.registerModule(module);

  await dispatcher.dispatch({
    type: INTENT_APP_START,
    payload: {},
  } as AppStartIntent);

  return { viewLayer, viewManager, dispatcher, uiHandle };
}

// =============================================================================
// Tests
// =============================================================================

describe("ShortcutModule DevTools integration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("isDevelopment: true", () => {
    it("D toggles UI DevTools open", async () => {
      const { viewLayer, uiHandle } = await createHarness(true);

      viewLayer.simulateKey("ui-view", "d");

      expect(viewLayer.openDevTools).toHaveBeenCalledWith(uiHandle, { mode: "detach" });
    });

    it("D toggles UI DevTools closed when already open", async () => {
      const { viewLayer, uiHandle } = await createHarness(true);
      viewLayer.isDevToolsOpened.mockReturnValue(true);

      viewLayer.simulateKey("ui-view", "d");

      expect(viewLayer.closeDevTools).toHaveBeenCalledWith(uiHandle);
      expect(viewLayer.openDevTools).not.toHaveBeenCalled();
    });

    it("D is case-insensitive", async () => {
      const { viewLayer, uiHandle } = await createHarness(true);

      viewLayer.simulateKey("ui-view", "D");

      expect(viewLayer.openDevTools).toHaveBeenCalledWith(uiHandle, { mode: "detach" });
    });

    it("W toggles active workspace DevTools open", async () => {
      const { viewLayer, viewManager } = await createHarness(true);

      viewLayer.simulateKey("ui-view", "w");

      expect(viewLayer.openDevTools).toHaveBeenCalledWith(viewManager._wsHandle, {
        mode: "detach",
      });
    });

    it("W toggles workspace DevTools closed when already open", async () => {
      const { viewLayer, viewManager } = await createHarness(true);
      viewLayer.isDevToolsOpened.mockReturnValue(true);

      viewLayer.simulateKey("ui-view", "w");

      expect(viewLayer.closeDevTools).toHaveBeenCalledWith(viewManager._wsHandle);
    });

    it("W is consumed even when no active workspace", async () => {
      const { viewLayer, viewManager } = await createHarness(true);
      viewManager._setActivePath(null);

      viewLayer.simulateKey("ui-view", "w");

      // Key consumed (no DevTools call, but no shortcut emission either)
      expect(viewLayer.openDevTools).not.toHaveBeenCalled();
      expect(viewLayer.closeDevTools).not.toHaveBeenCalled();
      expect(viewManager.sendToUI).not.toHaveBeenCalled();
    });
  });

  describe("isDevelopment: false", () => {
    it("D does not trigger DevTools", async () => {
      const { viewLayer } = await createHarness(false);

      viewLayer.simulateKey("ui-view", "d");

      expect(viewLayer.openDevTools).not.toHaveBeenCalled();
      expect(viewLayer.closeDevTools).not.toHaveBeenCalled();
    });

    it("W does not trigger DevTools", async () => {
      const { viewLayer } = await createHarness(false);

      viewLayer.simulateKey("ui-view", "w");

      expect(viewLayer.openDevTools).not.toHaveBeenCalled();
      expect(viewLayer.closeDevTools).not.toHaveBeenCalled();
    });
  });
});
