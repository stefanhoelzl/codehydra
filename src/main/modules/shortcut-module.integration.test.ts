// @vitest-environment node
/**
 * Integration tests for ShortcutModule.
 *
 * Tests that the module dispatches shortcut:key intents
 * when keys are pressed in shortcut mode.
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
import { INTENT_SHORTCUT_KEY, ShortcutKeyOperation } from "../operations/shortcut-key";
import { INTENT_SET_MODE, SetModeOperation } from "../operations/set-mode";
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
  const wsHandle = createViewHandle("ws-view");

  return {
    getUIViewHandle: vi.fn().mockReturnValue(uiHandle),
    getMode: vi.fn(() => currentMode),
    getWorkspaceView: vi.fn(() => wsHandle),
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
  dispatchSpy: ReturnType<typeof vi.fn>;
}

async function createHarness(): Promise<TestHarness> {
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
  dispatcher.registerOperation(INTENT_SHORTCUT_KEY, new ShortcutKeyOperation());
  dispatcher.registerOperation(INTENT_SET_MODE, new SetModeOperation());

  const dispatchSpy = vi.fn((intent: { type: string; payload: unknown }) =>
    dispatcher.dispatch(intent)
  );

  const module = createShortcutModule({
    viewManager: viewManager as unknown as ShortcutModuleDeps["viewManager"],
    viewLayer: viewLayer as unknown as ShortcutModuleDeps["viewLayer"],
    windowLayer,
    getWindowHandle: () => createWindowHandle(),
    dispatch: dispatchSpy,
    logger: SILENT_LOGGER,
  });

  dispatcher.registerModule(module);

  await dispatcher.dispatch({
    type: INTENT_APP_START,
    payload: {},
  } as AppStartIntent);

  return { viewLayer, viewManager, dispatcher, uiHandle, dispatchSpy };
}

// =============================================================================
// Tests
// =============================================================================

describe("ShortcutModule integration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("dispatches shortcut:key intent for recognized shortcut keys", async () => {
    const { viewLayer, dispatchSpy } = await createHarness();

    viewLayer.simulateKey("ui-view", "ArrowUp");

    expect(dispatchSpy).toHaveBeenCalledWith({
      type: INTENT_SHORTCUT_KEY,
      payload: { key: "up" },
    });
  });

  it("dispatches shortcut:key intent for unrecognized keys (normalized)", async () => {
    const { viewLayer, dispatchSpy } = await createHarness();

    viewLayer.simulateKey("ui-view", "d");

    expect(dispatchSpy).toHaveBeenCalledWith({
      type: INTENT_SHORTCUT_KEY,
      payload: { key: "d" },
    });
  });

  it("dispatches shortcut:key intent for digit keys", async () => {
    const { viewLayer, dispatchSpy } = await createHarness();

    viewLayer.simulateKey("ui-view", "5");

    expect(dispatchSpy).toHaveBeenCalledWith({
      type: INTENT_SHORTCUT_KEY,
      payload: { key: "5" },
    });
  });
});
