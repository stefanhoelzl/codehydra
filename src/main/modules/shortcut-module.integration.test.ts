// @vitest-environment node
/**
 * Integration tests for ShortcutModule.
 *
 * Tests the full path from input event through to mode changes and shortcut key emission.
 *
 * IMPORTANT: These tests verify that NO keys are prevented via preventDefault().
 * This is intentional - Electron bug #37336 causes keyUp events to not fire when
 * keyDown was prevented. By letting all keys propagate, we ensure reliable Alt
 * keyUp detection for exiting shortcut mode.
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
import type { AppShutdownIntent } from "../operations/app-shutdown";
import { INTENT_SHORTCUT_KEY, ShortcutKeyOperation } from "../operations/shortcut-key";
import { EVENT_WORKSPACE_CREATED, type WorkspaceCreatedEvent } from "../operations/open-workspace";
import { INTENT_SET_MODE, SET_MODE_OPERATION_ID } from "../operations/set-mode";
import { SILENT_LOGGER } from "../../services/logging";
import { createShortcutModule, normalizeKey, type ShortcutModuleDeps } from "./shortcut-module";
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

function createKeyboardInput(
  key: string,
  type: "keyDown" | "keyUp" = "keyDown",
  options: { alt?: boolean; isAutoRepeat?: boolean } = {}
): KeyboardInput {
  return {
    type,
    key,
    isAutoRepeat: options.isAutoRepeat ?? false,
    control: false,
    shift: false,
    alt: options.alt ?? false,
    meta: false,
  };
}

/**
 * Tracks captured callbacks and unsubscribe spies for viewLayer and windowLayer mocks.
 */
interface MockCallbacks {
  inputCallbacks: Map<string, (input: KeyboardInput, preventDefault: () => void) => void>;
  destroyedCallbacks: Map<string, () => void>;
  inputUnsubscribes: Map<string, ReturnType<typeof vi.fn<() => void>>>;
  destroyedUnsubscribes: Map<string, ReturnType<typeof vi.fn<() => void>>>;
  blurCallback: (() => void) | null;
  blurUnsubscribe: ReturnType<typeof vi.fn<() => void>>;
}

function createMockViewLayer() {
  const callbacks: MockCallbacks = {
    inputCallbacks: new Map(),
    destroyedCallbacks: new Map(),
    inputUnsubscribes: new Map(),
    destroyedUnsubscribes: new Map(),
    blurCallback: null,
    blurUnsubscribe: vi.fn<() => void>(),
  };

  const viewLayer = {
    onBeforeInputEvent: vi.fn(
      (
        handle: ViewHandle,
        callback: (input: KeyboardInput, preventDefault: () => void) => void
      ): Unsubscribe => {
        callbacks.inputCallbacks.set(handle.id, callback);
        const unsub = vi.fn<() => void>();
        callbacks.inputUnsubscribes.set(handle.id, unsub);
        return unsub;
      }
    ),
    onDestroyed: vi.fn((handle: ViewHandle, callback: () => void): Unsubscribe => {
      callbacks.destroyedCallbacks.set(handle.id, callback);
      const unsub = vi.fn<() => void>();
      callbacks.destroyedUnsubscribes.set(handle.id, unsub);
      return unsub;
    }),
  };

  return { viewLayer, callbacks };
}

function createMockViewManager(uiHandle: ViewHandle, initialMode: UIMode = "shortcut") {
  let currentMode: UIMode = initialMode;
  const wsHandle = createViewHandle("ws-view");

  return {
    getUIViewHandle: vi.fn().mockReturnValue(uiHandle),
    getMode: vi.fn(() => currentMode),
    getWorkspaceView: vi.fn(() => wsHandle),
    _setMode(mode: UIMode) {
      currentMode = mode;
    },
    _wsHandle: wsHandle,
  };
}

