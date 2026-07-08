// @vitest-environment node
/**
 * Integration tests for ShortcutModule.
 *
 * The module owns the Alt+X state machine and the local `shortcutActive` flag,
 * broadcasting entry/exit via the ui:set-shortcut-active intent and forwarding
 * keys (while active) via shortcut:key. When a modal is open (isModalOpen()),
 * Alt+X still activates but in a restricted mode: only the bug-report key ("b")
 * is forwarded and nothing is broadcast (no UI affordances) — so a bug report is
 * reachable over any modal / the startup screens. Escape and window blur exit
 * shortcut mode (blur is suppressed briefly after a navigation switch).
 *
 * IMPORTANT: These tests verify that NO keys are prevented via preventDefault().
 * Electron bug #37336 causes keyUp events to not fire when keyDown was
 * prevented; letting all keys propagate ensures reliable Alt keyUp detection.
 */

import { createMockDispatcher } from "../intents/lib/dispatcher.test-utils";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Dispatcher } from "../intents/lib/dispatcher";
import { createMinimalOperation } from "../intents/lib/operation.test-utils";
import {
  INTENT_APP_START,
  APP_START_OPERATION_ID,
  type AppStartIntent,
} from "../intents/app-start";
import {
  AppShutdownOperation,
  INTENT_APP_SHUTDOWN,
  type AppShutdownIntent,
} from "../intents/app-shutdown";
import { INTENT_SHORTCUT_KEY, ShortcutKeyOperation } from "../intents/shortcut-key";
import {
  INTENT_SET_SHORTCUT_ACTIVE,
  SetShortcutActiveOperation,
} from "../intents/set-shortcut-active";
import { EVENT_WORKSPACE_SWITCHED } from "../intents/switch-workspace";
import { SILENT_LOGGER } from "../boundaries/platform/logging";
import { createShortcutModule, normalizeKey, type ShortcutModuleDeps } from "./shortcut-module";
import type { ViewHandle, WindowHandle } from "../boundaries/shell/types";
import type { KeyboardInput, Unsubscribe } from "../boundaries/shell/view";
import type { KeyboardTarget } from "../boundaries/shell/view-manager-types";
import type { DomainEvent } from "../intents/lib/types";

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

interface MockCallbacks {
  inputCallbacks: Map<string, (input: KeyboardInput, preventDefault: () => void) => void>;
  destroyedCallbacks: Map<string, () => void>;
  inputUnsubscribes: Map<string, ReturnType<typeof vi.fn<() => void>>>;
  destroyedUnsubscribes: Map<string, ReturnType<typeof vi.fn<() => void>>>;
  blurCallback: (() => void) | null;
  blurUnsubscribe: ReturnType<typeof vi.fn<() => void>>;
}

function createMockCallbacks(): MockCallbacks {
  return {
    inputCallbacks: new Map(),
    destroyedCallbacks: new Map(),
    inputUnsubscribes: new Map(),
    destroyedUnsubscribes: new Map(),
    blurCallback: null,
    blurUnsubscribe: vi.fn<() => void>(),
  };
}

function createKeyboardTarget(handle: ViewHandle, callbacks: MockCallbacks): KeyboardTarget {
  return {
    id: handle.id,
    onBeforeInput: vi.fn(
      (callback: (input: KeyboardInput, preventDefault: () => void) => void): Unsubscribe => {
        callbacks.inputCallbacks.set(handle.id, callback);
        const unsub = vi.fn<() => void>();
        callbacks.inputUnsubscribes.set(handle.id, unsub);
        return unsub;
      }
    ),
    onDestroyed: vi.fn((callback: () => void): Unsubscribe => {
      callbacks.destroyedCallbacks.set(handle.id, callback);
      const unsub = vi.fn<() => void>();
      callbacks.destroyedUnsubscribes.set(handle.id, unsub);
      return unsub;
    }),
  };
}

function createMockViewManager(uiHandle: ViewHandle, callbacks: MockCallbacks) {
  const uiTarget = createKeyboardTarget(uiHandle, callbacks);
  return {
    getUIKeyboardTarget: vi.fn(() => uiTarget),
    _uiTarget: uiTarget,
  };
}

function createMockWindowBoundary(callbacks: MockCallbacks) {
  return {
    onBlur: vi.fn((_handle: WindowHandle, callback: () => void): Unsubscribe => {
      callbacks.blurCallback = callback;
      return callbacks.blurUnsubscribe;
    }),
  };
}

