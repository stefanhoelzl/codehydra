// @vitest-environment node

/**
 * Integration tests for ShortcutController.
 * Tests the full path from input event through to mode changes and shortcut key emission.
 *
 * IMPORTANT: These tests verify that NO keys are prevented via preventDefault().
 * This is intentional - Electron bug #37336 causes keyUp events to not fire when
 * keyDown was prevented. By letting all keys propagate, we ensure reliable Alt
 * keyUp detection for exiting shortcut mode.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { UIMode } from "../shared/ipc";
import type { ShortcutKey } from "../shared/shortcuts";
import { ShortcutController } from "./shortcut-controller";
import type { ShortcutControllerDeps } from "./shortcut-controller";
import type { KeyboardInput, Unsubscribe } from "../services/shell/view";
import type { ViewHandle, WindowHandle } from "../services/shell/types";

/**
 * Creates a KeyboardInput object for testing.
 */
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
 * Creates a ViewHandle for testing.
 */
function createViewHandle(id: string = "view-1"): ViewHandle {
  return { id, __brand: "ViewHandle" as const };
}

/**
 * Creates a WindowHandle for testing.
 */
function createWindowHandle(id: string = "window-1"): WindowHandle {
  return { id, __brand: "WindowHandle" as const };
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

/**
 * Creates mock dependencies for ShortcutController with bidirectional mode state.
 * setMode updates currentMode so getMode reflects the change (like the real system).
 */
function createMockDeps(initialMode: UIMode = "workspace"): {
  deps: ShortcutControllerDeps;
  callbacks: MockCallbacks;
  mocks: {
    setMode: ReturnType<typeof vi.fn<(mode: UIMode) => void>>;
    getMode: ReturnType<typeof vi.fn<() => UIMode>>;
    onShortcut: ReturnType<typeof vi.fn<(key: ShortcutKey) => void>>;
  };
} {
  let currentMode: UIMode = initialMode;

  const callbacks: MockCallbacks = {
    inputCallbacks: new Map(),
    destroyedCallbacks: new Map(),
    inputUnsubscribes: new Map(),
    destroyedUnsubscribes: new Map(),
    blurCallback: null,
    blurUnsubscribe: vi.fn<() => void>(),
  };

  const mocks = {
    setMode: vi.fn<(mode: UIMode) => void>().mockImplementation((mode: UIMode) => {
      currentMode = mode;
    }),
    getMode: vi.fn<() => UIMode>().mockImplementation(() => currentMode),
    onShortcut: vi.fn<(key: ShortcutKey) => void>(),
  };

  const deps: ShortcutControllerDeps = {
    setMode: mocks.setMode,
    getMode: mocks.getMode,
    onShortcut: mocks.onShortcut,
    viewLayer: {
      onBeforeInputEvent(
        handle: ViewHandle,
        callback: (input: KeyboardInput, preventDefault: () => void) => void
      ): Unsubscribe {
        callbacks.inputCallbacks.set(handle.id, callback);
        const unsub = vi.fn<() => void>();
        callbacks.inputUnsubscribes.set(handle.id, unsub);
        return unsub;
      },
      onDestroyed(handle: ViewHandle, callback: () => void): Unsubscribe {
        callbacks.destroyedCallbacks.set(handle.id, callback);
        const unsub = vi.fn<() => void>();
        callbacks.destroyedUnsubscribes.set(handle.id, unsub);
        return unsub;
      },
    },
    windowLayer: {
      onBlur(_handle: WindowHandle, callback: () => void): Unsubscribe {
        callbacks.blurCallback = callback;
        return callbacks.blurUnsubscribe;
      },
    },
    windowHandle: createWindowHandle(),
  };

  return { deps, callbacks, mocks };
}

/**
 * Helper to simulate keyboard input on a registered view.
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

describe("ShortcutController Integration", () => {
  let mockResult: ReturnType<typeof createMockDeps>;
  let controller: ShortcutController;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockResult = createMockDeps();
    controller = new ShortcutController(mockResult.deps);
  });

  afterEach(() => {
    controller.dispose();
    vi.useRealTimers();
  });

  describe("view registration", () => {
    it("subscribes to input and destroyed events on register", () => {
      const handle = createViewHandle("view-1");
      controller.registerView(handle);

      expect(mockResult.callbacks.inputCallbacks.has("view-1")).toBe(true);
      expect(mockResult.callbacks.destroyedCallbacks.has("view-1")).toBe(true);
    });

    it("does not register the same view twice", () => {
      const handle = createViewHandle("view-1");
      const onBeforeInputSpy = vi.spyOn(mockResult.deps.viewLayer, "onBeforeInputEvent");
      const onDestroyedSpy = vi.spyOn(mockResult.deps.viewLayer, "onDestroyed");

      controller.registerView(handle);
      controller.registerView(handle);

      expect(onBeforeInputSpy).toHaveBeenCalledTimes(1);
      expect(onDestroyedSpy).toHaveBeenCalledTimes(1);
    });

    it("does not throw when unregistering non-registered view", () => {
      const handle = createViewHandle("view-1");
      expect(() => controller.unregisterView(handle)).not.toThrow();
    });

    it("calls unsubscribe functions on unregister", () => {
      const handle = createViewHandle("view-1");
      controller.registerView(handle);
      controller.unregisterView(handle);

      expect(mockResult.callbacks.inputUnsubscribes.get("view-1")).toHaveBeenCalled();
      expect(mockResult.callbacks.destroyedUnsubscribes.get("view-1")).toHaveBeenCalled();
    });

    it("auto-unregisters when view is destroyed", () => {
      const handle = createViewHandle("view-1");
      controller.registerView(handle);

      const destroyedCallback = mockResult.callbacks.destroyedCallbacks.get("view-1");
      expect(destroyedCallback).toBeDefined();
      destroyedCallback!();

      expect(mockResult.callbacks.inputUnsubscribes.get("view-1")).toHaveBeenCalled();
      expect(mockResult.callbacks.destroyedUnsubscribes.get("view-1")).toHaveBeenCalled();
    });
  });

  describe("Alt+X activation", () => {
    it("activates shortcut mode from workspace mode", () => {
      const handle = createViewHandle("ws-view");
      controller.registerView(handle);

      simulateInput(mockResult.callbacks, "ws-view", createKeyboardInput("Alt", "keyDown"));
      simulateInput(mockResult.callbacks, "ws-view", createKeyboardInput("x", "keyDown"));
      vi.runAllTimers();

      expect(mockResult.mocks.getMode()).toBe("shortcut");
    });

    it("activates shortcut mode from hover mode", () => {
      const hoverResult = createMockDeps("hover");
      const hoverController = new ShortcutController(hoverResult.deps);

      try {
        const handle = createViewHandle("ws-view");
        hoverController.registerView(handle);

        simulateInput(hoverResult.callbacks, "ws-view", createKeyboardInput("Alt", "keyDown"));
        simulateInput(hoverResult.callbacks, "ws-view", createKeyboardInput("x", "keyDown"));
        vi.runAllTimers();

        expect(hoverResult.mocks.getMode()).toBe("shortcut");
      } finally {
        hoverController.dispose();
      }
    });

    it("activates shortcut mode with uppercase X", () => {
      const handle = createViewHandle("view-1");
      controller.registerView(handle);

      simulateInput(mockResult.callbacks, "view-1", createKeyboardInput("Alt", "keyDown"));
      simulateInput(mockResult.callbacks, "view-1", createKeyboardInput("X", "keyDown"));
      vi.runAllTimers();

      expect(mockResult.mocks.getMode()).toBe("shortcut");
    });

    it("does not activate when mode is dialog", () => {
      const dialogResult = createMockDeps("dialog");
      const dialogController = new ShortcutController(dialogResult.deps);

      try {
        const handle = createViewHandle("ws-view");
        dialogController.registerView(handle);

        simulateInput(dialogResult.callbacks, "ws-view", createKeyboardInput("Alt", "keyDown"));
        simulateInput(dialogResult.callbacks, "ws-view", createKeyboardInput("x", "keyDown"));
        vi.runAllTimers();

        expect(dialogResult.mocks.setMode).not.toHaveBeenCalled();
        expect(dialogResult.mocks.getMode()).toBe("dialog");
      } finally {
        dialogController.dispose();
      }
    });

    it("does not activate when only Alt is pressed", () => {
      const handle = createViewHandle("ws-view");
      controller.registerView(handle);

      simulateInput(mockResult.callbacks, "ws-view", createKeyboardInput("Alt", "keyDown"));

      expect(mockResult.mocks.setMode).not.toHaveBeenCalled();
    });

    it("does not activate when X is pressed without prior Alt", () => {
      const handle = createViewHandle("ws-view");
      controller.registerView(handle);

      simulateInput(mockResult.callbacks, "ws-view", createKeyboardInput("x", "keyDown"));

      expect(mockResult.mocks.setMode).not.toHaveBeenCalled();
    });

    it("does not activate when non-X key follows Alt", () => {
      const handle = createViewHandle("view-1");
      controller.registerView(handle);

      simulateInput(mockResult.callbacks, "view-1", createKeyboardInput("Alt", "keyDown"));
      simulateInput(mockResult.callbacks, "view-1", createKeyboardInput("j", "keyDown"));

      vi.runAllTimers();
      expect(mockResult.mocks.setMode).not.toHaveBeenCalled();
    });

    it("Alt+X with multiple views calls setMode once", () => {
      const handle1 = createViewHandle("view-1");
      const handle2 = createViewHandle("view-2");
      controller.registerView(handle1);
      controller.registerView(handle2);

      simulateInput(mockResult.callbacks, "view-1", createKeyboardInput("Alt", "keyDown"));
      simulateInput(mockResult.callbacks, "view-1", createKeyboardInput("x", "keyDown"));
      vi.runAllTimers();

      expect(mockResult.mocks.setMode).toHaveBeenCalledTimes(1);
      expect(mockResult.mocks.setMode).toHaveBeenCalledWith("shortcut");
    });
  });

  describe("Alt release exits shortcut mode", () => {
    it("Alt keyUp exits shortcut mode back to workspace", () => {
      const shortcutResult = createMockDeps("shortcut");
      const shortcutController = new ShortcutController(shortcutResult.deps);

      try {
        const handle = createViewHandle("view-1");
        shortcutController.registerView(handle);

        simulateInput(shortcutResult.callbacks, "view-1", createKeyboardInput("Alt", "keyUp"));

        expect(shortcutResult.mocks.getMode()).toBe("workspace");
      } finally {
        shortcutController.dispose();
      }
    });

    it("Alt keyUp in workspace mode is a no-op", () => {
      const handle = createViewHandle("view-1");
      controller.registerView(handle);

      simulateInput(mockResult.callbacks, "view-1", createKeyboardInput("Alt", "keyUp"));

      expect(mockResult.mocks.setMode).not.toHaveBeenCalled();
    });

    it("full Alt+X activation then Alt release cycle", () => {
      const handle = createViewHandle("view-1");
      controller.registerView(handle);

      // Alt+X activates shortcut mode
      simulateInput(mockResult.callbacks, "view-1", createKeyboardInput("Alt", "keyDown"));
      simulateInput(mockResult.callbacks, "view-1", createKeyboardInput("x", "keyDown"));
      vi.runAllTimers();
      expect(mockResult.mocks.getMode()).toBe("shortcut");

      // Alt release exits shortcut mode
      simulateInput(mockResult.callbacks, "view-1", createKeyboardInput("Alt", "keyUp"));
      expect(mockResult.mocks.getMode()).toBe("workspace");
    });
  });

  describe("no keys are prevented (#37336)", () => {
    it("no keys in the Alt+X to shortcut-key to Alt-release sequence are prevented", () => {
      const handle = createViewHandle("view-1");
      controller.registerView(handle);

      // Alt keyDown
      const { preventDefault: altDownPD } = simulateInput(
        mockResult.callbacks,
        "view-1",
        createKeyboardInput("Alt", "keyDown")
      );
      expect(altDownPD).not.toHaveBeenCalled();

      // X keyDown
      const { preventDefault: xDownPD } = simulateInput(
        mockResult.callbacks,
        "view-1",
        createKeyboardInput("x", "keyDown")
      );
      expect(xDownPD).not.toHaveBeenCalled();

      vi.runAllTimers();

      // ArrowUp keyDown in shortcut mode
      const { preventDefault: arrowPD } = simulateInput(
        mockResult.callbacks,
        "view-1",
        createKeyboardInput("ArrowUp", "keyDown")
      );
      expect(arrowPD).not.toHaveBeenCalled();

      // Alt keyUp
      const { preventDefault: altUpPD } = simulateInput(
        mockResult.callbacks,
        "view-1",
        createKeyboardInput("Alt", "keyUp")
      );
      expect(altUpPD).not.toHaveBeenCalled();
    });
  });

  describe("shortcut key emission", () => {
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
    ] as const)("emits %s as shortcut key %s", (input, expected: ShortcutKey) => {
      const shortcutResult = createMockDeps("shortcut");
      const shortcutController = new ShortcutController(shortcutResult.deps);

      try {
        const handle = createViewHandle("view-1");
        shortcutController.registerView(handle);

        simulateInput(shortcutResult.callbacks, "view-1", createKeyboardInput(input, "keyDown"));

        expect(shortcutResult.mocks.onShortcut).toHaveBeenCalledWith(expected);
      } finally {
        shortcutController.dispose();
      }
    });

    it("ignores shortcut keys in workspace mode", () => {
      const handle = createViewHandle("view-1");
      controller.registerView(handle);

      simulateInput(mockResult.callbacks, "view-1", createKeyboardInput("ArrowUp", "keyDown"));

      expect(mockResult.mocks.onShortcut).not.toHaveBeenCalled();
    });

    it("ignores shortcut keys in dialog mode", () => {
      const dialogResult = createMockDeps("dialog");
      const dialogController = new ShortcutController(dialogResult.deps);

      try {
        const handle = createViewHandle("view-1");
        dialogController.registerView(handle);

        simulateInput(dialogResult.callbacks, "view-1", createKeyboardInput("Enter", "keyDown"));

        expect(dialogResult.mocks.onShortcut).not.toHaveBeenCalled();
      } finally {
        dialogController.dispose();
      }
    });

    it("does not emit for unknown key in shortcut mode", () => {
      const shortcutResult = createMockDeps("shortcut");
      const shortcutController = new ShortcutController(shortcutResult.deps);

      try {
        const handle = createViewHandle("view-1");
        shortcutController.registerView(handle);

        simulateInput(shortcutResult.callbacks, "view-1", createKeyboardInput("a", "keyDown"));

        expect(shortcutResult.mocks.onShortcut).not.toHaveBeenCalled();
      } finally {
        shortcutController.dispose();
      }
    });

    it("Escape is not handled (handled by renderer)", () => {
      const shortcutResult = createMockDeps("shortcut");
      const shortcutController = new ShortcutController(shortcutResult.deps);

      try {
        const handle = createViewHandle("view-1");
        shortcutController.registerView(handle);

        simulateInput(shortcutResult.callbacks, "view-1", createKeyboardInput("Escape", "keyDown"));

        expect(shortcutResult.mocks.onShortcut).not.toHaveBeenCalled();
      } finally {
        shortcutController.dispose();
      }
    });

    it("does not emit on keyUp", () => {
      const shortcutResult = createMockDeps("shortcut");
      const shortcutController = new ShortcutController(shortcutResult.deps);

      try {
        const handle = createViewHandle("view-1");
        shortcutController.registerView(handle);

        simulateInput(shortcutResult.callbacks, "view-1", createKeyboardInput("ArrowUp", "keyUp"));

        expect(shortcutResult.mocks.onShortcut).not.toHaveBeenCalled();
      } finally {
        shortcutController.dispose();
      }
    });
  });

  describe("onRawShortcutKey interception", () => {
    it("is called before normalizeKey in shortcut mode and consumes key when returns true", () => {
      const onRawShortcutKey = vi.fn().mockReturnValue(true);
      const shortcutResult = createMockDeps("shortcut");
      shortcutResult.deps = { ...shortcutResult.deps, onRawShortcutKey };
      const shortcutController = new ShortcutController(shortcutResult.deps);

      try {
        const handle = createViewHandle("view-1");
        shortcutController.registerView(handle);

        simulateInput(shortcutResult.callbacks, "view-1", createKeyboardInput("d", "keyDown"));

        expect(onRawShortcutKey).toHaveBeenCalledWith("d");
        expect(shortcutResult.mocks.onShortcut).not.toHaveBeenCalled();
      } finally {
        shortcutController.dispose();
      }
    });

    it("falls through to normalizeKey/onShortcut when returns false", () => {
      const onRawShortcutKey = vi.fn().mockReturnValue(false);
      const shortcutResult = createMockDeps("shortcut");
      shortcutResult.deps = { ...shortcutResult.deps, onRawShortcutKey };
      const shortcutController = new ShortcutController(shortcutResult.deps);

      try {
        const handle = createViewHandle("view-1");
        shortcutController.registerView(handle);

        simulateInput(
          shortcutResult.callbacks,
          "view-1",
          createKeyboardInput("ArrowUp", "keyDown")
        );

        expect(onRawShortcutKey).toHaveBeenCalledWith("ArrowUp");
        expect(shortcutResult.mocks.onShortcut).toHaveBeenCalledWith("up");
      } finally {
        shortcutController.dispose();
      }
    });

    it("is not called outside shortcut mode", () => {
      const onRawShortcutKey = vi.fn().mockReturnValue(true);
      mockResult.deps = { ...mockResult.deps, onRawShortcutKey };
      const wsController = new ShortcutController(mockResult.deps);

      try {
        const handle = createViewHandle("view-1");
        wsController.registerView(handle);

        simulateInput(mockResult.callbacks, "view-1", createKeyboardInput("d", "keyDown"));

        expect(onRawShortcutKey).not.toHaveBeenCalled();
      } finally {
        wsController.dispose();
      }
    });

    it("is not called on keyUp", () => {
      const onRawShortcutKey = vi.fn().mockReturnValue(true);
      const shortcutResult = createMockDeps("shortcut");
      shortcutResult.deps = { ...shortcutResult.deps, onRawShortcutKey };
      const shortcutController = new ShortcutController(shortcutResult.deps);

      try {
        const handle = createViewHandle("view-1");
        shortcutController.registerView(handle);

        simulateInput(shortcutResult.callbacks, "view-1", createKeyboardInput("d", "keyUp"));

        expect(onRawShortcutKey).not.toHaveBeenCalled();
      } finally {
        shortcutController.dispose();
      }
    });

    it("is not called on auto-repeat", () => {
      const onRawShortcutKey = vi.fn().mockReturnValue(true);
      const shortcutResult = createMockDeps("shortcut");
      shortcutResult.deps = { ...shortcutResult.deps, onRawShortcutKey };
      const shortcutController = new ShortcutController(shortcutResult.deps);

      try {
        const handle = createViewHandle("view-1");
        shortcutController.registerView(handle);

        simulateInput(
          shortcutResult.callbacks,
          "view-1",
          createKeyboardInput("d", "keyDown", { isAutoRepeat: true })
        );

        expect(onRawShortcutKey).not.toHaveBeenCalled();
      } finally {
        shortcutController.dispose();
      }
    });

    it("normal behavior preserved when callback not provided", () => {
      const shortcutResult = createMockDeps("shortcut");
      const shortcutController = new ShortcutController(shortcutResult.deps);

      try {
        const handle = createViewHandle("view-1");
        shortcutController.registerView(handle);

        // "d" is not a recognized shortcut key, should be ignored
        simulateInput(shortcutResult.callbacks, "view-1", createKeyboardInput("d", "keyDown"));
        expect(shortcutResult.mocks.onShortcut).not.toHaveBeenCalled();

        // ArrowUp IS a recognized shortcut key
        simulateInput(
          shortcutResult.callbacks,
          "view-1",
          createKeyboardInput("ArrowUp", "keyDown")
        );
        expect(shortcutResult.mocks.onShortcut).toHaveBeenCalledWith("up");
      } finally {
        shortcutController.dispose();
      }
    });
  });

  describe("edge cases", () => {
    it("auto-repeat events are ignored", () => {
      const handle = createViewHandle("view-1");
      controller.registerView(handle);

      const { preventDefault } = simulateInput(
        mockResult.callbacks,
        "view-1",
        createKeyboardInput("Alt", "keyDown", { isAutoRepeat: true })
      );

      expect(preventDefault).not.toHaveBeenCalled();
    });

    it("window blur resets pending Alt state", () => {
      const handle = createViewHandle("view-1");
      controller.registerView(handle);

      // Alt down to enter ALT_WAITING
      simulateInput(mockResult.callbacks, "view-1", createKeyboardInput("Alt", "keyDown"));

      // Window blur resets state
      mockResult.callbacks.blurCallback!();

      // X down should NOT activate (state was reset)
      simulateInput(mockResult.callbacks, "view-1", createKeyboardInput("x", "keyDown"));
      vi.runAllTimers();

      expect(mockResult.mocks.setMode).not.toHaveBeenCalled();
    });
  });

  describe("cleanup", () => {
    it("subscribes to window blur on construction", () => {
      expect(mockResult.callbacks.blurCallback).not.toBeNull();
    });

    it("dispose unregisters all views and window blur handler", () => {
      const handle1 = createViewHandle("view-1");
      const handle2 = createViewHandle("view-2");
      controller.registerView(handle1);
      controller.registerView(handle2);

      controller.dispose();

      expect(mockResult.callbacks.inputUnsubscribes.get("view-1")).toHaveBeenCalled();
      expect(mockResult.callbacks.destroyedUnsubscribes.get("view-1")).toHaveBeenCalled();
      expect(mockResult.callbacks.inputUnsubscribes.get("view-2")).toHaveBeenCalled();
      expect(mockResult.callbacks.destroyedUnsubscribes.get("view-2")).toHaveBeenCalled();
      expect(mockResult.callbacks.blurUnsubscribe).toHaveBeenCalled();
    });
  });
});
