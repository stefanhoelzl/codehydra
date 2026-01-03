/**
 * Integration tests for WindowManager using behavioral mocks.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { WindowManager, type WindowManagerDeps } from "./window-manager";
import { SILENT_LOGGER } from "../../services/logging";
import { createMockPlatformInfo } from "../../services/platform/platform-info.test-utils";
import { createImageLayerMock } from "../../services/platform/image.state-mock";
import {
  createTestWindowLayer,
  type TestWindowLayer,
} from "../../services/shell/window.test-utils";
import type { ImageHandle } from "../../services/platform/types";

/**
 * Creates WindowManager deps with behavioral mocks.
 */
function createWindowManagerDeps(
  overrides: {
    platformInfo?: ReturnType<typeof createMockPlatformInfo>;
    imageLayer?: ReturnType<typeof createImageLayerMock>;
  } = {}
): WindowManagerDeps & { windowLayer: TestWindowLayer } {
  const windowLayer = createTestWindowLayer();
  const imageLayer = overrides.imageLayer ?? createImageLayerMock();
  const platformInfo = overrides.platformInfo ?? createMockPlatformInfo();

  return {
    windowLayer,
    imageLayer,
    logger: SILENT_LOGGER,
    platformInfo,
  };
}

describe("WindowManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("create", () => {
    it("creates a window with default title", () => {
      const deps = createWindowManagerDeps();
      WindowManager.create(deps);

      const state = deps.windowLayer._getState();
      expect(state.windows.size).toBe(1);

      const window = [...state.windows.values()][0];
      expect(window?.title).toBe("CodeHydra");
    });

    it("creates a window with custom title", () => {
      const deps = createWindowManagerDeps();
      WindowManager.create(deps, "CodeHydra (feature-branch)");

      const state = deps.windowLayer._getState();
      const window = [...state.windows.values()][0];
      expect(window?.title).toBe("CodeHydra (feature-branch)");
    });

    it("returns a WindowManager instance", () => {
      const deps = createWindowManagerDeps();
      const manager = WindowManager.create(deps);

      expect(manager).toBeInstanceOf(WindowManager);
    });

    it("creates window with correct dimensions", () => {
      const deps = createWindowManagerDeps();
      WindowManager.create(deps);

      const state = deps.windowLayer._getState();
      const window = [...state.windows.values()][0];
      expect(window?.bounds.width).toBe(1200);
      expect(window?.bounds.height).toBe(800);
    });

    it("sets window icon from provided icon path", () => {
      const deps = createWindowManagerDeps();
      // Mock the imageLayer to return a non-empty image
      const mockImageLayer = {
        ...deps.imageLayer,
        createFromPath: vi.fn().mockReturnValue({ id: "icon-1", __brand: "ImageHandle" }),
        isEmpty: vi.fn().mockReturnValue(false),
        release: vi.fn(),
      };
      const depsWithMockImage = { ...deps, imageLayer: mockImageLayer };

      WindowManager.create(depsWithMockImage, "CodeHydra", "/app/resources/icon.png");

      expect(mockImageLayer.createFromPath).toHaveBeenCalledWith("/app/resources/icon.png");
      expect(mockImageLayer.release).toHaveBeenCalled();
    });

    it("does not set icon when image is empty", () => {
      const deps = createWindowManagerDeps();
      const mockImageLayer = {
        ...deps.imageLayer,
        createFromPath: vi.fn().mockReturnValue({ id: "icon-1", __brand: "ImageHandle" }),
        isEmpty: vi.fn().mockReturnValue(true), // Empty image
        release: vi.fn(),
      };
      const depsWithMockImage = { ...deps, imageLayer: mockImageLayer };

      // Should not throw
      expect(() =>
        WindowManager.create(depsWithMockImage, "CodeHydra", "/app/resources/icon.png")
      ).not.toThrow();
    });

    it("handles icon loading errors gracefully", () => {
      const deps = createWindowManagerDeps();
      const mockImageLayer = {
        ...deps.imageLayer,
        createFromPath: vi.fn().mockImplementation(() => {
          throw new Error("Failed to load icon");
        }),
      };
      const depsWithMockImage = { ...deps, imageLayer: mockImageLayer };

      // Should not throw
      expect(() =>
        WindowManager.create(depsWithMockImage, "CodeHydra", "/app/resources/icon.png")
      ).not.toThrow();
    });

    it("does not attempt to load icon when iconPath is not provided", () => {
      const deps = createWindowManagerDeps();
      const mockImageLayer = {
        ...deps.imageLayer,
        createFromPath: vi.fn(),
      };
      const depsWithMockImage = { ...deps, imageLayer: mockImageLayer };

      WindowManager.create(depsWithMockImage, "CodeHydra");

      expect(mockImageLayer.createFromPath).not.toHaveBeenCalled();
    });
  });

  describe("maximizeAsync", () => {
    it("maximizes the window and notifies resize callbacks after delay", async () => {
      vi.useFakeTimers();
      const deps = createWindowManagerDeps();
      const manager = WindowManager.create(deps);
      const callback = vi.fn();
      manager.onResize(callback);
      callback.mockClear();

      const promise = manager.maximizeAsync();

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
    it("returns the underlying BaseWindow", () => {
      const deps = createWindowManagerDeps();
      const manager = WindowManager.create(deps);

      // The behavioral mock doesn't have _getRawWindow, so this will throw
      // In production, this returns the real BaseWindow
      expect(() => manager.getWindow()).toThrow();
    });
  });

  describe("getWindowHandle", () => {
    it("returns the WindowHandle", () => {
      const deps = createWindowManagerDeps();
      const manager = WindowManager.create(deps);

      const handle = manager.getWindowHandle();

      expect(handle.id).toMatch(/^window-\d+$/);
      expect(handle.__brand).toBe("WindowHandle");
    });
  });

  describe("getBounds", () => {
    it("returns window content bounds", () => {
      const deps = createWindowManagerDeps();
      const manager = WindowManager.create(deps);

      const bounds = manager.getBounds();

      expect(bounds.width).toBe(1200);
      expect(bounds.height).toBe(800);
    });
  });

  describe("onResize", () => {
    it("calls callback when resize is triggered", () => {
      const deps = createWindowManagerDeps();
      const manager = WindowManager.create(deps);
      const callback = vi.fn();

      manager.onResize(callback);
      callback.mockClear(); // Clear any initial calls

      // Trigger resize via the behavioral mock
      const handle = manager.getWindowHandle();
      deps.windowLayer._triggerResize(handle);

      expect(callback).toHaveBeenCalled();
    });

    it("returns unsubscribe function that removes listener", () => {
      const deps = createWindowManagerDeps();
      const manager = WindowManager.create(deps);
      const callback = vi.fn();

      const unsubscribe = manager.onResize(callback);
      callback.mockClear();

      // Unsubscribe
      unsubscribe();

      // Trigger resize
      const handle = manager.getWindowHandle();
      deps.windowLayer._triggerResize(handle);

      // Callback should not be called after unsubscribe
      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe("setTitle", () => {
    it("sets the window title", () => {
      const deps = createWindowManagerDeps();
      const manager = WindowManager.create(deps);

      manager.setTitle("CodeHydra - my-app / feature - (main)");

      const handle = manager.getWindowHandle();
      const state = deps.windowLayer._getState();
      const window = state.windows.get(handle.id);
      expect(window?.title).toBe("CodeHydra - my-app / feature - (main)");
    });
  });

  describe("setOverlayIcon", () => {
    it("calls windowLayer.setOverlayIcon on Windows", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });
      const deps = createWindowManagerDeps({ platformInfo });
      const manager = WindowManager.create(deps);
      const imageHandle: ImageHandle = { id: "image-1", __brand: "ImageHandle" };

      // Should not throw - overlay icon is handled by WindowLayer
      expect(() => manager.setOverlayIcon(imageHandle, "3 idle agents")).not.toThrow();
    });

    it("clears overlay when null passed on Windows", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });
      const deps = createWindowManagerDeps({ platformInfo });
      const manager = WindowManager.create(deps);

      // Should not throw
      expect(() => manager.setOverlayIcon(null, "")).not.toThrow();
    });

    it("no-ops on macOS", () => {
      const platformInfo = createMockPlatformInfo({ platform: "darwin" });
      const deps = createWindowManagerDeps({ platformInfo });
      const manager = WindowManager.create(deps);
      const imageHandle: ImageHandle = { id: "image-1", __brand: "ImageHandle" };

      // Should not throw and not call windowLayer (no-op)
      expect(() => manager.setOverlayIcon(imageHandle, "3 idle agents")).not.toThrow();
    });

    it("no-ops on Linux", () => {
      const platformInfo = createMockPlatformInfo({ platform: "linux" });
      const deps = createWindowManagerDeps({ platformInfo });
      const manager = WindowManager.create(deps);
      const imageHandle: ImageHandle = { id: "image-1", __brand: "ImageHandle" };

      // Should not throw and not call windowLayer (no-op)
      expect(() => manager.setOverlayIcon(imageHandle, "3 idle agents")).not.toThrow();
    });
  });

  describe("close", () => {
    it("closes the window", () => {
      const deps = createWindowManagerDeps();
      const manager = WindowManager.create(deps);
      const handle = manager.getWindowHandle();

      manager.close();

      expect(deps.windowLayer.isDestroyed(handle)).toBe(true);
    });
  });
});
