// @vitest-environment node

/**
 * Tests for ShortcutController.
 * Tests the Alt+X shortcut detection state machine.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { WebContents, Event as ElectronEvent, Input, BaseWindow } from "electron";
import { ShortcutController } from "./shortcut-controller";

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
    setDialogMode: vi.fn(),
    focusUI: vi.fn(),
    getUIWebContents: vi.fn(() => mockUIWebContents) as ReturnType<typeof vi.fn> & {
      mockReturnValue: (value: WebContents | null) => void;
    },
    // New setMode API (Step 1.5)
    setMode: vi.fn(),
    getMode: vi.fn(() => "workspace") as ReturnType<typeof vi.fn> & {
      mockReturnValue: (value: "workspace" | "dialog" | "shortcut") => void;
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

describe("ShortcutController", () => {
  let mockWindow: ReturnType<typeof createMockWindow>;
  let mockDeps: ReturnType<typeof createMockDeps>;
  let controller: ShortcutController;

  beforeEach(() => {
    vi.clearAllMocks();
    mockWindow = createMockWindow();
    mockDeps = createMockDeps();
    controller = new ShortcutController(mockWindow, mockDeps as never);
  });

  afterEach(() => {
    controller.dispose();
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

      expect(webContents.on).toHaveBeenCalledTimes(2); // once for each event type
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
    it("controller-normal-to-waiting: Alt keydown transitions to ALT_WAITING and prevents default", () => {
      const webContents = createMockWebContents();
      controller.registerView(webContents);

      const event = createMockElectronEvent();
      const input = createMockElectronInput("Alt", "keyDown");

      // Get the handler and simulate input
      const inputHandler = webContents.on.mock.calls.find(
        (call: unknown[]) => call[0] === "before-input-event"
      )?.[1] as (event: ElectronEvent, input: Input) => void;
      inputHandler(event, input);

      expect(event.preventDefault).toHaveBeenCalled();
    });
  });

  describe("state machine: ALT_WAITING → NORMAL (activate)", () => {
    it("controller-waiting-to-activate: X keydown calls setMode('shortcut') and prevents default", () => {
      const webContents = createMockWebContents();
      controller.registerView(webContents);

      // Get the handler
      const inputHandler = webContents.on.mock.calls.find(
        (call: unknown[]) => call[0] === "before-input-event"
      )?.[1] as (event: ElectronEvent, input: Input) => void;

      // First: Alt down to enter ALT_WAITING
      inputHandler(createMockElectronEvent(), createMockElectronInput("Alt", "keyDown"));

      // Second: X down to activate
      const event = createMockElectronEvent();
      inputHandler(event, createMockElectronInput("x", "keyDown"));

      expect(event.preventDefault).toHaveBeenCalled();
      // Only setMode is called - unified mode system handles z-order and focus
      expect(mockDeps.setMode).toHaveBeenCalledWith("shortcut");
    });
  });

  describe("state machine: ALT_WAITING → NORMAL (non-X key)", () => {
    it("controller-waiting-non-x: Non-X keydown returns to NORMAL without preventing default", () => {
      const webContents = createMockWebContents();
      controller.registerView(webContents);

      const inputHandler = webContents.on.mock.calls.find(
        (call: unknown[]) => call[0] === "before-input-event"
      )?.[1] as (event: ElectronEvent, input: Input) => void;

      // Alt down to enter ALT_WAITING
      inputHandler(createMockElectronEvent(), createMockElectronInput("Alt", "keyDown"));

      // Non-X key (e.g., "j" for Alt+J)
      const event = createMockElectronEvent();
      inputHandler(event, createMockElectronInput("j", "keyDown"));

      // Should NOT prevent default (let the keystroke through to VS Code)
      expect(event.preventDefault).not.toHaveBeenCalled();
      // Should NOT activate shortcut mode
      expect(mockDeps.setDialogMode).not.toHaveBeenCalled();
    });
  });

  describe("Alt keyup suppression", () => {
    it("controller-waiting-alt-up: Alt keyup in ALT_WAITING is suppressed", () => {
      const webContents = createMockWebContents();
      controller.registerView(webContents);

      const inputHandler = webContents.on.mock.calls.find(
        (call: unknown[]) => call[0] === "before-input-event"
      )?.[1] as (event: ElectronEvent, input: Input) => void;

      // Alt down to enter ALT_WAITING
      inputHandler(createMockElectronEvent(), createMockElectronInput("Alt", "keyDown"));

      // Alt up
      const event = createMockElectronEvent();
      inputHandler(event, createMockElectronInput("Alt", "keyUp"));

      expect(event.preventDefault).toHaveBeenCalled();
    });

    it("controller-normal-alt-up: Alt keyup in NORMAL is suppressed", () => {
      const webContents = createMockWebContents();
      controller.registerView(webContents);

      const inputHandler = webContents.on.mock.calls.find(
        (call: unknown[]) => call[0] === "before-input-event"
      )?.[1] as (event: ElectronEvent, input: Input) => void;

      // Alt up without prior Alt down (NORMAL state)
      const event = createMockElectronEvent();
      inputHandler(event, createMockElectronInput("Alt", "keyUp"));

      expect(event.preventDefault).toHaveBeenCalled();
    });
  });

  describe("auto-repeat handling", () => {
    it("controller-ignore-repeat: Auto-repeat events are ignored", () => {
      const webContents = createMockWebContents();
      controller.registerView(webContents);

      const inputHandler = webContents.on.mock.calls.find(
        (call: unknown[]) => call[0] === "before-input-event"
      )?.[1] as (event: ElectronEvent, input: Input) => void;

      // Auto-repeat Alt keydown
      const event = createMockElectronEvent();
      inputHandler(event, createMockElectronInput("Alt", "keyDown", { isAutoRepeat: true }));

      // Should NOT prevent default or change state
      expect(event.preventDefault).not.toHaveBeenCalled();
    });
  });

  describe("window blur handling", () => {
    it("controller-window-blur: Window blur resets ALT_WAITING to NORMAL", () => {
      const webContents = createMockWebContents();
      controller.registerView(webContents);

      const inputHandler = webContents.on.mock.calls.find(
        (call: unknown[]) => call[0] === "before-input-event"
      )?.[1] as (event: ElectronEvent, input: Input) => void;

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
    it("controller-emit-null-webcontents: Alt+X does not throw when UI WebContents is null", () => {
      mockDeps.getUIWebContents.mockReturnValue(null as unknown as WebContents);

      const webContents = createMockWebContents();
      controller.registerView(webContents);

      const inputHandler = webContents.on.mock.calls.find(
        (call: unknown[]) => call[0] === "before-input-event"
      )?.[1] as (event: ElectronEvent, input: Input) => void;

      // Alt down, then X down
      inputHandler(createMockElectronEvent(), createMockElectronInput("Alt", "keyDown"));

      // Should NOT throw when UI WebContents is null
      expect(() => {
        inputHandler(createMockElectronEvent(), createMockElectronInput("x", "keyDown"));
      }).not.toThrow();

      // setMode should still be called (unified mode system)
      expect(mockDeps.setMode).toHaveBeenCalledWith("shortcut");
    });

    it("handles destroyed WebContents gracefully", () => {
      mockDeps.mockUIWebContents.isDestroyed.mockReturnValue(true);

      const webContents = createMockWebContents();
      controller.registerView(webContents);

      const inputHandler = webContents.on.mock.calls.find(
        (call: unknown[]) => call[0] === "before-input-event"
      )?.[1] as (event: ElectronEvent, input: Input) => void;

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
    it("controller-dispose-cleanup: dispose unregisters all views and window blur handler", () => {
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
    it("controller-multiple-views: Alt+X with multiple views calls setMode once", () => {
      const webContents1 = createMockWebContents();
      const webContents2 = createMockWebContents();

      controller.registerView(webContents1);
      controller.registerView(webContents2);

      // Get handler from first view
      const inputHandler = webContents1.on.mock.calls.find(
        (call: unknown[]) => call[0] === "before-input-event"
      )?.[1] as (event: ElectronEvent, input: Input) => void;

      // Alt down, then X down
      inputHandler(createMockElectronEvent(), createMockElectronInput("Alt", "keyDown"));
      inputHandler(createMockElectronEvent(), createMockElectronInput("x", "keyDown"));

      // Should only call setMode once (one controller instance)
      expect(mockDeps.setMode).toHaveBeenCalledTimes(1);
      expect(mockDeps.setMode).toHaveBeenCalledWith("shortcut");
    });
  });

  describe("destroyed WebContents auto-cleanup", () => {
    it("controller-destroyed-webcontents: Destroyed WebContents auto-unregistered", () => {
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

      const inputHandler = webContents.on.mock.calls.find(
        (call: unknown[]) => call[0] === "before-input-event"
      )?.[1] as (event: ElectronEvent, input: Input) => void;

      // Alt down, then uppercase X down
      inputHandler(createMockElectronEvent(), createMockElectronInput("Alt", "keyDown"));
      inputHandler(createMockElectronEvent(), createMockElectronInput("X", "keyDown"));

      expect(mockDeps.setMode).toHaveBeenCalledWith("shortcut");
    });
  });

  describe("setMode integration (Stage 1.5)", () => {
    it("Alt+X when mode is workspace calls setMode('shortcut')", () => {
      const webContents = createMockWebContents();
      controller.registerView(webContents);

      const inputHandler = webContents.on.mock.calls.find(
        (call: unknown[]) => call[0] === "before-input-event"
      )?.[1] as (event: ElectronEvent, input: Input) => void;

      // Ensure mode starts as workspace
      mockDeps.getMode.mockReturnValue("workspace");

      // Alt down, then X down
      inputHandler(createMockElectronEvent(), createMockElectronInput("Alt", "keyDown"));
      inputHandler(createMockElectronEvent(), createMockElectronInput("x", "keyDown"));

      expect(mockDeps.setMode).toHaveBeenCalledWith("shortcut");
    });

    it("Alt+X when mode is dialog is ignored (no mode change)", () => {
      const webContents = createMockWebContents();
      controller.registerView(webContents);

      const inputHandler = webContents.on.mock.calls.find(
        (call: unknown[]) => call[0] === "before-input-event"
      )?.[1] as (event: ElectronEvent, input: Input) => void;

      // Mode is dialog
      mockDeps.getMode.mockReturnValue("dialog");

      // Alt down, then X down
      inputHandler(createMockElectronEvent(), createMockElectronInput("Alt", "keyDown"));
      inputHandler(createMockElectronEvent(), createMockElectronInput("x", "keyDown"));

      expect(mockDeps.setMode).not.toHaveBeenCalled();
    });

    it("Alt release when mode is shortcut calls setMode('workspace')", () => {
      const webContents = createMockWebContents();
      controller.registerView(webContents);

      const inputHandler = webContents.on.mock.calls.find(
        (call: unknown[]) => call[0] === "before-input-event"
      )?.[1] as (event: ElectronEvent, input: Input) => void;

      // Mode is shortcut (already activated)
      mockDeps.getMode.mockReturnValue("shortcut");

      // Alt keyup
      inputHandler(createMockElectronEvent(), createMockElectronInput("Alt", "keyUp"));

      expect(mockDeps.setMode).toHaveBeenCalledWith("workspace");
    });

    it("Alt release when mode is workspace does not call setMode", () => {
      const webContents = createMockWebContents();
      controller.registerView(webContents);

      const inputHandler = webContents.on.mock.calls.find(
        (call: unknown[]) => call[0] === "before-input-event"
      )?.[1] as (event: ElectronEvent, input: Input) => void;

      // Mode is workspace
      mockDeps.getMode.mockReturnValue("workspace");

      // Alt keyup (without prior Alt+X activation)
      inputHandler(createMockElectronEvent(), createMockElectronInput("Alt", "keyUp"));

      expect(mockDeps.setMode).not.toHaveBeenCalled();
    });

    it("Rapid Alt+X press/release handles correctly", () => {
      const webContents = createMockWebContents();
      controller.registerView(webContents);

      const inputHandler = webContents.on.mock.calls.find(
        (call: unknown[]) => call[0] === "before-input-event"
      )?.[1] as (event: ElectronEvent, input: Input) => void;

      // Start in workspace mode
      mockDeps.getMode.mockReturnValue("workspace");

      // Alt down, X down (activates shortcut mode)
      inputHandler(createMockElectronEvent(), createMockElectronInput("Alt", "keyDown"));
      inputHandler(createMockElectronEvent(), createMockElectronInput("x", "keyDown"));

      expect(mockDeps.setMode).toHaveBeenCalledWith("shortcut");
      mockDeps.setMode.mockClear();

      // Now mode should be shortcut (simulate the state change)
      mockDeps.getMode.mockReturnValue("shortcut");

      // Alt release (deactivates shortcut mode)
      inputHandler(createMockElectronEvent(), createMockElectronInput("Alt", "keyUp"));

      expect(mockDeps.setMode).toHaveBeenCalledWith("workspace");
    });
  });

  describe("Alt release race condition handling", () => {
    it("handles race condition: Alt released before focus switches after activation", () => {
      // This test documents the race condition handling:
      // When user releases Alt very quickly after Alt+X, the workspace view
      // (not yet unfocused) catches the Alt keyup. setMode("workspace") ensures
      // the mode is correctly transitioned.

      const webContents = createMockWebContents();
      controller.registerView(webContents);

      const inputHandler = webContents.on.mock.calls.find(
        (call: unknown[]) => call[0] === "before-input-event"
      )?.[1] as (event: ElectronEvent, input: Input) => void;

      // Step 1: Activate shortcut mode with Alt+X
      inputHandler(createMockElectronEvent(), createMockElectronInput("Alt", "keyDown"));
      inputHandler(createMockElectronEvent(), createMockElectronInput("x", "keyDown"));

      // Verify activation happened (unified mode system only calls setMode)
      expect(mockDeps.setMode).toHaveBeenCalledWith("shortcut");

      // Step 2: Alt is released while workspace view still has focus
      // (simulates the race condition - focus hasn't switched yet)
      // Simulate mode state change (setMode was called, mode is now "shortcut")
      mockDeps.getMode.mockReturnValue("shortcut");
      mockDeps.setMode.mockClear();
      inputHandler(createMockElectronEvent(), createMockElectronInput("Alt", "keyUp"));

      // Step 3: setMode("workspace") should be called to exit shortcut mode
      expect(mockDeps.setMode).toHaveBeenCalledWith("workspace");
    });

    it("does not call setMode when Alt is released without prior activation", () => {
      const webContents = createMockWebContents();
      controller.registerView(webContents);

      const inputHandler = webContents.on.mock.calls.find(
        (call: unknown[]) => call[0] === "before-input-event"
      )?.[1] as (event: ElectronEvent, input: Input) => void;

      // Just Alt down then up, without X (no activation)
      inputHandler(createMockElectronEvent(), createMockElectronInput("Alt", "keyDown"));
      inputHandler(createMockElectronEvent(), createMockElectronInput("Alt", "keyUp"));

      // Should NOT call setMode (shortcut mode was never activated)
      expect(mockDeps.setMode).not.toHaveBeenCalled();
    });
  });
});