/** Simulate keyboard input on a registered view. */
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
  module: ReturnType<typeof createShortcutModule>;
  dispatcher: Dispatcher;
  uiHandle: ViewHandle;
  dispatchSpy: ReturnType<typeof vi.fn>;
  setModalOpen: (open: boolean) => void;
  /** Drive the module's workspace:switched event handler (records nav switch). */
  emitSwitched: () => Promise<void>;
}

async function createHarness(
  modalOpen = false,
  platform: NodeJS.Platform = "linux"
): Promise<TestHarness> {
  const dispatcher = createMockDispatcher();
  const uiHandle = createViewHandle("ui-view");
  const callbacks = createMockCallbacks();
  const viewManager = createMockViewManager(uiHandle, callbacks);
  const windowLayer = createMockWindowBoundary(callbacks);

  let modalIsOpen = modalOpen;
  const dialogManager = { isModalOpen: vi.fn(() => modalIsOpen) };

  dispatcher.registerOperation(
    createMinimalOperation(APP_START_OPERATION_ID, INTENT_APP_START, "init", {
      hookContext: (ctx) => ({ intent: ctx.intent, capabilities: { "ui-ready": true } }),
    })
  );
  dispatcher.registerOperation(new AppShutdownOperation());
  dispatcher.registerOperation(new ShortcutKeyOperation());
  dispatcher.registerOperation(new SetShortcutActiveOperation());

  const dispatchSpy = vi.fn((intent: { type: string; payload: unknown }) =>
    dispatcher.dispatch(intent)
  );

  const module = createShortcutModule({
    viewManager: viewManager as unknown as ShortcutModuleDeps["viewManager"],
    windowLayer,
    windowManager: { getWindowHandle: () => createWindowHandle() },
    ui: dialogManager as unknown as ShortcutModuleDeps["ui"],
    dispatcher: { dispatch: dispatchSpy } as unknown as ShortcutModuleDeps["dispatcher"],
    platform,
    logger: SILENT_LOGGER,
  });

  dispatcher.registerModule(module);

  await dispatcher.dispatch({ type: INTENT_APP_START, payload: {} } as AppStartIntent);

  const emitSwitched = (): Promise<void> =>
    module.events![EVENT_WORKSPACE_SWITCHED]!.handler({
      type: EVENT_WORKSPACE_SWITCHED,
      payload: null,
    } as DomainEvent);

  return {
    callbacks,
    module,
    dispatcher,
    uiHandle,
    dispatchSpy,
    setModalOpen: (open) => {
      modalIsOpen = open;
    },
    emitSwitched,
  };
}

/** Activate shortcut mode (Alt+X) — leaves shortcutActive true. */
function activate(callbacks: MockCallbacks): void {
  simulateInput(callbacks, "ui-view", createKeyboardInput("Alt", "keyDown"));
  simulateInput(callbacks, "ui-view", createKeyboardInput("x", "keyDown"));
  vi.runAllTimers();
}

