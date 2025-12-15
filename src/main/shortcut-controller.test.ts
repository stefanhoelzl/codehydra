// @vitest-environment node

/**
 * Tests for ShortcutController.
 * Tests the Alt+X shortcut detection state machine.
 *
 * IMPORTANT: These tests verify that NO keys are prevented via event.preventDefault().
 * This is intentional - Electron bug #37336 causes keyUp events to not fire when
 * keyDown was prevented. By letting all keys propagate, we ensure reliable Alt
 * keyUp detection for exiting shortcut mode.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { WebContents, Event as ElectronEvent, Input, BaseWindow } from "electron";
import { ShortcutController } from "./shortcut-controller";
import type { ShortcutKey } from "../shared/shortcuts";

/**
 * Creates a mock Electron Input object for testing.
 */
function createMockElectronInput(
  key: string,
  type: "keyDown" | "keyUp" = "keyDown",
  options: { alt?: boolean; isAutoRepeat?: boolean } = {}
): Input {
  return {
    type,
    key,
    code: `Key${key.toUpperCase()}`,
    alt: options.alt ?? false,
    control: false,
    shift: false,
    meta: false,
    isAutoRepeat: options.isAutoRepeat ?? false,
    isComposing: false,
    location: 0,
    modifiers: [],
  };
}

/**
 * Creates a mock Electron event with preventDefault spy.
 */
function createMockElectronEvent(): ElectronEvent & { preventDefault: ReturnType<typeof vi.fn> } {
  return {
    preventDefault: vi.fn(),
  } as unknown as ElectronEvent & { preventDefault: ReturnType<typeof vi.fn> };
}

/**
 * Creates a mock WebContents for testing.
 */
function createMockWebContents(): WebContents & {
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  isDestroyed: ReturnType<typeof vi.fn>;
} {
  return {
    on: vi.fn().mockReturnThis(),
    off: vi.fn(),
    send: vi.fn(),
    isDestroyed: vi.fn(() => false),
  } as unknown as WebContents & {
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    isDestroyed: ReturnType<typeof vi.fn>;
  };
}

/**
 * Creates mock dependencies for ShortcutController.
 */
function createMockDeps() {
  const mockUIWebContents = createMockWebContents();
  return {
    focusUI: vi.fn(),
    getUIWebContents: vi.fn(() => mockUIWebContents) as ReturnType<typeof vi.fn> & {
      mockReturnValue: (value: WebContents | null) => void;
    },
    setMode: vi.fn(),
    getMode: vi.fn(() => "workspace") as ReturnType<typeof vi.fn> & {
      mockReturnValue: (value: "workspace" | "dialog" | "shortcut") => void;
    },
    // Shortcut key callback
    onShortcut: vi.fn() as ReturnType<typeof vi.fn> & {
      mockClear: () => void;
    },
    mockUIWebContents,
  };
}

/**
 * Creates a mock BaseWindow for testing.
 */
function createMockWindow(): BaseWindow & {
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
} {
  return {
    on: vi.fn().mockReturnThis(),
    off: vi.fn(),
  } as unknown as BaseWindow & {
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
  };
}

/**
 * Helper to get the before-input-event handler for a registered view.
 */
function getInputHandler(
  webContents: ReturnType<typeof createMockWebContents>
): (event: ElectronEvent, input: Input) => void {
  return webContents.on.mock.calls.find(
    (call: unknown[]) => call[0] === "before-input-event"
  )?.[1] as (event: ElectronEvent, input: Input) => void;
}