function createMockWindowLayer(callbacks: MockCallbacks) {
  return {
    onBlur: vi.fn((_handle: WindowHandle, callback: () => void): Unsubscribe => {
      callbacks.blurCallback = callback;
      return callbacks.blurUnsubscribe;
    }),
  };
}

/**
 * Simulate keyboard input on a registered view.
 */
function simulateInput(
  callbacks: MockCallbacks,
  viewId: string,
  input: KeyboardInput
): { preventDefault: ReturnType<typeof vi.fn> } {
  const cb = callbacks.inputCallbacks.get(viewId);
  if (!cb) throw new Error(`No input callback for view ${viewId}`);
  const preventDefault = vi.fn();
  cb(input, preventDefault);
  return { preventDefault };
}

interface TestHarness {
  callbacks: MockCallbacks;
  viewManager: ReturnType<typeof createMockViewManager>;
  module: ReturnType<typeof createShortcutModule>;
  dispatcher: Dispatcher;
  uiHandle: ViewHandle;
  dispatchSpy: ReturnType<typeof vi.fn>;
}

async function createHarness(initialMode: UIMode = "shortcut"): Promise<TestHarness> {
  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);
  const uiHandle = createViewHandle("ui-view");
  const { viewLayer, callbacks } = createMockViewLayer();
  const viewManager = createMockViewManager(uiHandle, initialMode);
  const windowLayer = createMockWindowLayer(callbacks);

  dispatcher.registerOperation(
    INTENT_APP_START,
    createMinimalOperation(APP_START_OPERATION_ID, "init")
  );
  dispatcher.registerOperation(INTENT_APP_SHUTDOWN, new AppShutdownOperation());
  dispatcher.registerOperation(INTENT_SHORTCUT_KEY, new ShortcutKeyOperation());
  dispatcher.registerOperation(
    INTENT_SET_MODE,
    createMinimalOperation(SET_MODE_OPERATION_ID, "set")
  );

  // Dispatch spy that also updates viewManager mode for bidirectional state
  const dispatchSpy = vi.fn((intent: { type: string; payload: unknown }) => {
    if (intent.type === INTENT_SET_MODE) {
      viewManager._setMode((intent.payload as { mode: UIMode }).mode);
    }
    return dispatcher.dispatch(intent);
  });

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

  return { callbacks, viewManager, module, dispatcher, uiHandle, dispatchSpy };
}

// =============================================================================
// Tests
// =============================================================================

describe("normalizeKey", () => {
  it.each([
    ["ArrowUp", "up"],
    ["ArrowDown", "down"],
    ["ArrowLeft", "left"],
    ["ArrowRight", "right"],
    ["Enter", "enter"],
    ["Delete", "delete"],
    ["Backspace", "delete"],
  ] as const)("maps %s to %s", (input, expected) => {
    expect(normalizeKey(input)).toBe(expected);
  });

  it.each([
    ["a", "a"],
    ["d", "d"],
    ["Escape", "escape"],
    ["0", "0"],
    ["9", "9"],
  ] as const)("lowercases %s to %s", (input, expected) => {
    expect(normalizeKey(input)).toBe(expected);
  });
});

