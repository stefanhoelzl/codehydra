// @vitest-environment node

/**
 * Integration test for ShortcutController.
 * Tests the full path from input event through to mode changes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { UIMode } from "../shared/ipc";
import { ShortcutController } from "./shortcut-controller";
import type { ShortcutControllerDeps } from "./shortcut-controller";
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
 */
interface MockCallbacks {
  inputCallbacks: Map<string, (input: KeyboardInput, preventDefault: () => void) => void>;
  destroyedCallbacks: Map<string, () => void>;
  blurCallback: (() => void) | null;
}

/**
 * Creates mock dependencies for ShortcutController with setMode API.
 * Supports all UIMode values: workspace, shortcut, dialog, hover
 */
function createMockDeps(initialMode: UIMode = "workspace"): {
  deps: ShortcutControllerDeps;
  callbacks: MockCallbacks;
  mocks: {
    focusUI: ReturnType<typeof vi.fn<() => void>>;
    setMode: ReturnType<typeof vi.fn<(mode: UIMode) => void>>;
    getMode: ReturnType<typeof vi.fn<() => UIMode>>;
  };
} {
  let currentMode: UIMode = initialMode;

  const callbacks: MockCallbacks = {
    inputCallbacks: new Map(),
    destroyedCallbacks: new Map(),
    blurCallback: null,
  };

  const mocks = {
    focusUI: vi.fn<() => void>(),
    setMode: vi.fn<(mode: UIMode) => void>().mockImplementation((mode: UIMode) => {
      currentMode = mode;
    }),
    getMode: vi.fn<() => UIMode>().mockImplementation(() => currentMode),
  };

  const deps: ShortcutControllerDeps = {
    focusUI: mocks.focusUI,
    setMode: mocks.setMode,
    getMode: mocks.getMode,
    viewLayer: {
      onBeforeInputEvent(
        handle: ViewHandle,
        callback: (input: KeyboardInput, preventDefault: () => void) => void
      ): Unsubscribe {
        callbacks.inputCallbacks.set(handle.id, callback);
        return vi.fn();
      },
      onDestroyed(handle: ViewHandle, callback: () => void): Unsubscribe {
        callbacks.destroyedCallbacks.set(handle.id, callback);
        return vi.fn();
      },
    },
    windowLayer: {
      onBlur(_handle: WindowHandle, callback: () => void): Unsubscribe {
        callbacks.blurCallback = callback;
        return vi.fn();
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

  describe("hover-mode-ipc-flow", () => {
    it("Alt+X activates shortcut mode when mode is 'hover'", () => {
      // Create a fresh controller with initial mode as "hover"
      // This simulates the state after renderer sends "hover" mode via IPC
      const hoverResult = createMockDeps("hover");
      const hoverController = new ShortcutController(hoverResult.deps);

      try {
        // 1. Register a workspace view
        const handle = createViewHandle("ws-view");
        hoverController.registerView(handle);

        // 2. Verify input callback was captured
        expect(hoverResult.callbacks.inputCallbacks.has("ws-view")).toBe(true);

        // 3. Simulate Alt+X keyboard sequence
        simulateInput(hoverResult.callbacks, "ws-view", createKeyboardInput("Alt", "keyDown"));
        simulateInput(hoverResult.callbacks, "ws-view", createKeyboardInput("x", "keyDown"));

        // 4. setMode is deferred, flush timers
        vi.runAllTimers();

        // 5. Verify Alt+X is ALLOWED in hover mode - setMode("shortcut") should be called
        expect(hoverResult.mocks.setMode).toHaveBeenCalledTimes(1);
        expect(hoverResult.mocks.setMode).toHaveBeenCalledWith("shortcut");
      } finally {
        hoverController.dispose();
      }
    });

    it("Alt+X is blocked when mode is 'dialog'", () => {
      // Create a fresh controller with initial mode as "dialog"
      // This simulates the state when a dialog is open
      const dialogResult = createMockDeps("dialog");
      const dialogController = new ShortcutController(dialogResult.deps);

      try {
        // 1. Register a workspace view
        const handle = createViewHandle("ws-view");
        dialogController.registerView(handle);

        // 2. Verify input callback was captured
        expect(dialogResult.callbacks.inputCallbacks.has("ws-view")).toBe(true);

        // 3. Simulate Alt+X keyboard sequence
        simulateInput(dialogResult.callbacks, "ws-view", createKeyboardInput("Alt", "keyDown"));
        simulateInput(dialogResult.callbacks, "ws-view", createKeyboardInput("x", "keyDown"));

        // 4. Flush timers
        vi.runAllTimers();

        // 5. Verify Alt+X is BLOCKED in dialog mode - setMode should NOT be called
        expect(dialogResult.mocks.setMode).not.toHaveBeenCalled();
      } finally {
        dialogController.dispose();
      }
    });

    it("transitions from hover to shortcut mode correctly", () => {
      // This test verifies the full flow:
      // 1. Renderer sends "hover" mode via IPC (simulated by initial mode)
      // 2. User presses Alt+X
      // 3. Mode changes from "hover" to "shortcut"

      const hoverResult = createMockDeps("hover");
      const hoverController = new ShortcutController(hoverResult.deps);

      try {
        const handle = createViewHandle("ws-view");
        hoverController.registerView(handle);

        // Verify initial mode is "hover"
        expect(hoverResult.mocks.getMode()).toBe("hover");

        // Trigger Alt+X
        simulateInput(hoverResult.callbacks, "ws-view", createKeyboardInput("Alt", "keyDown"));
        simulateInput(hoverResult.callbacks, "ws-view", createKeyboardInput("x", "keyDown"));
        vi.runAllTimers();

        // Verify transition to "shortcut" mode
        expect(hoverResult.mocks.setMode).toHaveBeenCalledWith("shortcut");
        // After setMode, the mock updates currentMode, so getMode returns "shortcut"
        expect(hoverResult.mocks.getMode()).toBe("shortcut");
      } finally {
        hoverController.dispose();
      }
    });
  });

  describe("keyboard-wiring-roundtrip", () => {
    it("Alt+X triggers setMode('shortcut')", () => {
      // 1. Create and register a view handle (simulating workspace view)
      const handle = createViewHandle("ws-view");
      controller.registerView(handle);

      // 2. Verify input callback was captured
      expect(mockResult.callbacks.inputCallbacks.has("ws-view")).toBe(true);

      // 3. Simulate Alt keydown
      const { preventDefault: altPD } = simulateInput(
        mockResult.callbacks,
        "ws-view",
        createKeyboardInput("Alt", "keyDown")
      );

      // NOTE: Alt keydown is NOT prevented - this allows Chromium to track the key
      // so that keyUp fires when Alt is released. See regression test in unit tests.
      expect(altPD).not.toHaveBeenCalled();

      // 4. Simulate X keydown
      const { preventDefault: xPD } = simulateInput(
        mockResult.callbacks,
        "ws-view",
        createKeyboardInput("x", "keyDown")
      );

      // 5. Verify the full chain was executed:
      // - X keydown is NOT prevented (Electron bug #37336 workaround)
      // If X is prevented, releasing X before Alt breaks keyUp for ALL keys
      expect(xPD).not.toHaveBeenCalled();

      // - setMode is deferred via setImmediate, flush timers
      vi.runAllTimers();

      // - setMode("shortcut") was called (unified API handles z-order and focus)
      expect(mockResult.mocks.setMode).toHaveBeenCalledTimes(1);
      expect(mockResult.mocks.setMode).toHaveBeenCalledWith("shortcut");

      // - focusUI is no longer called directly (setMode handles it internally)
      expect(mockResult.mocks.focusUI).not.toHaveBeenCalled();
    });

    it("verifies setMode is the only call (no legacy callbacks)", () => {
      const handle = createViewHandle("ws-view");
      controller.registerView(handle);

      // Track execution order
      const executionOrder: string[] = [];
      mockResult.mocks.setMode.mockImplementation(() => {
        executionOrder.push("setMode");
      });
      mockResult.mocks.focusUI.mockImplementation(() => {
        executionOrder.push("focusUI");
      });

      // Trigger Alt+X
      simulateInput(mockResult.callbacks, "ws-view", createKeyboardInput("Alt", "keyDown"));
      simulateInput(mockResult.callbacks, "ws-view", createKeyboardInput("x", "keyDown"));

      // setMode is deferred via setImmediate, flush timers
      vi.runAllTimers();

      // Verify only setMode is called (unified API handles everything)
      expect(executionOrder).toEqual(["setMode"]);
    });

    it("does not trigger chain when only Alt is pressed (no X follow-up)", () => {
      const handle = createViewHandle("ws-view");
      controller.registerView(handle);

      // Only press Alt
      simulateInput(mockResult.callbacks, "ws-view", createKeyboardInput("Alt", "keyDown"));

      // Verify nothing in the chain was called
      expect(mockResult.mocks.setMode).not.toHaveBeenCalled();
      expect(mockResult.mocks.focusUI).not.toHaveBeenCalled();
    });

    it("does not trigger chain when X is pressed without prior Alt", () => {
      const handle = createViewHandle("ws-view");
      controller.registerView(handle);

      // Only press X (no prior Alt)
      simulateInput(mockResult.callbacks, "ws-view", createKeyboardInput("x", "keyDown"));

      // Verify nothing in the chain was called
      expect(mockResult.mocks.setMode).not.toHaveBeenCalled();
      expect(mockResult.mocks.focusUI).not.toHaveBeenCalled();
    });
  });
});
