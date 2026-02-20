// @vitest-environment node

/**
 * Tests for ShortcutController.
 * Tests the Alt+X shortcut detection state machine.
 *
 * IMPORTANT: These tests verify that NO keys are prevented via preventDefault().
 * This is intentional - Electron bug #37336 causes keyUp events to not fire when
 * keyDown was prevented. By letting all keys propagate, we ensure reliable Alt
 * keyUp detection for exiting shortcut mode.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { UIMode } from "../shared/ipc";
import { ShortcutController } from "./shortcut-controller";
import type { ShortcutControllerDeps } from "./shortcut-controller";
import type { ShortcutKey } from "../shared/shortcuts";
import type { KeyboardInput, Unsubscribe } from "../services/shell/view";
import type { ViewHandle } from "../services/shell/types";
import type { WindowHandle } from "../services/shell/types";

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
 * Tracks captured callbacks for viewLayer and windowLayer mocks.
 * Allows simulating input events and view destruction in tests.
 */
interface MockCallbacks {
  /** Map of view handle ID -> captured onBeforeInputEvent callback */
  inputCallbacks: Map<string, (input: KeyboardInput, preventDefault: () => void) => void>;
  /** Map of view handle ID -> captured onDestroyed callback */
  destroyedCallbacks: Map<string, () => void>;
  /** Map of view handle ID -> unsubscribe spy for onBeforeInputEvent */
  inputUnsubscribes: Map<string, ReturnType<typeof vi.fn<() => void>>>;
  /** Map of view handle ID -> unsubscribe spy for onDestroyed */
  destroyedUnsubscribes: Map<string, ReturnType<typeof vi.fn<() => void>>>;
  /** Captured onBlur callback */
  blurCallback: (() => void) | null;
  /** Unsubscribe spy for onBlur */
  blurUnsubscribe: ReturnType<typeof vi.fn<() => void>>;
}

/**
 * Creates mock dependencies for ShortcutController using the new ViewHandle-based API.
 */