describe("ShortcutController", () => {
  let mockWindow: ReturnType<typeof createMockWindow>;
  let mockDeps: ReturnType<typeof createMockDeps>;
  let controller: ShortcutController;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockWindow = createMockWindow();
    mockDeps = createMockDeps();
    controller = new ShortcutController(mockWindow, mockDeps as never);
  });

  afterEach(() => {
    controller.dispose();
    vi.useRealTimers();
  });

  describe("constructor", () => {
    it("subscribes to window blur event", () => {
      expect(mockWindow.on).toHaveBeenCalledWith("blur", expect.any(Function));
    });
  });

  describe("registerView", () => {
    it("subscribes to before-input-event and destroyed events", () => {
      const webContents = createMockWebContents();

      controller.registerView(webContents);

      expect(webContents.on).toHaveBeenCalledWith("before-input-event", expect.any(Function));
      expect(webContents.on).toHaveBeenCalledWith("destroyed", expect.any(Function));
    });

    it("does not register the same view twice", () => {
      const webContents = createMockWebContents();

      controller.registerView(webContents);
      controller.registerView(webContents);

      // 2 event types: before-input-event, destroyed
      expect(webContents.on).toHaveBeenCalledTimes(2);
    });
  });

  describe("unregisterView", () => {
    it("removes event listeners from view", () => {
      const webContents = createMockWebContents();

      controller.registerView(webContents);
      controller.unregisterView(webContents);

      expect(webContents.off).toHaveBeenCalledWith("before-input-event", expect.any(Function));
      expect(webContents.off).toHaveBeenCalledWith("destroyed", expect.any(Function));
    });

    it("does not throw when unregistering non-registered view", () => {
      const webContents = createMockWebContents();

      expect(() => controller.unregisterView(webContents)).not.toThrow();
    });
  });

  describe("state machine: NORMAL → ALT_WAITING", () => {
    it("Alt keydown transitions to ALT_WAITING without preventing default", () => {
      // NOTE: We do NOT prevent any keys - Electron bug #37336 causes keyUp
      // to not fire when keyDown was prevented.
      const webContents = createMockWebContents();
      controller.registerView(webContents);

      const event = createMockElectronEvent();
      const inputHandler = getInputHandler(webContents);
      inputHandler(event, createMockElectronInput("Alt", "keyDown"));

      // Alt keyDown should NOT be prevented
      expect(event.preventDefault).not.toHaveBeenCalled();
    });
  });

  describe("state machine: ALT_WAITING → NORMAL (activate)", () => {
    it("X keydown calls setMode('shortcut') without preventing default", () => {
      const webContents = createMockWebContents();
      controller.registerView(webContents);

      const inputHandler = getInputHandler(webContents);

      // First: Alt down to enter ALT_WAITING
      inputHandler(createMockElectronEvent(), createMockElectronInput("Alt", "keyDown"));

      // Second: X down to activate
      const event = createMockElectronEvent();
      inputHandler(event, createMockElectronInput("x", "keyDown"));

      // NOTE: X keyDown is NOT prevented - see Electron bug #37336
      expect(event.preventDefault).not.toHaveBeenCalled();
      // setMode is deferred via setImmediate, flush timers to execute it
      vi.runAllTimers();
      expect(mockDeps.setMode).toHaveBeenCalledWith("shortcut");
    });
  });

  describe("state machine: ALT_WAITING → NORMAL (non-X key)", () => {
    it("Non-X keydown returns to NORMAL without preventing default", () => {
      const webContents = createMockWebContents();
      controller.registerView(webContents);

      const inputHandler = getInputHandler(webContents);

      // Alt down to enter ALT_WAITING
      inputHandler(createMockElectronEvent(), createMockElectronInput("Alt", "keyDown"));

      // Non-X key (e.g., "j" for Alt+J)
      const event = createMockElectronEvent();
      inputHandler(event, createMockElectronInput("j", "keyDown"));

      // Should NOT prevent default (let the keystroke through to VS Code)
      expect(event.preventDefault).not.toHaveBeenCalled();
      // Should NOT activate shortcut mode
      expect(mockDeps.setMode).not.toHaveBeenCalled();
    });
  });

  describe("Alt keyUp handling", () => {
    it("Alt keyUp in shortcut mode calls setMode('workspace')", () => {
      const webContents = createMockWebContents();
      controller.registerView(webContents);

      const inputHandler = getInputHandler(webContents);

      // Mode is shortcut (already activated)
      mockDeps.getMode.mockReturnValue("shortcut");

      // Alt keyUp
      const event = createMockElectronEvent();
      inputHandler(event, createMockElectronInput("Alt", "keyUp"));

      expect(mockDeps.setMode).toHaveBeenCalledWith("workspace");
      // Should NOT prevent default
      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it("Alt keyUp in workspace mode does not call setMode", () => {
      const webContents = createMockWebContents();
      controller.registerView(webContents);

      const inputHandler = getInputHandler(webContents);

      // Mode is workspace
      mockDeps.getMode.mockReturnValue("workspace");

      // Alt keyUp
      const event = createMockElectronEvent();
      inputHandler(event, createMockElectronInput("Alt", "keyUp"));

      expect(mockDeps.setMode).not.toHaveBeenCalled();
      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it("Alt keyUp in ALT_WAITING does NOT prevent default", () => {
      const webContents = createMockWebContents();
      controller.registerView(webContents);

      const inputHandler = getInputHandler(webContents);

      // Alt down to enter ALT_WAITING
      inputHandler(createMockElectronEvent(), createMockElectronInput("Alt", "keyDown"));

      // Alt up
      const event = createMockElectronEvent();
      inputHandler(event, createMockElectronInput("Alt", "keyUp"));

      // Should NOT prevent default
      expect(event.preventDefault).not.toHaveBeenCalled();
    });
  });

  describe("auto-repeat handling", () => {
    it("Auto-repeat events are ignored", () => {
      const webContents = createMockWebContents();
      controller.registerView(webContents);

      const inputHandler = getInputHandler(webContents);

      // Auto-repeat Alt keydown
      const event = createMockElectronEvent();
      inputHandler(event, createMockElectronInput("Alt", "keyDown", { isAutoRepeat: true }));

      // Should NOT change state (not logged, no effect)
      expect(event.preventDefault).not.toHaveBeenCalled();
    });
  });

  describe("window blur handling", () => {
    it("Window blur resets ALT_WAITING to NORMAL", () => {
      const webContents = createMockWebContents();
      controller.registerView(webContents);

      const inputHandler = getInputHandler(webContents);

      // Alt down to enter ALT_WAITING
      inputHandler(createMockElectronEvent(), createMockElectronInput("Alt", "keyDown"));

      // Simulate window blur
      const blurHandler = mockWindow.on.mock.calls.find(
        (call: unknown[]) => call[0] === "blur"
      )?.[1] as () => void;
      blurHandler();

      // X down should NOT activate (state was reset to NORMAL)
      const event = createMockElectronEvent();
      inputHandler(event, createMockElectronInput("x", "keyDown"));

      expect(mockDeps.setMode).not.toHaveBeenCalled();
    });
  });

  describe("null WebContents handling", () => {
    it("Alt+X does not throw when UI WebContents is null", () => {
      mockDeps.getUIWebContents.mockReturnValue(null as unknown as WebContents);

      const webContents = createMockWebContents();
      controller.registerView(webContents);

      const inputHandler = getInputHandler(webContents);

      // Alt down, then X down
      inputHandler(createMockElectronEvent(), createMockElectronInput("Alt", "keyDown"));

      // Should NOT throw when UI WebContents is null
      expect(() => {
        inputHandler(createMockElectronEvent(), createMockElectronInput("x", "keyDown"));
      }).not.toThrow();

      // setMode is deferred via setImmediate, flush timers to execute it
      vi.runAllTimers();
      expect(mockDeps.setMode).toHaveBeenCalledWith("shortcut");
    });

    it("handles destroyed WebContents gracefully", () => {
      mockDeps.mockUIWebContents.isDestroyed.mockReturnValue(true);

      const webContents = createMockWebContents();
      controller.registerView(webContents);

      const inputHandler = getInputHandler(webContents);

      // Alt down, then X down
      inputHandler(createMockElectronEvent(), createMockElectronInput("Alt", "keyDown"));

      // Should NOT throw when UI WebContents is destroyed
      expect(() => {
        inputHandler(createMockElectronEvent(), createMockElectronInput("x", "keyDown"));
      }).not.toThrow();

      // send should NOT be called on destroyed webContents
      expect(mockDeps.mockUIWebContents.send).not.toHaveBeenCalled();
    });
  });

  describe("dispose cleanup", () => {
    it("dispose unregisters all views and window blur handler", () => {
      const webContents1 = createMockWebContents();
      const webContents2 = createMockWebContents();

      controller.registerView(webContents1);
      controller.registerView(webContents2);

      controller.dispose();

      expect(webContents1.off).toHaveBeenCalledWith("before-input-event", expect.any(Function));
      expect(webContents1.off).toHaveBeenCalledWith("destroyed", expect.any(Function));
      expect(webContents2.off).toHaveBeenCalledWith("before-input-event", expect.any(Function));
      expect(webContents2.off).toHaveBeenCalledWith("destroyed", expect.any(Function));
      expect(mockWindow.off).toHaveBeenCalledWith("blur", expect.any(Function));
    });
  });

  describe("multiple views", () => {
    it("Alt+X with multiple views calls setMode once", () => {
      const webContents1 = createMockWebContents();
      const webContents2 = createMockWebContents();

      controller.registerView(webContents1);
      controller.registerView(webContents2);

      const inputHandler = getInputHandler(webContents1);

      // Alt down, then X down
      inputHandler(createMockElectronEvent(), createMockElectronInput("Alt", "keyDown"));
      inputHandler(createMockElectronEvent(), createMockElectronInput("x", "keyDown"));

      // setMode is deferred via setImmediate, flush timers to execute it
      vi.runAllTimers();
      // Should only call setMode once (one controller instance)
      expect(mockDeps.setMode).toHaveBeenCalledTimes(1);
      expect(mockDeps.setMode).toHaveBeenCalledWith("shortcut");
    });
  });

  describe("destroyed WebContents auto-cleanup", () => {
    it("Destroyed WebContents auto-unregistered", () => {
      const webContents = createMockWebContents();

      controller.registerView(webContents);

      // Get the destroyed handler
      const destroyedHandler = webContents.on.mock.calls.find(
        (call: unknown[]) => call[0] === "destroyed"
      )?.[1] as () => void;

      // Simulate destruction
      destroyedHandler();

      // Should have called off to unregister
      expect(webContents.off).toHaveBeenCalled();
    });
  });

  describe("case-insensitive X key", () => {
    it("handles uppercase X", () => {
      const webContents = createMockWebContents();
      controller.registerView(webContents);

      const inputHandler = getInputHandler(webContents);

      // Alt down, then uppercase X down
      inputHandler(createMockElectronEvent(), createMockElectronInput("Alt", "keyDown"));
      inputHandler(createMockElectronEvent(), createMockElectronInput("X", "keyDown"));

      // setMode is deferred via setImmediate, flush timers to execute it
      vi.runAllTimers();
      expect(mockDeps.setMode).toHaveBeenCalledWith("shortcut");
    });
  });

  describe("setMode integration", () => {
    it("Alt+X when mode is workspace calls setMode('shortcut')", () => {
      const webContents = createMockWebContents();
      controller.registerView(webContents);

      const inputHandler = getInputHandler(webContents);

      // Ensure mode starts as workspace
      mockDeps.getMode.mockReturnValue("workspace");

      // Alt down, then X down
      inputHandler(createMockElectronEvent(), createMockElectronInput("Alt", "keyDown"));
      inputHandler(createMockElectronEvent(), createMockElectronInput("x", "keyDown"));

      // setMode is deferred via setImmediate, flush timers to execute it
      vi.runAllTimers();
      expect(mockDeps.setMode).toHaveBeenCalledWith("shortcut");
    });

    it("Alt+X when mode is dialog is ignored (no mode change)", () => {
      const webContents = createMockWebContents();
      controller.registerView(webContents);

      const inputHandler = getInputHandler(webContents);

      // Mode is dialog
      mockDeps.getMode.mockReturnValue("dialog");

      // Alt down, then X down
      inputHandler(createMockElectronEvent(), createMockElectronInput("Alt", "keyDown"));
      inputHandler(createMockElectronEvent(), createMockElectronInput("x", "keyDown"));

      expect(mockDeps.setMode).not.toHaveBeenCalled();
    });

    it("Rapid Alt+X press/release handles correctly", () => {
      const webContents = createMockWebContents();
      controller.registerView(webContents);

      const inputHandler = getInputHandler(webContents);

      // Start in workspace mode
      mockDeps.getMode.mockReturnValue("workspace");

      // Alt down, X down (activates shortcut mode)
      inputHandler(createMockElectronEvent(), createMockElectronInput("Alt", "keyDown"));
      inputHandler(createMockElectronEvent(), createMockElectronInput("x", "keyDown"));

      // setMode is deferred via setImmediate, flush timers to execute it
      vi.runAllTimers();
      expect(mockDeps.setMode).toHaveBeenCalledWith("shortcut");
      mockDeps.setMode.mockClear();

      // Now mode should be shortcut (simulate the state change)
      mockDeps.getMode.mockReturnValue("shortcut");

      // Alt release (deactivates shortcut mode)
      inputHandler(createMockElectronEvent(), createMockElectronInput("Alt", "keyUp"));

      expect(mockDeps.setMode).toHaveBeenCalledWith("workspace");
    });
  });

  describe("Alt keyUp after Alt+X activation", () => {
    it("Alt keyUp exits shortcut mode after Alt+X activation", () => {
      const webContents = createMockWebContents();
      controller.registerView(webContents);

      const inputHandler = getInputHandler(webContents);

      // Step 1: Alt keyDown - should NOT be prevented
      const altDownEvent = createMockElectronEvent();
      inputHandler(altDownEvent, createMockElectronInput("Alt", "keyDown"));
      expect(altDownEvent.preventDefault).not.toHaveBeenCalled();

      // Step 2: X keyDown - also NOT prevented (Electron bug #37336 workaround)
      const xDownEvent = createMockElectronEvent();
      inputHandler(xDownEvent, createMockElectronInput("x", "keyDown"));
      expect(xDownEvent.preventDefault).not.toHaveBeenCalled();

      // Flush deferred setMode call
      vi.runAllTimers();
      expect(mockDeps.setMode).toHaveBeenCalledWith("shortcut");

      // Step 3: Simulate mode change
      mockDeps.getMode.mockReturnValue("shortcut");
      mockDeps.setMode.mockClear();

      // Step 4: Alt keyUp fires - exits shortcut mode
      const altUpEvent = createMockElectronEvent();
      inputHandler(altUpEvent, createMockElectronInput("Alt", "keyUp"));

      // Step 5: Verify shortcut mode exits
      expect(mockDeps.setMode).toHaveBeenCalledWith("workspace");
      expect(altUpEvent.preventDefault).not.toHaveBeenCalled();
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
        ["o", "o"],
        ["O", "o"],
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
        const webContents = createMockWebContents();
        controller.registerView(webContents);
        const inputHandler = getInputHandler(webContents);

        // Mode must be shortcut for action keys to be captured
        mockDeps.getMode.mockReturnValue("shortcut");

        const event = createMockElectronEvent();
        inputHandler(event, createMockElectronInput(input, "keyDown"));

        expect(mockDeps.onShortcut).toHaveBeenCalledWith(expected);
        // NOTE: Even shortcut keys are NOT prevented - Electron bug #37336
        expect(event.preventDefault).not.toHaveBeenCalled();
      });
    });

    describe("shortcut key in wrong mode", () => {
      it("ignores shortcut key when mode is workspace", () => {
        const webContents = createMockWebContents();
        controller.registerView(webContents);
        const inputHandler = getInputHandler(webContents);

        // Mode is workspace
        mockDeps.getMode.mockReturnValue("workspace");

        const event = createMockElectronEvent();
        inputHandler(event, createMockElectronInput("ArrowUp", "keyDown"));

        expect(mockDeps.onShortcut).not.toHaveBeenCalled();
        expect(event.preventDefault).not.toHaveBeenCalled();
      });

      it("ignores shortcut key when mode is dialog", () => {
        const webContents = createMockWebContents();
        controller.registerView(webContents);
        const inputHandler = getInputHandler(webContents);

        // Mode is dialog
        mockDeps.getMode.mockReturnValue("dialog");

        const event = createMockElectronEvent();
        inputHandler(event, createMockElectronInput("Enter", "keyDown"));

        expect(mockDeps.onShortcut).not.toHaveBeenCalled();
        expect(event.preventDefault).not.toHaveBeenCalled();
      });
    });

    describe("unknown key handling", () => {
      it("does not emit for unknown key in shortcut mode", () => {
        const webContents = createMockWebContents();
        controller.registerView(webContents);
        const inputHandler = getInputHandler(webContents);

        // Mode is shortcut
        mockDeps.getMode.mockReturnValue("shortcut");

        const event = createMockElectronEvent();
        // 'a' is not a shortcut key
        inputHandler(event, createMockElectronInput("a", "keyDown"));

        expect(mockDeps.onShortcut).not.toHaveBeenCalled();
        expect(event.preventDefault).not.toHaveBeenCalled();
      });

      it("Escape is not handled (handled by renderer)", () => {
        const webContents = createMockWebContents();
        controller.registerView(webContents);
        const inputHandler = getInputHandler(webContents);

        // Mode is shortcut
        mockDeps.getMode.mockReturnValue("shortcut");

        const event = createMockElectronEvent();
        inputHandler(event, createMockElectronInput("Escape", "keyDown"));

        // Escape should NOT be captured by main process
        expect(mockDeps.onShortcut).not.toHaveBeenCalled();
        expect(event.preventDefault).not.toHaveBeenCalled();
      });
    });

    describe("keyUp handling for shortcut keys", () => {
      it("does not emit on keyUp (only keyDown triggers actions)", () => {
        const webContents = createMockWebContents();
        controller.registerView(webContents);
        const inputHandler = getInputHandler(webContents);

        // Mode is shortcut
        mockDeps.getMode.mockReturnValue("shortcut");

        const event = createMockElectronEvent();
        inputHandler(event, createMockElectronInput("ArrowUp", "keyUp"));

        expect(mockDeps.onShortcut).not.toHaveBeenCalled();
      });
    });
  });
});