function setActiveCalls(dispatchSpy: ReturnType<typeof vi.fn>): Array<{ active: boolean }> {
  return dispatchSpy.mock.calls
    .filter((c: unknown[]) => (c[0] as { type: string }).type === INTENT_SET_SHORTCUT_ACTIVE)
    .map((c: unknown[]) => (c[0] as { payload: { active: boolean } }).payload);
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
      expect(callbacks.inputCallbacks.has("ui-view")).toBe(true);
      expect(callbacks.destroyedCallbacks.has("ui-view")).toBe(true);
    });

    it("does not register the same view twice", async () => {
      const { callbacks } = await createHarness();
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
  });

  describe("Alt+X activation", () => {
    it("activates shortcut mode (dispatches set-shortcut-active true)", async () => {
      const { callbacks, dispatchSpy } = await createHarness();
      activate(callbacks);
      expect(setActiveCalls(dispatchSpy)).toEqual([{ active: true }]);
    });

    it("activates shortcut mode with uppercase X", async () => {
      const { callbacks, dispatchSpy } = await createHarness();
      simulateInput(callbacks, "ui-view", createKeyboardInput("Alt", "keyDown"));
      simulateInput(callbacks, "ui-view", createKeyboardInput("X", "keyDown"));
      vi.runAllTimers();
      expect(setActiveCalls(dispatchSpy)).toEqual([{ active: true }]);
    });

    it("does not broadcast when a modal dialog is open (enters restricted mode)", async () => {
      const { callbacks, dispatchSpy } = await createHarness(true);
      activate(callbacks);
      expect(dispatchSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: INTENT_SET_SHORTCUT_ACTIVE })
      );
    });

    it("does not activate when only Alt is pressed", async () => {
      const { callbacks, dispatchSpy } = await createHarness();
      simulateInput(callbacks, "ui-view", createKeyboardInput("Alt", "keyDown"));
      expect(dispatchSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: INTENT_SET_SHORTCUT_ACTIVE })
      );
    });

    it("does not activate when X is pressed without prior Alt", async () => {
      const { callbacks, dispatchSpy } = await createHarness();
      simulateInput(callbacks, "ui-view", createKeyboardInput("x", "keyDown"));
      expect(dispatchSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: INTENT_SET_SHORTCUT_ACTIVE })
      );
    });

    it("does not activate when non-X key follows Alt", async () => {
      const { callbacks, dispatchSpy } = await createHarness();
      simulateInput(callbacks, "ui-view", createKeyboardInput("Alt", "keyDown"));
      simulateInput(callbacks, "ui-view", createKeyboardInput("j", "keyDown"));
      vi.runAllTimers();
      expect(dispatchSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: INTENT_SET_SHORTCUT_ACTIVE })
      );
    });

    it("Alt+X dispatches set-shortcut-active once", async () => {
      const { callbacks, dispatchSpy } = await createHarness();
      activate(callbacks);
      expect(setActiveCalls(dispatchSpy)).toHaveLength(1);
    });
  });

  describe("exit shortcut mode", () => {
    it("Alt keyUp exits shortcut mode (set-shortcut-active false)", async () => {
      const { callbacks, dispatchSpy } = await createHarness();
      activate(callbacks);
      simulateInput(callbacks, "ui-view", createKeyboardInput("Alt", "keyUp"));
      expect(setActiveCalls(dispatchSpy)).toEqual([{ active: true }, { active: false }]);
    });

    it("Alt keyUp when not active is a no-op", async () => {
      const { callbacks, dispatchSpy } = await createHarness();
      simulateInput(callbacks, "ui-view", createKeyboardInput("Alt", "keyUp"));
      expect(dispatchSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: INTENT_SET_SHORTCUT_ACTIVE })
      );
    });

    it("Escape exits shortcut mode without forwarding a shortcut key", async () => {
      const { callbacks, dispatchSpy } = await createHarness();
      activate(callbacks);
      simulateInput(callbacks, "ui-view", createKeyboardInput("Escape", "keyDown"));
      expect(setActiveCalls(dispatchSpy)).toEqual([{ active: true }, { active: false }]);
      expect(dispatchSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: INTENT_SHORTCUT_KEY })
      );
    });

    it("Escape when not in shortcut mode is ignored", async () => {
      const { callbacks, dispatchSpy } = await createHarness();
      simulateInput(callbacks, "ui-view", createKeyboardInput("Escape", "keyDown"));
      expect(dispatchSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: INTENT_SET_SHORTCUT_ACTIVE })
      );
    });
  });

  describe("no keys are prevented (#37336)", () => {
    it("no keys in the Alt+X to shortcut-key to Alt-release sequence are prevented", async () => {
      const { callbacks } = await createHarness();

      const { preventDefault: altDownPD } = simulateInput(
        callbacks,
        "ui-view",
        createKeyboardInput("Alt", "keyDown")
      );
      expect(altDownPD).not.toHaveBeenCalled();

      const { preventDefault: xDownPD } = simulateInput(
        callbacks,
        "ui-view",
        createKeyboardInput("x", "keyDown")
      );
      expect(xDownPD).not.toHaveBeenCalled();

      vi.runAllTimers();

      const { preventDefault: arrowPD } = simulateInput(
        callbacks,
        "ui-view",
        createKeyboardInput("ArrowUp", "keyDown")
      );
      expect(arrowPD).not.toHaveBeenCalled();

      const { preventDefault: escPD } = simulateInput(
        callbacks,
        "ui-view",
        createKeyboardInput("Escape", "keyDown")
      );
      expect(escPD).not.toHaveBeenCalled();
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
      ["5", "5"],
      ["9", "9"],
    ] as const)("forwards %s as normalized key %s", async (input, expected) => {
      const { callbacks, dispatchSpy } = await createHarness();
      activate(callbacks);
      simulateInput(callbacks, "ui-view", createKeyboardInput(input, "keyDown"));
      expect(dispatchSpy).toHaveBeenCalledWith({
        type: INTENT_SHORTCUT_KEY,
        payload: { key: expected },
      });
    });

    it("does not forward shortcut keys when not in shortcut mode", async () => {
      const { callbacks, dispatchSpy } = await createHarness();
      simulateInput(callbacks, "ui-view", createKeyboardInput("ArrowUp", "keyDown"));
      expect(dispatchSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: INTENT_SHORTCUT_KEY })
      );
    });

    it("forwards normalized key for any non-Escape key in shortcut mode", async () => {
      const { callbacks, dispatchSpy } = await createHarness();
      activate(callbacks);
      simulateInput(callbacks, "ui-view", createKeyboardInput("a", "keyDown"));
      expect(dispatchSpy).toHaveBeenCalledWith({
        type: INTENT_SHORTCUT_KEY,
        payload: { key: "a" },
      });
    });

    it("does not forward on keyUp", async () => {
      const { callbacks, dispatchSpy } = await createHarness();
      activate(callbacks);
      dispatchSpy.mockClear();
      simulateInput(callbacks, "ui-view", createKeyboardInput("ArrowUp", "keyUp"));
      expect(dispatchSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: INTENT_SHORTCUT_KEY })
      );
    });
  });

  describe("restricted mode (modal open)", () => {
    it("forwards the bug-report key 'b' while a modal is open", async () => {
      const { callbacks, dispatchSpy } = await createHarness(true);
      activate(callbacks);
      simulateInput(callbacks, "ui-view", createKeyboardInput("b", "keyDown"));
      expect(dispatchSpy).toHaveBeenCalledWith({
        type: INTENT_SHORTCUT_KEY,
        payload: { key: "b" },
      });
    });

    it("drops non-'b' keys while a modal is open", async () => {
      const { callbacks, dispatchSpy } = await createHarness(true);
      activate(callbacks);
      for (const key of ["ArrowUp", "s", "h", "1"]) {
        simulateInput(callbacks, "ui-view", createKeyboardInput(key, "keyDown"));
      }
      expect(dispatchSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: INTENT_SHORTCUT_KEY })
      );
    });

    it("Escape exits restricted mode without a broadcast or a forwarded key", async () => {
      const { callbacks, dispatchSpy } = await createHarness(true);
      activate(callbacks);
      simulateInput(callbacks, "ui-view", createKeyboardInput("Escape", "keyDown"));
      // Never broadcast on entry → nothing to reverse on exit.
      expect(setActiveCalls(dispatchSpy)).toEqual([]);
      expect(dispatchSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: INTENT_SHORTCUT_KEY })
      );
    });

    it("Alt keyUp exits restricted mode without a broadcast", async () => {
      const { callbacks, dispatchSpy } = await createHarness(true);
      activate(callbacks);
      simulateInput(callbacks, "ui-view", createKeyboardInput("Alt", "keyUp"));
      expect(setActiveCalls(dispatchSpy)).toEqual([]);
    });

    it("a modal opening mid-gesture narrows full mode to 'b' only", async () => {
      const { callbacks, dispatchSpy, setModalOpen } = await createHarness(false);
      activate(callbacks);
      // Full mode broadcast on entry (no modal at activation).
      expect(setActiveCalls(dispatchSpy)).toEqual([{ active: true }]);
      // A modal opens while shortcut mode is still active.
      setModalOpen(true);
      simulateInput(callbacks, "ui-view", createKeyboardInput("ArrowUp", "keyDown"));
      expect(dispatchSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: INTENT_SHORTCUT_KEY, payload: { key: "up" } })
      );
      simulateInput(callbacks, "ui-view", createKeyboardInput("b", "keyDown"));
      expect(dispatchSpy).toHaveBeenCalledWith({
        type: INTENT_SHORTCUT_KEY,
        payload: { key: "b" },
      });
    });
  });

  describe("edge cases", () => {
    it("auto-repeat events are ignored", async () => {
      const { callbacks } = await createHarness();
      const { preventDefault } = simulateInput(
        callbacks,
        "ui-view",
        createKeyboardInput("Alt", "keyDown", { isAutoRepeat: true })
      );
      expect(preventDefault).not.toHaveBeenCalled();
    });

    it("window blur resets pending Alt state", async () => {
      const { callbacks, dispatchSpy } = await createHarness();
      simulateInput(callbacks, "ui-view", createKeyboardInput("Alt", "keyDown"));
      callbacks.blurCallback!();
      simulateInput(callbacks, "ui-view", createKeyboardInput("x", "keyDown"));
      vi.runAllTimers();
      expect(dispatchSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: INTENT_SET_SHORTCUT_ACTIVE })
      );
    });

    it("window blur while active exits shortcut mode", async () => {
      const { callbacks, dispatchSpy } = await createHarness();
      activate(callbacks);
      callbacks.blurCallback!();
      expect(setActiveCalls(dispatchSpy)).toEqual([{ active: true }, { active: false }]);
    });

    it("blur right after a navigation switch does NOT exit shortcut mode", async () => {
      const { callbacks, dispatchSpy, emitSwitched } = await createHarness();
      activate(callbacks);
      // Navigation dispatched a switch; the resulting bounds-change blur must
      // be ignored while the switch is in flight.
      await emitSwitched();
      callbacks.blurCallback!();
      expect(setActiveCalls(dispatchSpy)).toEqual([{ active: true }]);
    });

    it("blur exits once the switch-suppression window elapses", async () => {
      const { callbacks, dispatchSpy, emitSwitched } = await createHarness();
      activate(callbacks);
      await emitSwitched();
      vi.advanceTimersByTime(300);
      callbacks.blurCallback!();
      expect(setActiveCalls(dispatchSpy)).toEqual([{ active: true }, { active: false }]);
    });
  });

  describe("cleanup", () => {
    it("subscribes to window blur on init", async () => {
      const { callbacks } = await createHarness();
      expect(callbacks.blurCallback).not.toBeNull();
    });

    it("dispose unregisters all views and window blur handler on shutdown", async () => {
      const { callbacks, dispatcher } = await createHarness();
      await dispatcher.dispatch({
        type: INTENT_APP_SHUTDOWN,
        payload: {},
      } as AppShutdownIntent);
      expect(callbacks.inputUnsubscribes.get("ui-view")).toHaveBeenCalled();
      expect(callbacks.destroyedUnsubscribes.get("ui-view")).toHaveBeenCalled();
      expect(callbacks.blurUnsubscribe).toHaveBeenCalled();
    });
  });

  describe("Alt+F4 quit", () => {
    const shutdownCount = (dispatchSpy: ReturnType<typeof vi.fn>): number =>
      dispatchSpy.mock.calls.filter(
        (c: unknown[]) => (c[0] as { type: string }).type === INTENT_APP_SHUTDOWN
      ).length;

    it("dispatches app:shutdown on Alt+F4 (linux)", async () => {
      const { callbacks, dispatchSpy } = await createHarness();
      simulateInput(callbacks, "ui-view", createKeyboardInput("F4", "keyDown", { alt: true }));
      expect(shutdownCount(dispatchSpy)).toBe(1);
    });

    it("quits even while shortcut mode is active", async () => {
      const { callbacks, dispatchSpy } = await createHarness();
      activate(callbacks);
      simulateInput(callbacks, "ui-view", createKeyboardInput("F4", "keyDown", { alt: true }));
      expect(shutdownCount(dispatchSpy)).toBe(1);
    });

    it("does not preventDefault the Alt+F4 key (Electron #37336)", async () => {
      const { callbacks } = await createHarness();
      const { preventDefault } = simulateInput(
        callbacks,
        "ui-view",
        createKeyboardInput("F4", "keyDown", { alt: true })
      );
      expect(preventDefault).not.toHaveBeenCalled();
    });

    it("ignores F4 without Alt", async () => {
      const { callbacks, dispatchSpy } = await createHarness();
      simulateInput(callbacks, "ui-view", createKeyboardInput("F4", "keyDown", { alt: false }));
      expect(shutdownCount(dispatchSpy)).toBe(0);
    });

    it("ignores the Alt+F4 keyUp (acts only on keydown)", async () => {
      const { callbacks, dispatchSpy } = await createHarness();
      simulateInput(callbacks, "ui-view", createKeyboardInput("F4", "keyUp", { alt: true }));
      expect(shutdownCount(dispatchSpy)).toBe(0);
    });

    it("ignores auto-repeat Alt+F4 (does not re-dispatch while held)", async () => {
      const { callbacks, dispatchSpy } = await createHarness();
      simulateInput(
        callbacks,
        "ui-view",
        createKeyboardInput("F4", "keyDown", { alt: true, isAutoRepeat: true })
      );
      expect(shutdownCount(dispatchSpy)).toBe(0);
    });

    it.each(["darwin", "win32"] as const)("does not quit on Alt+F4 on %s", async (platform) => {
      const { callbacks, dispatchSpy } = await createHarness(false, platform);
      simulateInput(callbacks, "ui-view", createKeyboardInput("F4", "keyDown", { alt: true }));
      expect(shutdownCount(dispatchSpy)).toBe(0);
    });
  });
});
