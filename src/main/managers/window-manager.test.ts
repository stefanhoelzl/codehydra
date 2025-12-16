// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock Electron before imports
const { mockBaseWindow, MockBaseWindowClass, mockMenuSetApplicationMenu, mockNativeImage } =
  vi.hoisted(() => {
    const mockWindow = {
      getBounds: vi.fn(() => ({ width: 1200, height: 800, x: 0, y: 0 })),
      getContentBounds: vi.fn(() => ({ width: 1200, height: 800, x: 0, y: 0 })),
      on: vi.fn().mockReturnThis(),
      close: vi.fn(),
      maximize: vi.fn(),
      setTitle: vi.fn(),
      setIcon: vi.fn(),
      contentView: {
        addChildView: vi.fn(),
        removeChildView: vi.fn(),
      },
    };

    // Create a mock constructor function
    function MockBaseWindowClass(this: typeof mockWindow): typeof mockWindow {
      return mockWindow;
    }

    const mockImage = {
      isEmpty: vi.fn(() => false),
    };

    const mockNativeImage = {
      createFromPath: vi.fn(() => mockImage),
      _mockImage: mockImage,
    };

    return {
      mockBaseWindow: mockWindow,
      MockBaseWindowClass: vi.fn(MockBaseWindowClass) as unknown as typeof MockBaseWindowClass & {
        mock: { calls: Array<[Record<string, unknown>]> };
      },
      mockMenuSetApplicationMenu: vi.fn(),
      mockNativeImage,
    };
  });

vi.mock("electron", () => ({
  BaseWindow: MockBaseWindowClass,
  Menu: {
    setApplicationMenu: mockMenuSetApplicationMenu,
  },
  nativeImage: mockNativeImage,
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
    it("creates a BaseWindow with default title", () => {
      WindowManager.create();

      expect(MockBaseWindowClass).toHaveBeenCalledWith({
        width: 1200,
        height: 800,
        minWidth: 800,
        minHeight: 600,
        title: "CodeHydra",
      });
    });

    it("creates a BaseWindow with custom title", () => {
      WindowManager.create("CodeHydra (feature-branch)");

      expect(MockBaseWindowClass).toHaveBeenCalledWith({
        width: 1200,
        height: 800,
        minWidth: 800,
        minHeight: 600,
        title: "CodeHydra (feature-branch)",
      });
    });

    it("returns a WindowManager instance", () => {
      const manager = WindowManager.create();

      expect(manager).toBeInstanceOf(WindowManager);
    });

    it("sets window icon from provided icon path", () => {
      WindowManager.create("CodeHydra", "/app/resources/icon.png");

      expect(mockNativeImage.createFromPath).toHaveBeenCalledWith("/app/resources/icon.png");
      expect(mockBaseWindow.setIcon).toHaveBeenCalledWith(mockNativeImage._mockImage);
    });

    it("does not set icon when nativeImage returns empty", () => {
      mockNativeImage._mockImage.isEmpty.mockReturnValueOnce(true);

      WindowManager.create("CodeHydra", "/app/resources/icon.png");

      expect(mockNativeImage.createFromPath).toHaveBeenCalled();
      expect(mockBaseWindow.setIcon).not.toHaveBeenCalled();
    });

    it("handles icon loading errors gracefully", () => {
      mockNativeImage.createFromPath.mockImplementationOnce(() => {
        throw new Error("Failed to load icon");
      });

      // Should not throw
      expect(() => WindowManager.create("CodeHydra", "/app/resources/icon.png")).not.toThrow();
    });

    it("does not attempt to load icon when iconPath is not provided", () => {
      WindowManager.create("CodeHydra");

      expect(mockNativeImage.createFromPath).not.toHaveBeenCalled();
      expect(mockBaseWindow.setIcon).not.toHaveBeenCalled();
    });
  });

  describe("maximizeAsync", () => {
    it("maximizes the window and notifies resize callbacks after delay", async () => {
      vi.useFakeTimers();
      const manager = WindowManager.create();
      const callback = vi.fn();
      manager.onResize(callback);
      callback.mockClear();

      const promise = manager.maximizeAsync();

      // maximize() called immediately
      expect(mockBaseWindow.maximize).toHaveBeenCalled();

      // Callback not called yet (before delay)
      expect(callback).not.toHaveBeenCalled();

      // Fast-forward past the 50ms delay
      await vi.advanceTimersByTimeAsync(50);
      await promise;

      // Callback called after delay
      expect(callback).toHaveBeenCalled();

      vi.useRealTimers();
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

  describe("setTitle", () => {
    it("sets the window title", () => {
      const manager = WindowManager.create();

      manager.setTitle("CodeHydra - my-app / feature - (main)");

      expect(mockBaseWindow.setTitle).toHaveBeenCalledWith("CodeHydra - my-app / feature - (main)");
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