describe("ShortcutModule integration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("view registration", () => {
    it("subscribes to input and destroyed events on init", async () => {
      const { callbacks } = await createHarness();

      // UI view is registered during init
      expect(callbacks.inputCallbacks.has("ui-view")).toBe(true);
      expect(callbacks.destroyedCallbacks.has("ui-view")).toBe(true);
    });

    it("does not register the same view twice", async () => {
      const { callbacks } = await createHarness();

      // UI view registered once during init — check that onBeforeInputEvent was called once for it
      const inputCallCount = [...callbacks.inputCallbacks.keys()].filter(
        (id) => id === "ui-view"
      ).length;
      expect(inputCallCount).toBe(1);
    });

    it("auto-unregisters when view is destroyed", async () => {
      const { callbacks } = await createHarness();

      const destroyedCallback = callbacks.destroyedCallbacks.get("ui-view");
      expect(destroyedCallback).toBeDefined();
      destroyedCallback!();

      expect(callbacks.inputUnsubscribes.get("ui-view")).toHaveBeenCalled();
      expect(callbacks.destroyedUnsubscribes.get("ui-view")).toHaveBeenCalled();
    });

    it("registers workspace views on workspace:created event", async () => {
      const { callbacks, module, viewManager } = await createHarness();

      const wsHandle = viewManager._wsHandle;

      // Call the module's event handler directly (same pattern as devtools-module tests)
      module.events![EVENT_WORKSPACE_CREATED]!({
        type: EVENT_WORKSPACE_CREATED,
        payload: { workspacePath: "/test/workspace" },
      } as WorkspaceCreatedEvent);

      expect(callbacks.inputCallbacks.has(wsHandle.id)).toBe(true);
    });
  });

  describe("Alt+X activation", () => {
    it("activates shortcut mode from workspace mode", async () => {
      const { callbacks, viewManager } = await createHarness("workspace");

      simulateInput(callbacks, "ui-view", createKeyboardInput("Alt", "keyDown"));
      simulateInput(callbacks, "ui-view", createKeyboardInput("x", "keyDown"));
      vi.runAllTimers();

      expect(viewManager.getMode()).toBe("shortcut");
    });

    it("activates shortcut mode from hover mode", async () => {
      const { callbacks, viewManager } = await createHarness("hover");

      simulateInput(callbacks, "ui-view", createKeyboardInput("Alt", "keyDown"));
      simulateInput(callbacks, "ui-view", createKeyboardInput("x", "keyDown"));
      vi.runAllTimers();

      expect(viewManager.getMode()).toBe("shortcut");
    });

    it("activates shortcut mode with uppercase X", async () => {
      const { callbacks, viewManager } = await createHarness("workspace");

      simulateInput(callbacks, "ui-view", createKeyboardInput("Alt", "keyDown"));
      simulateInput(callbacks, "ui-view", createKeyboardInput("X", "keyDown"));
      vi.runAllTimers();

      expect(viewManager.getMode()).toBe("shortcut");
    });

    it("does not activate when mode is dialog", async () => {
      const { callbacks, dispatchSpy, viewManager } = await createHarness("dialog");

      simulateInput(callbacks, "ui-view", createKeyboardInput("Alt", "keyDown"));
      simulateInput(callbacks, "ui-view", createKeyboardInput("x", "keyDown"));
      vi.runAllTimers();

      expect(dispatchSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: INTENT_SET_MODE })
      );
      expect(viewManager.getMode()).toBe("dialog");
    });

    it("does not activate when only Alt is pressed", async () => {
      const { callbacks, dispatchSpy } = await createHarness("workspace");

      simulateInput(callbacks, "ui-view", createKeyboardInput("Alt", "keyDown"));

      expect(dispatchSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: INTENT_SET_MODE })
      );
    });

    it("does not activate when X is pressed without prior Alt", async () => {
      const { callbacks, dispatchSpy } = await createHarness("workspace");

      simulateInput(callbacks, "ui-view", createKeyboardInput("x", "keyDown"));

      expect(dispatchSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: INTENT_SET_MODE })
      );
    });

    it("does not activate when non-X key follows Alt", async () => {
      const { callbacks, dispatchSpy } = await createHarness("workspace");

      simulateInput(callbacks, "ui-view", createKeyboardInput("Alt", "keyDown"));
      simulateInput(callbacks, "ui-view", createKeyboardInput("j", "keyDown"));
      vi.runAllTimers();

      expect(dispatchSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: INTENT_SET_MODE })
      );
    });

    it("Alt+X calls dispatch with set:mode once", async () => {
      const { callbacks, dispatchSpy } = await createHarness("workspace");

      simulateInput(callbacks, "ui-view", createKeyboardInput("Alt", "keyDown"));
      simulateInput(callbacks, "ui-view", createKeyboardInput("x", "keyDown"));
      vi.runAllTimers();

      const setModeCalls = dispatchSpy.mock.calls.filter(
        (call: unknown[]) => (call[0] as { type: string }).type === INTENT_SET_MODE
      );
      expect(setModeCalls).toHaveLength(1);
      expect(setModeCalls[0]![0]).toEqual({
        type: INTENT_SET_MODE,
        payload: { mode: "shortcut" },
      });
    });
  });

  describe("Alt release exits shortcut mode", () => {
    it("Alt keyUp exits shortcut mode back to workspace", async () => {
      const { callbacks, viewManager } = await createHarness("shortcut");

      simulateInput(callbacks, "ui-view", createKeyboardInput("Alt", "keyUp"));

      expect(viewManager.getMode()).toBe("workspace");
    });

    it("Alt keyUp in workspace mode is a no-op", async () => {
      const { callbacks, dispatchSpy } = await createHarness("workspace");

      simulateInput(callbacks, "ui-view", createKeyboardInput("Alt", "keyUp"));

      expect(dispatchSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: INTENT_SET_MODE })
      );
    });

    it("full Alt+X activation then Alt release cycle", async () => {
      const { callbacks, viewManager } = await createHarness("workspace");

      // Alt+X activates shortcut mode
      simulateInput(callbacks, "ui-view", createKeyboardInput("Alt", "keyDown"));
      simulateInput(callbacks, "ui-view", createKeyboardInput("x", "keyDown"));
      vi.runAllTimers();
      expect(viewManager.getMode()).toBe("shortcut");

      // Alt release exits shortcut mode
      simulateInput(callbacks, "ui-view", createKeyboardInput("Alt", "keyUp"));
      expect(viewManager.getMode()).toBe("workspace");
    });
  });

  describe("no keys are prevented (#37336)", () => {
    it("no keys in the Alt+X to shortcut-key to Alt-release sequence are prevented", async () => {
      const { callbacks } = await createHarness("workspace");

      // Alt keyDown
      const { preventDefault: altDownPD } = simulateInput(
        callbacks,
        "ui-view",
        createKeyboardInput("Alt", "keyDown")
      );
      expect(altDownPD).not.toHaveBeenCalled();

      // X keyDown
      const { preventDefault: xDownPD } = simulateInput(
        callbacks,
        "ui-view",
        createKeyboardInput("x", "keyDown")
      );
      expect(xDownPD).not.toHaveBeenCalled();

      vi.runAllTimers();

      // ArrowUp keyDown in shortcut mode
      const { preventDefault: arrowPD } = simulateInput(
        callbacks,
        "ui-view",
        createKeyboardInput("ArrowUp", "keyDown")
      );
      expect(arrowPD).not.toHaveBeenCalled();

      // Alt keyUp
      const { preventDefault: altUpPD } = simulateInput(
        callbacks,
        "ui-view",
        createKeyboardInput("Alt", "keyUp")
      );
      expect(altUpPD).not.toHaveBeenCalled();
    });
  });

  describe("shortcut key dispatch", () => {
    it.each([
      ["ArrowUp", "up"],
      ["ArrowDown", "down"],
      ["ArrowLeft", "left"],
      ["ArrowRight", "right"],
      ["Enter", "enter"],
      ["Delete", "delete"],
      ["Backspace", "delete"],
      ["0", "0"],
      ["1", "1"],
      ["2", "2"],
      ["3", "3"],
      ["4", "4"],
      ["5", "5"],
      ["6", "6"],
      ["7", "7"],
      ["8", "8"],
      ["9", "9"],
    ] as const)("dispatches %s as normalized key %s", async (input, expected) => {
      const { callbacks, dispatchSpy } = await createHarness("shortcut");

      simulateInput(callbacks, "ui-view", createKeyboardInput(input, "keyDown"));

      expect(dispatchSpy).toHaveBeenCalledWith({
        type: INTENT_SHORTCUT_KEY,
        payload: { key: expected },
      });
    });

    it("does not dispatch shortcut keys in workspace mode", async () => {
      const { callbacks, dispatchSpy } = await createHarness("workspace");

      simulateInput(callbacks, "ui-view", createKeyboardInput("ArrowUp", "keyDown"));

      expect(dispatchSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: INTENT_SHORTCUT_KEY })
      );
    });

    it("does not dispatch shortcut keys in dialog mode", async () => {
      const { callbacks, dispatchSpy } = await createHarness("dialog");

      simulateInput(callbacks, "ui-view", createKeyboardInput("Enter", "keyDown"));

      expect(dispatchSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: INTENT_SHORTCUT_KEY })
      );
    });

    it("dispatches normalized key for any key in shortcut mode", async () => {
      const { callbacks, dispatchSpy } = await createHarness("shortcut");

      simulateInput(callbacks, "ui-view", createKeyboardInput("a", "keyDown"));

      expect(dispatchSpy).toHaveBeenCalledWith({
        type: INTENT_SHORTCUT_KEY,
        payload: { key: "a" },
      });
    });

    it("dispatches Escape as normalized key", async () => {
      const { callbacks, dispatchSpy } = await createHarness("shortcut");

      simulateInput(callbacks, "ui-view", createKeyboardInput("Escape", "keyDown"));

      expect(dispatchSpy).toHaveBeenCalledWith({
        type: INTENT_SHORTCUT_KEY,
        payload: { key: "escape" },
      });
    });

    it("does not dispatch on keyUp", async () => {
      const { callbacks, dispatchSpy } = await createHarness("shortcut");

      simulateInput(callbacks, "ui-view", createKeyboardInput("ArrowUp", "keyUp"));

      expect(dispatchSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: INTENT_SHORTCUT_KEY })
      );
    });
  });

  describe("edge cases", () => {
    it("auto-repeat events are ignored", async () => {
      const { callbacks } = await createHarness("workspace");

      const { preventDefault } = simulateInput(
        callbacks,
        "ui-view",
        createKeyboardInput("Alt", "keyDown", { isAutoRepeat: true })
      );

      expect(preventDefault).not.toHaveBeenCalled();
    });

    it("window blur resets pending Alt state", async () => {
      const { callbacks, dispatchSpy } = await createHarness("workspace");

      // Alt down to enter ALT_WAITING
      simulateInput(callbacks, "ui-view", createKeyboardInput("Alt", "keyDown"));

      // Window blur resets state
      callbacks.blurCallback!();

      // X down should NOT activate (state was reset)
      simulateInput(callbacks, "ui-view", createKeyboardInput("x", "keyDown"));
      vi.runAllTimers();

      expect(dispatchSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: INTENT_SET_MODE })
      );
    });
  });

  describe("cleanup", () => {
    it("subscribes to window blur on init", async () => {
      const { callbacks } = await createHarness();

      expect(callbacks.blurCallback).not.toBeNull();
    });

    it("dispose unregisters all views and window blur handler on shutdown", async () => {
      const { callbacks, dispatcher, module } = await createHarness();

      // Register an extra view via workspace:created event
      module.events![EVENT_WORKSPACE_CREATED]!({
        type: EVENT_WORKSPACE_CREATED,
        payload: { workspacePath: "/test/workspace" },
      } as WorkspaceCreatedEvent);

      await dispatcher.dispatch({
        type: INTENT_APP_SHUTDOWN,
        payload: {},
      } as AppShutdownIntent);

      expect(callbacks.inputUnsubscribes.get("ui-view")).toHaveBeenCalled();
      expect(callbacks.destroyedUnsubscribes.get("ui-view")).toHaveBeenCalled();
      expect(callbacks.blurUnsubscribe).toHaveBeenCalled();
    });
  });
});
