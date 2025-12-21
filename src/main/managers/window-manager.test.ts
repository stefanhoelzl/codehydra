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
      setOverlayIcon: vi.fn(),
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
      createFromDataURL: vi.fn(() => mockImage),
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
import { createSilentLogger } from "../../services/logging";
import { createMockPlatformInfo } from "../../services/platform/platform-info.test-utils";
import type { NativeImage } from "electron";

describe("WindowManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("create", () => {
    it("creates a BaseWindow with default title", () => {
      const platformInfo = createMockPlatformInfo();
      WindowManager.create(createSilentLogger(), platformInfo);

      expect(MockBaseWindowClass).toHaveBeenCalledWith({
        width: 1200,
        height: 800,
        minWidth: 800,
        minHeight: 600,
        title: "CodeHydra",
      });
    });

    it("creates a BaseWindow with custom title", () => {
      const platformInfo = createMockPlatformInfo();
      WindowManager.create(createSilentLogger(), platformInfo, "CodeHydra (feature-branch)");

      expect(MockBaseWindowClass).toHaveBeenCalledWith({
        width: 1200,
        height: 800,
        minWidth: 800,
        minHeight: 600,
        title: "CodeHydra (feature-branch)",
      });
    });

    it("returns a WindowManager instance", () => {
      const platformInfo = createMockPlatformInfo();
      const manager = WindowManager.create(createSilentLogger(), platformInfo);

      expect(manager).toBeInstanceOf(WindowManager);
    });

    it("sets window icon from provided icon path", () => {
      const platformInfo = createMockPlatformInfo();
      WindowManager.create(
        createSilentLogger(),
        platformInfo,
        "CodeHydra",
        "/app/resources/icon.png"
      );

      expect(mockNativeImage.createFromPath).toHaveBeenCalledWith("/app/resources/icon.png");
      expect(mockBaseWindow.setIcon).toHaveBeenCalledWith(mockNativeImage._mockImage);
    });

    it("does not set icon when nativeImage returns empty", () => {
      mockNativeImage._mockImage.isEmpty.mockReturnValueOnce(true);

      const platformInfo = createMockPlatformInfo();
      WindowManager.create(
        createSilentLogger(),
        platformInfo,
        "CodeHydra",
        "/app/resources/icon.png"
      );

      expect(mockNativeImage.createFromPath).toHaveBeenCalled();
      expect(mockBaseWindow.setIcon).not.toHaveBeenCalled();
    });

    it("handles icon loading errors gracefully", () => {
      mockNativeImage.createFromPath.mockImplementationOnce(() => {
        throw new Error("Failed to load icon");
      });

      const platformInfo = createMockPlatformInfo();
      // Should not throw
      expect(() =>
        WindowManager.create(
          createSilentLogger(),
          platformInfo,
          "CodeHydra",
          "/app/resources/icon.png"
        )
      ).not.toThrow();
    });

    it("does not attempt to load icon when iconPath is not provided", () => {
      const platformInfo = createMockPlatformInfo();
      WindowManager.create(createSilentLogger(), platformInfo, "CodeHydra");

      expect(mockNativeImage.createFromPath).not.toHaveBeenCalled();
      expect(mockBaseWindow.setIcon).not.toHaveBeenCalled();
    });
  });

  describe("maximizeAsync", () => {
    it("maximizes the window and notifies resize callbacks after delay", async () => {
      vi.useFakeTimers();
      const platformInfo = createMockPlatformInfo();
      const manager = WindowManager.create(createSilentLogger(), platformInfo);
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
      const platformInfo = createMockPlatformInfo();
      const manager = WindowManager.create(createSilentLogger(), platformInfo);

      const window = manager.getWindow();

      expect(window).toBe(mockBaseWindow);
    });
  });

  describe("getBounds", () => {
    it("returns window content bounds", () => {
      mockBaseWindow.getContentBounds.mockReturnValue({ width: 1400, height: 900, x: 100, y: 50 });
      const platformInfo = createMockPlatformInfo();
      const manager = WindowManager.create(createSilentLogger(), platformInfo);

      const bounds = manager.getBounds();

      expect(bounds).toEqual({ width: 1400, height: 900 });
    });
  });

  describe("onResize", () => {
    it("registers a resize event listener", () => {
      const platformInfo = createMockPlatformInfo();
      const manager = WindowManager.create(createSilentLogger(), platformInfo);
      const callback = vi.fn();

      manager.onResize(callback);

      expect(mockBaseWindow.on).toHaveBeenCalledWith("resize", expect.any(Function));
    });

    it("calls callback when window resizes", () => {
      const platformInfo = createMockPlatformInfo();
      const manager = WindowManager.create(createSilentLogger(), platformInfo);
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
      const platformInfo = createMockPlatformInfo();
      const manager = WindowManager.create(createSilentLogger(), platformInfo);
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
      const platformInfo = createMockPlatformInfo();
      const manager = WindowManager.create(createSilentLogger(), platformInfo);

      manager.setTitle("CodeHydra - my-app / feature - (main)");

      expect(mockBaseWindow.setTitle).toHaveBeenCalledWith("CodeHydra - my-app / feature - (main)");
    });
  });

  describe("setOverlayIcon", () => {
    it("calls BaseWindow.setOverlayIcon on Windows", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });
      const manager = WindowManager.create(createSilentLogger(), platformInfo);
      const mockImage = mockNativeImage._mockImage as unknown as NativeImage;

      manager.setOverlayIcon(mockImage, "3 idle agents");

      expect(mockBaseWindow.setOverlayIcon).toHaveBeenCalledWith(mockImage, "3 idle agents");
    });

    it("clears overlay when null passed on Windows", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });
      const manager = WindowManager.create(createSilentLogger(), platformInfo);

      manager.setOverlayIcon(null, "");

      expect(mockBaseWindow.setOverlayIcon).toHaveBeenCalledWith(null, "");
    });

    it("no-ops on macOS", () => {
      const platformInfo = createMockPlatformInfo({ platform: "darwin" });
      const manager = WindowManager.create(createSilentLogger(), platformInfo);
      const mockImage = mockNativeImage._mockImage as unknown as NativeImage;

      manager.setOverlayIcon(mockImage, "3 idle agents");

      expect(mockBaseWindow.setOverlayIcon).not.toHaveBeenCalled();
    });

    it("no-ops on Linux", () => {
      const platformInfo = createMockPlatformInfo({ platform: "linux" });
      const manager = WindowManager.create(createSilentLogger(), platformInfo);
      const mockImage = mockNativeImage._mockImage as unknown as NativeImage;

      manager.setOverlayIcon(mockImage, "3 idle agents");

      expect(mockBaseWindow.setOverlayIcon).not.toHaveBeenCalled();
    });

    it("handles nativeImage errors gracefully", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });
      const manager = WindowManager.create(createSilentLogger(), platformInfo);
      mockBaseWindow.setOverlayIcon.mockImplementationOnce(() => {
        throw new Error("Failed to set overlay");
      });
      const mockImage = mockNativeImage._mockImage as unknown as NativeImage;

      // Should not throw
      expect(() => manager.setOverlayIcon(mockImage, "3 idle agents")).not.toThrow();
    });
  });

  describe("close", () => {
    it("closes the window", () => {
      const platformInfo = createMockPlatformInfo();
      const manager = WindowManager.create(createSilentLogger(), platformInfo);

      manager.close();

      expect(mockBaseWindow.close).toHaveBeenCalled();
    });
  });
});
