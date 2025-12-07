// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock Electron before imports
const { mockBaseWindow, MockBaseWindowClass, mockMenuSetApplicationMenu } = vi.hoisted(() => {
  const mockWindow = {
    getBounds: vi.fn(() => ({ width: 1200, height: 800, x: 0, y: 0 })),
    getContentBounds: vi.fn(() => ({ width: 1200, height: 800, x: 0, y: 0 })),
    on: vi.fn().mockReturnThis(),
    close: vi.fn(),
    maximize: vi.fn(),
    contentView: {
      addChildView: vi.fn(),
      removeChildView: vi.fn(),
    },
  };

  // Create a mock constructor function
  function MockBaseWindowClass(this: typeof mockWindow): typeof mockWindow {
    return mockWindow;
  }

  return {
    mockBaseWindow: mockWindow,
    MockBaseWindowClass: vi.fn(MockBaseWindowClass) as unknown as typeof MockBaseWindowClass & {
      mock: { calls: Array<[Record<string, unknown>]> };
    },
    mockMenuSetApplicationMenu: vi.fn(),
  };
});

vi.mock("electron", () => ({
  BaseWindow: MockBaseWindowClass,
  Menu: {
    setApplicationMenu: mockMenuSetApplicationMenu,
  },
}));

import { WindowManager } from "./window-manager";

describe("WindowManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("create", () => {
    it("creates a BaseWindow with correct configuration", () => {
      WindowManager.create();

      expect(MockBaseWindowClass).toHaveBeenCalledWith({
        width: 1200,
        height: 800,
        minWidth: 800,
        minHeight: 600,
        title: "CodeHydra",
      });
    });

    it("returns a WindowManager instance", () => {
      const manager = WindowManager.create();

      expect(manager).toBeInstanceOf(WindowManager);
    });

    it("maximizes the window after creation", () => {
      WindowManager.create();

      expect(mockBaseWindow.maximize).toHaveBeenCalled();
    });
  });

  describe("getWindow", () => {
    it("returns the created BaseWindow", () => {
      const manager = WindowManager.create();

      const window = manager.getWindow();

      expect(window).toBe(mockBaseWindow);
    });
  });

  describe("getBounds", () => {
    it("returns window content bounds", () => {
      mockBaseWindow.getContentBounds.mockReturnValue({ width: 1400, height: 900, x: 100, y: 50 });
      const manager = WindowManager.create();

      const bounds = manager.getBounds();

      expect(bounds).toEqual({ width: 1400, height: 900 });
    });
  });

  describe("onResize", () => {
    it("registers a resize event listener", () => {
      const manager = WindowManager.create();
      const callback = vi.fn();

      manager.onResize(callback);

      expect(mockBaseWindow.on).toHaveBeenCalledWith("resize", expect.any(Function));
    });

    it("calls callback when window resizes", () => {
      const manager = WindowManager.create();
      const callback = vi.fn();

      manager.onResize(callback);

      // Get the registered callback from constructor call
      const resizeCallback = mockBaseWindow.on.mock.calls.find(
        (call) => call[0] === "resize"
      )?.[1] as () => void;

      // Simulate resize
      resizeCallback();

      expect(callback).toHaveBeenCalled();
    });

    it("returns unsubscribe function that removes listener", () => {
      const manager = WindowManager.create();
      const callback = vi.fn();

      const unsubscribe = manager.onResize(callback);

      // Get the registered callback
      const resizeCallback = mockBaseWindow.on.mock.calls.find(
        (call) => call[0] === "resize"
      )?.[1] as () => void;

      // Unsubscribe
      unsubscribe();

      // Callback should not be called after unsubscribe
      resizeCallback();
      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe("close", () => {
    it("closes the window", () => {
      const manager = WindowManager.create();

      manager.close();

      expect(mockBaseWindow.close).toHaveBeenCalled();
    });
  });
});