function createMockDeps(): {
  deps: ShortcutControllerDeps;
  callbacks: MockCallbacks;
  mocks: {
    focusUI: ReturnType<typeof vi.fn>;
    setMode: ReturnType<typeof vi.fn<(mode: UIMode) => void>>;
    getMode: ReturnType<typeof vi.fn<() => UIMode>>;
    onShortcut: ReturnType<typeof vi.fn>;
  };
} {
  const callbacks: MockCallbacks = {
    inputCallbacks: new Map(),
    destroyedCallbacks: new Map(),
    inputUnsubscribes: new Map(),
    destroyedUnsubscribes: new Map(),
    blurCallback: null,
    blurUnsubscribe: vi.fn<() => void>(),
  };

  const mocks = {
    focusUI: vi.fn(),
    setMode: vi.fn<(mode: UIMode) => void>(),
    getMode: vi.fn<() => UIMode>().mockReturnValue("workspace"),
    onShortcut: vi.fn(),
  };

  const deps: ShortcutControllerDeps = {
    focusUI: mocks.focusUI,
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

describe("ShortcutController", () => {
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

  describe("constructor", () => {
    it("subscribes to window blur event", () => {
      expect(mockResult.callbacks.blurCallback).not.toBeNull();
    });
  });

  describe("registerView", () => {
    it("subscribes to before-input-event and destroyed events", () => {
      const handle = createViewHandle("view-1");

      controller.registerView(handle);

      expect(mockResult.callbacks.inputCallbacks.has("view-1")).toBe(true);
      expect(mockResult.callbacks.destroyedCallbacks.has("view-1")).toBe(true);
    });

    it("does not register the same view twice", () => {
      const handle = createViewHandle("view-1");

      // Spy on viewLayer to count calls
      const onBeforeInputSpy = vi.spyOn(mockResult.deps.viewLayer, "onBeforeInputEvent");
      const onDestroyedSpy = vi.spyOn(mockResult.deps.viewLayer, "onDestroyed");

      controller.registerView(handle);
      controller.registerView(handle);

      // Should only register once (2 event types total, not 4)
      expect(onBeforeInputSpy).toHaveBeenCalledTimes(1);
      expect(onDestroyedSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("unregisterView", () => {
    it("calls unsubscribe functions for the view", () => {
      const handle = createViewHandle("view-1");

      controller.registerView(handle);
      controller.unregisterView(handle);

      expect(mockResult.callbacks.inputUnsubscribes.get("view-1")).toHaveBeenCalled();
      expect(mockResult.callbacks.destroyedUnsubscribes.get("view-1")).toHaveBeenCalled();
    });

    it("does not throw when unregistering non-registered view", () => {
      const handle = createViewHandle("view-1");

      expect(() => controller.unregisterView(handle)).not.toThrow();
    });
  });

  describe("state machine: NORMAL -> ALT_WAITING", () => {
    it("Alt keydown transitions to ALT_WAITING without preventing default", () => {
      // NOTE: We do NOT prevent any keys - Electron bug #37336 causes keyUp
      // to not fire when keyDown was prevented.
      const handle = createViewHandle("view-1");
      controller.registerView(handle);

      const { preventDefault } = simulateInput(
        mockResult.callbacks,
        "view-1",
        createKeyboardInput("Alt", "keyDown")
      );

      // Alt keyDown should NOT be prevented
      expect(preventDefault).not.toHaveBeenCalled();
    });
  });

  describe("state machine: ALT_WAITING -> NORMAL (activate)", () => {
    it("X keydown calls setMode('shortcut') without preventing default", () => {
      const handle = createViewHandle("view-1");
      controller.registerView(handle);

      // First: Alt down to enter ALT_WAITING
      simulateInput(mockResult.callbacks, "view-1", createKeyboardInput("Alt", "keyDown"));

      // Second: X down to activate
      const { preventDefault } = simulateInput(
        mockResult.callbacks,
        "view-1",
        createKeyboardInput("x", "keyDown")
      );

      // NOTE: X keyDown is NOT prevented - see Electron bug #37336
      expect(preventDefault).not.toHaveBeenCalled();
      // setMode is deferred via setImmediate, flush timers to execute it
      vi.runAllTimers();
      expect(mockResult.mocks.setMode).toHaveBeenCalledWith("shortcut");
    });
  });

  describe("state machine: ALT_WAITING -> NORMAL (non-X key)", () => {
    it("Non-X keydown returns to NORMAL without preventing default", () => {
      const handle = createViewHandle("view-1");
      controller.registerView(handle);

      // Alt down to enter ALT_WAITING
      simulateInput(mockResult.callbacks, "view-1", createKeyboardInput("Alt", "keyDown"));

      // Non-X key (e.g., "j" for Alt+J)
      const { preventDefault } = simulateInput(
        mockResult.callbacks,
        "view-1",
        createKeyboardInput("j", "keyDown")
      );

      // Should NOT prevent default (let the keystroke through to VS Code)
      expect(preventDefault).not.toHaveBeenCalled();
      // Should NOT activate shortcut mode
      expect(mockResult.mocks.setMode).not.toHaveBeenCalled();
    });
  });

  describe("Alt keyUp handling", () => {
    it("Alt keyUp in shortcut mode calls setMode('workspace')", () => {
      const handle = createViewHandle("view-1");
      controller.registerView(handle);

      // Mode is shortcut (already activated)
      mockResult.mocks.getMode.mockReturnValue("shortcut");

      // Alt keyUp
      const { preventDefault } = simulateInput(
        mockResult.callbacks,
        "view-1",
        createKeyboardInput("Alt", "keyUp")
      );

      expect(mockResult.mocks.setMode).toHaveBeenCalledWith("workspace");
      // Should NOT prevent default
      expect(preventDefault).not.toHaveBeenCalled();
    });

    it("Alt keyUp in workspace mode does not call setMode", () => {
      const handle = createViewHandle("view-1");
      controller.registerView(handle);

      // Mode is workspace
      mockResult.mocks.getMode.mockReturnValue("workspace");

      // Alt keyUp
      const { preventDefault } = simulateInput(
        mockResult.callbacks,
        "view-1",
        createKeyboardInput("Alt", "keyUp")
      );

      expect(mockResult.mocks.setMode).not.toHaveBeenCalled();
      expect(preventDefault).not.toHaveBeenCalled();
    });

    it("Alt keyUp in ALT_WAITING does NOT prevent default", () => {
      const handle = createViewHandle("view-1");
      controller.registerView(handle);

      // Alt down to enter ALT_WAITING
      simulateInput(mockResult.callbacks, "view-1", createKeyboardInput("Alt", "keyDown"));

      // Alt up
      const { preventDefault } = simulateInput(
        mockResult.callbacks,
        "view-1",
        createKeyboardInput("Alt", "keyUp")
      );

      // Should NOT prevent default
      expect(preventDefault).not.toHaveBeenCalled();
    });
  });

  describe("auto-repeat handling", () => {
    it("Auto-repeat events are ignored", () => {
      const handle = createViewHandle("view-1");
      controller.registerView(handle);

      // Auto-repeat Alt keydown
      const { preventDefault } = simulateInput(
        mockResult.callbacks,
        "view-1",
        createKeyboardInput("Alt", "keyDown", { isAutoRepeat: true })
      );

      // Should NOT change state (not logged, no effect)
      expect(preventDefault).not.toHaveBeenCalled();
    });
  });

  describe("window blur handling", () => {
    it("Window blur resets ALT_WAITING to NORMAL", () => {
      const handle = createViewHandle("view-1");
      controller.registerView(handle);

      // Alt down to enter ALT_WAITING
      simulateInput(mockResult.callbacks, "view-1", createKeyboardInput("Alt", "keyDown"));

      // Simulate window blur
      mockResult.callbacks.blurCallback!();

      // X down should NOT activate (state was reset to NORMAL)
      const { preventDefault } = simulateInput(
        mockResult.callbacks,
        "view-1",
        createKeyboardInput("x", "keyDown")
      );

      expect(mockResult.mocks.setMode).not.toHaveBeenCalled();
      expect(preventDefault).not.toHaveBeenCalled();
    });
  });

  describe("dispose cleanup", () => {
    it("dispose unregisters all views and window blur handler", () => {
      const handle1 = createViewHandle("view-1");
      const handle2 = createViewHandle("view-2");

      controller.registerView(handle1);
      controller.registerView(handle2);

      controller.dispose();

      // View 1 unsubscribes
      expect(mockResult.callbacks.inputUnsubscribes.get("view-1")).toHaveBeenCalled();
      expect(mockResult.callbacks.destroyedUnsubscribes.get("view-1")).toHaveBeenCalled();
      // View 2 unsubscribes
      expect(mockResult.callbacks.inputUnsubscribes.get("view-2")).toHaveBeenCalled();
      expect(mockResult.callbacks.destroyedUnsubscribes.get("view-2")).toHaveBeenCalled();
      // Window blur unsubscribe
      expect(mockResult.callbacks.blurUnsubscribe).toHaveBeenCalled();
    });
  });

  describe("multiple views", () => {
    it("Alt+X with multiple views calls setMode once", () => {
      const handle1 = createViewHandle("view-1");
      const handle2 = createViewHandle("view-2");

      controller.registerView(handle1);
      controller.registerView(handle2);

      // Alt down, then X down on view-1
      simulateInput(mockResult.callbacks, "view-1", createKeyboardInput("Alt", "keyDown"));
      simulateInput(mockResult.callbacks, "view-1", createKeyboardInput("x", "keyDown"));

      // setMode is deferred via setImmediate, flush timers to execute it
      vi.runAllTimers();
      // Should only call setMode once (one controller instance)
      expect(mockResult.mocks.setMode).toHaveBeenCalledTimes(1);
      expect(mockResult.mocks.setMode).toHaveBeenCalledWith("shortcut");
    });
  });

  describe("destroyed ViewHandle auto-cleanup", () => {
    it("Destroyed ViewHandle auto-unregistered", () => {
      const handle = createViewHandle("view-1");

      controller.registerView(handle);

      // Simulate destruction via the captured onDestroyed callback
      const destroyedCallback = mockResult.callbacks.destroyedCallbacks.get("view-1");
      expect(destroyedCallback).toBeDefined();
      destroyedCallback!();

      // Should have called unsubscribe functions
      expect(mockResult.callbacks.inputUnsubscribes.get("view-1")).toHaveBeenCalled();
      expect(mockResult.callbacks.destroyedUnsubscribes.get("view-1")).toHaveBeenCalled();
    });
  });

  describe("case-insensitive X key", () => {
    it("handles uppercase X", () => {
      const handle = createViewHandle("view-1");
      controller.registerView(handle);

      // Alt down, then uppercase X down
      simulateInput(mockResult.callbacks, "view-1", createKeyboardInput("Alt", "keyDown"));
      simulateInput(mockResult.callbacks, "view-1", createKeyboardInput("X", "keyDown"));

      // setMode is deferred via setImmediate, flush timers to execute it
      vi.runAllTimers();
      expect(mockResult.mocks.setMode).toHaveBeenCalledWith("shortcut");
    });
  });

  describe("setMode integration", () => {
    it("Alt+X when mode is workspace calls setMode('shortcut')", () => {
      const handle = createViewHandle("view-1");
      controller.registerView(handle);

      // Ensure mode starts as workspace
      mockResult.mocks.getMode.mockReturnValue("workspace");

      // Alt down, then X down
      simulateInput(mockResult.callbacks, "view-1", createKeyboardInput("Alt", "keyDown"));
      simulateInput(mockResult.callbacks, "view-1", createKeyboardInput("x", "keyDown"));

      // setMode is deferred via setImmediate, flush timers to execute it
      vi.runAllTimers();
      expect(mockResult.mocks.setMode).toHaveBeenCalledWith("shortcut");
    });

    it("Alt+X when mode is dialog is ignored (no mode change)", () => {
      const handle = createViewHandle("view-1");
      controller.registerView(handle);

      // Mode is dialog
      mockResult.mocks.getMode.mockReturnValue("dialog");

      // Alt down, then X down
      simulateInput(mockResult.callbacks, "view-1", createKeyboardInput("Alt", "keyDown"));
      simulateInput(mockResult.callbacks, "view-1", createKeyboardInput("x", "keyDown"));

      expect(mockResult.mocks.setMode).not.toHaveBeenCalled();
    });

    it("Alt+X when mode is hover calls setMode('shortcut')", () => {
      const handle = createViewHandle("view-1");
      controller.registerView(handle);

      // Mode is hover (sidebar expanded on hover)
      mockResult.mocks.getMode.mockReturnValue("hover");

      // Alt down, then X down
      simulateInput(mockResult.callbacks, "view-1", createKeyboardInput("Alt", "keyDown"));
      simulateInput(mockResult.callbacks, "view-1", createKeyboardInput("x", "keyDown"));

      // setMode is deferred via setImmediate, flush timers to execute it
      vi.runAllTimers();
      expect(mockResult.mocks.setMode).toHaveBeenCalledWith("shortcut");
    });

    it("Rapid Alt+X press/release handles correctly", () => {
      const handle = createViewHandle("view-1");
      controller.registerView(handle);

      // Start in workspace mode
      mockResult.mocks.getMode.mockReturnValue("workspace");

      // Alt down, X down (activates shortcut mode)
      simulateInput(mockResult.callbacks, "view-1", createKeyboardInput("Alt", "keyDown"));
      simulateInput(mockResult.callbacks, "view-1", createKeyboardInput("x", "keyDown"));

      // setMode is deferred via setImmediate, flush timers to execute it
      vi.runAllTimers();
      expect(mockResult.mocks.setMode).toHaveBeenCalledWith("shortcut");
      mockResult.mocks.setMode.mockClear();

      // Now mode should be shortcut (simulate the state change)
      mockResult.mocks.getMode.mockReturnValue("shortcut");

      // Alt release (deactivates shortcut mode)
      simulateInput(mockResult.callbacks, "view-1", createKeyboardInput("Alt", "keyUp"));

      expect(mockResult.mocks.setMode).toHaveBeenCalledWith("workspace");
    });
  });

  describe("Alt keyUp after Alt+X activation", () => {
    it("Alt keyUp exits shortcut mode after Alt+X activation", () => {
      const handle = createViewHandle("view-1");
      controller.registerView(handle);

      // Step 1: Alt keyDown - should NOT be prevented
      const { preventDefault: altDownPD } = simulateInput(
        mockResult.callbacks,
        "view-1",
        createKeyboardInput("Alt", "keyDown")
      );
      expect(altDownPD).not.toHaveBeenCalled();

      // Step 2: X keyDown - also NOT prevented (Electron bug #37336 workaround)
      const { preventDefault: xDownPD } = simulateInput(
        mockResult.callbacks,
        "view-1",
        createKeyboardInput("x", "keyDown")
      );
      expect(xDownPD).not.toHaveBeenCalled();

      // Flush deferred setMode call
      vi.runAllTimers();
      expect(mockResult.mocks.setMode).toHaveBeenCalledWith("shortcut");

      // Step 3: Simulate mode change
      mockResult.mocks.getMode.mockReturnValue("shortcut");
      mockResult.mocks.setMode.mockClear();

      // Step 4: Alt keyUp fires - exits shortcut mode
      const { preventDefault: altUpPD } = simulateInput(
        mockResult.callbacks,
        "view-1",
        createKeyboardInput("Alt", "keyUp")
      );

      // Step 5: Verify shortcut mode exits
      expect(mockResult.mocks.setMode).toHaveBeenCalledWith("workspace");
      expect(altUpPD).not.toHaveBeenCalled();
    });
  });

  // ============ Shortcut Key Event Emission ============

  describe("shortcut key event emission", () => {
    describe("key normalization", () => {
      it.each([
        ["ArrowUp", "up"],
        ["ArrowDown", "down"],
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
        const handle = createViewHandle("view-1");
        controller.registerView(handle);

        // Mode must be shortcut for action keys to be captured
        mockResult.mocks.getMode.mockReturnValue("shortcut");

        const { preventDefault } = simulateInput(
          mockResult.callbacks,
          "view-1",
          createKeyboardInput(input, "keyDown")
        );

        expect(mockResult.mocks.onShortcut).toHaveBeenCalledWith(expected);
        // NOTE: Even shortcut keys are NOT prevented - Electron bug #37336
        expect(preventDefault).not.toHaveBeenCalled();
      });
    });

    describe("shortcut key in wrong mode", () => {
      it("ignores shortcut key when mode is workspace", () => {
        const handle = createViewHandle("view-1");
        controller.registerView(handle);

        // Mode is workspace
        mockResult.mocks.getMode.mockReturnValue("workspace");

        const { preventDefault } = simulateInput(
          mockResult.callbacks,
          "view-1",
          createKeyboardInput("ArrowUp", "keyDown")
        );

        expect(mockResult.mocks.onShortcut).not.toHaveBeenCalled();
        expect(preventDefault).not.toHaveBeenCalled();
      });

      it("ignores shortcut key when mode is dialog", () => {
        const handle = createViewHandle("view-1");
        controller.registerView(handle);

        // Mode is dialog
        mockResult.mocks.getMode.mockReturnValue("dialog");

        const { preventDefault } = simulateInput(
          mockResult.callbacks,
          "view-1",
          createKeyboardInput("Enter", "keyDown")
        );

        expect(mockResult.mocks.onShortcut).not.toHaveBeenCalled();
        expect(preventDefault).not.toHaveBeenCalled();
      });
    });

    describe("unknown key handling", () => {
      it("does not emit for unknown key in shortcut mode", () => {
        const handle = createViewHandle("view-1");
        controller.registerView(handle);

        // Mode is shortcut
        mockResult.mocks.getMode.mockReturnValue("shortcut");

        const { preventDefault } = simulateInput(
          mockResult.callbacks,
          "view-1",
          // 'a' is not a shortcut key
          createKeyboardInput("a", "keyDown")
        );

        expect(mockResult.mocks.onShortcut).not.toHaveBeenCalled();
        expect(preventDefault).not.toHaveBeenCalled();
      });

      it("Escape is not handled (handled by renderer)", () => {
        const handle = createViewHandle("view-1");
        controller.registerView(handle);

        // Mode is shortcut
        mockResult.mocks.getMode.mockReturnValue("shortcut");

        const { preventDefault } = simulateInput(
          mockResult.callbacks,
          "view-1",
          createKeyboardInput("Escape", "keyDown")
        );

        // Escape should NOT be captured by main process
        expect(mockResult.mocks.onShortcut).not.toHaveBeenCalled();
        expect(preventDefault).not.toHaveBeenCalled();
      });
    });

    describe("keyUp handling for shortcut keys", () => {
      it("does not emit on keyUp (only keyDown triggers actions)", () => {
        const handle = createViewHandle("view-1");
        controller.registerView(handle);

        // Mode is shortcut
        mockResult.mocks.getMode.mockReturnValue("shortcut");

        simulateInput(mockResult.callbacks, "view-1", createKeyboardInput("ArrowUp", "keyUp"));

        expect(mockResult.mocks.onShortcut).not.toHaveBeenCalled();
      });
    });
  });
});
