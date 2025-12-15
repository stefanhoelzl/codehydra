// @vitest-environment node

/**
 * Integration test for ShortcutController.
 * Tests the full path from input event through to mode changes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { WebContents, Event as ElectronEvent, Input, BaseWindow } from "electron";
import type { UIMode } from "../shared/ipc";
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
 * Creates mock dependencies for ShortcutController with setMode API.
 */
function createMockDeps() {
  const mockUIWebContents = createMockWebContents();
  let currentMode: UIMode = "workspace";
  const deps = {
    focusUI: vi.fn(),
    getUIWebContents: vi.fn(() => mockUIWebContents),
    setMode: vi.fn((mode: UIMode) => {
      currentMode = mode;
    }),
    getMode: vi.fn(() => currentMode),
    mockUIWebContents,
  };
  return deps;
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

describe("ShortcutController Integration", () => {
  let mockWindow: ReturnType<typeof createMockWindow>;
  let mockDeps: ReturnType<typeof createMockDeps>;
  let controller: ShortcutController;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockWindow = createMockWindow();
    mockDeps = createMockDeps();
    controller = new ShortcutController(mockWindow, mockDeps);
  });

  afterEach(() => {
    controller.dispose();
    vi.useRealTimers();
  });

  describe("keyboard-wiring-roundtrip", () => {
    it("Alt+X triggers setMode('shortcut')", () => {
      // 1. Create and register a mock WebContents view (simulating workspace view)
      const workspaceWebContents = createMockWebContents();
      controller.registerView(workspaceWebContents);

      // 2. Get the before-input-event handler that was registered
      const inputHandler = workspaceWebContents.on.mock.calls.find(
        (call: unknown[]) => call[0] === "before-input-event"
      )?.[1] as (event: ElectronEvent, input: Input) => void;
      expect(inputHandler).toBeDefined();

      // 3. Simulate Alt keydown
      const altEvent = createMockElectronEvent();
      inputHandler(altEvent, createMockElectronInput("Alt", "keyDown"));

      // NOTE: Alt keydown is NOT prevented - this allows Chromium to track the key
      // so that keyUp fires when Alt is released. See regression test in unit tests.
      expect(altEvent.preventDefault).not.toHaveBeenCalled();

      // 4. Simulate X keydown
      const xEvent = createMockElectronEvent();
      inputHandler(xEvent, createMockElectronInput("x", "keyDown"));

      // 5. Verify the full chain was executed:
      // - X keydown is NOT prevented (Electron bug #37336 workaround)
      // If X is prevented, releasing X before Alt breaks keyUp for ALL keys
      expect(xEvent.preventDefault).not.toHaveBeenCalled();

      // - setMode is deferred via setImmediate, flush timers
      vi.runAllTimers();

      // - setMode("shortcut") was called (unified API handles z-order and focus)
      expect(mockDeps.setMode).toHaveBeenCalledTimes(1);
      expect(mockDeps.setMode).toHaveBeenCalledWith("shortcut");

      // - focusUI is no longer called directly (setMode handles it internally)
      expect(mockDeps.focusUI).not.toHaveBeenCalled();
    });

    it("verifies setMode is the only call (no legacy callbacks)", () => {
      const workspaceWebContents = createMockWebContents();
      controller.registerView(workspaceWebContents);

      const inputHandler = workspaceWebContents.on.mock.calls.find(
        (call: unknown[]) => call[0] === "before-input-event"
      )?.[1] as (event: ElectronEvent, input: Input) => void;

      // Track execution order
      const executionOrder: string[] = [];
      mockDeps.setMode.mockImplementation(() => {
        executionOrder.push("setMode");
      });
      mockDeps.focusUI.mockImplementation(() => {
        executionOrder.push("focusUI");
      });

      // Trigger Alt+X
      inputHandler(createMockElectronEvent(), createMockElectronInput("Alt", "keyDown"));
      inputHandler(createMockElectronEvent(), createMockElectronInput("x", "keyDown"));

      // setMode is deferred via setImmediate, flush timers
      vi.runAllTimers();

      // Verify only setMode is called (unified API handles everything)
      expect(executionOrder).toEqual(["setMode"]);
    });

    it("does not trigger chain when only Alt is pressed (no X follow-up)", () => {
      const workspaceWebContents = createMockWebContents();
      controller.registerView(workspaceWebContents);

      const inputHandler = workspaceWebContents.on.mock.calls.find(
        (call: unknown[]) => call[0] === "before-input-event"
      )?.[1] as (event: ElectronEvent, input: Input) => void;

      // Only press Alt
      inputHandler(createMockElectronEvent(), createMockElectronInput("Alt", "keyDown"));

      // Verify nothing in the chain was called
      expect(mockDeps.setMode).not.toHaveBeenCalled();
      expect(mockDeps.focusUI).not.toHaveBeenCalled();
    });

    it("does not trigger chain when X is pressed without prior Alt", () => {
      const workspaceWebContents = createMockWebContents();
      controller.registerView(workspaceWebContents);

      const inputHandler = workspaceWebContents.on.mock.calls.find(
        (call: unknown[]) => call[0] === "before-input-event"
      )?.[1] as (event: ElectronEvent, input: Input) => void;

      // Only press X (no prior Alt)
      inputHandler(createMockElectronEvent(), createMockElectronInput("x", "keyDown"));

      // Verify nothing in the chain was called
      expect(mockDeps.setMode).not.toHaveBeenCalled();
      expect(mockDeps.focusUI).not.toHaveBeenCalled();
    });
  });
});
