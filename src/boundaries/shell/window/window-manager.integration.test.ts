/**
 * Integration tests for WindowManager using behavioral mocks.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { WindowManager, type WindowManagerDeps } from "./window-manager";
import { SILENT_LOGGER } from "../../../boundaries/platform/logging";
import { createMockPlatformInfo } from "../../../boundaries/platform/env/platform-info.test-utils";
import { createImageBoundaryMock } from "../image/image.state-mock";
import {
  createWindowBoundaryInternalMock,
  type MockWindowBoundaryInternal,
} from "./window.state-mock";
import type { ImageHandle } from "../image/types";

/**
 * Creates WindowManager deps with behavioral mocks.
 */
function createWindowManagerDeps(
  overrides: {
    platformInfo?: ReturnType<typeof createMockPlatformInfo>;
    imageLayer?: ReturnType<typeof createImageBoundaryMock>;
  } = {}
): WindowManagerDeps & { windowLayer: MockWindowBoundaryInternal } {
  const windowLayer = createWindowBoundaryInternalMock();
  const imageLayer = overrides.imageLayer ?? createImageBoundaryMock();
  const platformInfo = overrides.platformInfo ?? createMockPlatformInfo();

  return {
    windowLayer,
    imageLayer,
    logger: SILENT_LOGGER,
    platformInfo,
  };
}

/**
 * Creates a WindowManager with two-phase init (constructor + create).
 */
function createWindowManager(
  deps: WindowManagerDeps,
  title?: string,
  iconPath?: string
): WindowManager {
  const manager = new WindowManager(deps, title, iconPath);
  manager.create();
  return manager;
}

describe("WindowManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("create", () => {
    it("creates a window with default title", () => {
      const deps = createWindowManagerDeps();
      const manager = createWindowManager(deps);

      expect(deps.windowLayer).toHaveWindowCount(1);
      expect(deps.windowLayer).toHaveWindowTitle(manager.getWindowHandle().id, "CodeHydra");
    });

    it("creates a window with custom title", () => {
      const deps = createWindowManagerDeps();
      const manager = createWindowManager(deps, "CodeHydra (feature-branch)");

      expect(deps.windowLayer).toHaveWindowTitle(
        manager.getWindowHandle().id,
        "CodeHydra (feature-branch)"
      );
    });

    it("returns a WindowManager instance", () => {
      const deps = createWindowManagerDeps();
      const manager = createWindowManager(deps);

      expect(manager).toBeInstanceOf(WindowManager);
    });

    it("creates window with correct dimensions", () => {
      const deps = createWindowManagerDeps();
      const manager = createWindowManager(deps);

      expect(deps.windowLayer).toHaveWindowBounds(manager.getWindowHandle().id, {
        width: 1200,
        height: 800,
      });
    });

    it("sets window icon from provided icon path", () => {
      const deps = createWindowManagerDeps();
      // Mock the imageLayer to return a non-empty image
      const mockImageBoundary = {
        ...deps.imageLayer,
        createFromPath: vi.fn().mockReturnValue({ id: "icon-1", __brand: "ImageHandle" }),
        isEmpty: vi.fn().mockReturnValue(false),
        release: vi.fn(),
      };
      const depsWithMockImage = { ...deps, imageLayer: mockImageBoundary };

      createWindowManager(depsWithMockImage, "CodeHydra", "/app/resources/icon.png");

      expect(mockImageBoundary.createFromPath).toHaveBeenCalledWith("/app/resources/icon.png");
      expect(mockImageBoundary.release).toHaveBeenCalled();
    });

    it("does not set icon when image is empty", () => {
      const deps = createWindowManagerDeps();
      const mockImageBoundary = {
        ...deps.imageLayer,
        createFromPath: vi.fn().mockReturnValue({ id: "icon-1", __brand: "ImageHandle" }),
        isEmpty: vi.fn().mockReturnValue(true), // Empty image
        release: vi.fn(),
      };
      const depsWithMockImage = { ...deps, imageLayer: mockImageBoundary };

      // Should not throw
      expect(() =>
        createWindowManager(depsWithMockImage, "CodeHydra", "/app/resources/icon.png")
      ).not.toThrow();
    });

    it("handles icon loading errors gracefully", () => {
      const deps = createWindowManagerDeps();
      const mockImageBoundary = {
        ...deps.imageLayer,
        createFromPath: vi.fn().mockImplementation(() => {
          throw new Error("Failed to load icon");
        }),
      };
      const depsWithMockImage = { ...deps, imageLayer: mockImageBoundary };

      // Should not throw
      expect(() =>
        createWindowManager(depsWithMockImage, "CodeHydra", "/app/resources/icon.png")
      ).not.toThrow();
    });

    it("does not attempt to load icon when iconPath is not provided", () => {
      const deps = createWindowManagerDeps();
      const mockImageBoundary = {
        ...deps.imageLayer,
        createFromPath: vi.fn(),
      };
      const depsWithMockImage = { ...deps, imageLayer: mockImageBoundary };

      createWindowManager(depsWithMockImage, "CodeHydra");

      expect(mockImageBoundary.createFromPath).not.toHaveBeenCalled();
    });
  });

  describe("maximizeAsync", () => {
    it("maximizes the window and notifies resize callbacks after delay", async () => {
      vi.useFakeTimers();
      const deps = createWindowManagerDeps();
      const manager = createWindowManager(deps);
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

  describe("getWindowHandle", () => {
    it("returns the WindowHandle", () => {
      const deps = createWindowManagerDeps();
      const manager = createWindowManager(deps);

      const handle = manager.getWindowHandle();

      expect(handle.id).toMatch(/^window-\d+$/);
      expect(handle.__brand).toBe("WindowHandle");
    });
  });

  describe("getBounds", () => {
    it("returns window content bounds", () => {
      const deps = createWindowManagerDeps();
      const manager = createWindowManager(deps);

      const bounds = manager.getBounds();

      expect(bounds.width).toBe(1200);
      expect(bounds.height).toBe(800);
    });
  });

  describe("onResize", () => {
    it("calls callback when resize is triggered", () => {
      const deps = createWindowManagerDeps();
      const manager = createWindowManager(deps);
      const callback = vi.fn();

      manager.onResize(callback);
      callback.mockClear(); // Clear any initial calls

      // Trigger resize via the behavioral mock
      const handle = manager.getWindowHandle();
      deps.windowLayer.$.triggerResize(handle);

      expect(callback).toHaveBeenCalled();
    });

    it("returns unsubscribe function that removes listener", () => {
      const deps = createWindowManagerDeps();
      const manager = createWindowManager(deps);
      const callback = vi.fn();

      const unsubscribe = manager.onResize(callback);
      callback.mockClear();

      // Unsubscribe
      unsubscribe();

      // Trigger resize
      const handle = manager.getWindowHandle();
      deps.windowLayer.$.triggerResize(handle);

      // Callback should not be called after unsubscribe
      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe("setTitle", () => {
    it("sets the window title", () => {
      const deps = createWindowManagerDeps();
      const manager = createWindowManager(deps);

      manager.setTitle("CodeHydra - my-app / feature - (main)");

      const handle = manager.getWindowHandle();
      expect(deps.windowLayer).toHaveWindowTitle(
        handle.id,
        "CodeHydra - my-app / feature - (main)"
      );
    });
  });

  describe("setOverlayIcon", () => {
    it("calls windowLayer.setOverlayIcon on Windows", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });
      const deps = createWindowManagerDeps({ platformInfo });
      const manager = createWindowManager(deps);
      const imageHandle: ImageHandle = { id: "image-1", __brand: "ImageHandle" };

      // Should not throw - overlay icon is handled by WindowBoundary
      expect(() => manager.setOverlayIcon(imageHandle, "3 idle agents")).not.toThrow();
    });

    it("clears overlay when null passed on Windows", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });
      const deps = createWindowManagerDeps({ platformInfo });
      const manager = createWindowManager(deps);

      // Should not throw
      expect(() => manager.setOverlayIcon(null, "")).not.toThrow();
    });

    it("no-ops on macOS", () => {
      const platformInfo = createMockPlatformInfo({ platform: "darwin" });
      const deps = createWindowManagerDeps({ platformInfo });
      const manager = createWindowManager(deps);
      const imageHandle: ImageHandle = { id: "image-1", __brand: "ImageHandle" };

      // Should not throw and not call windowLayer (no-op)
      expect(() => manager.setOverlayIcon(imageHandle, "3 idle agents")).not.toThrow();
    });

    it("no-ops on Linux", () => {
      const platformInfo = createMockPlatformInfo({ platform: "linux" });
      const deps = createWindowManagerDeps({ platformInfo });
      const manager = createWindowManager(deps);
      const imageHandle: ImageHandle = { id: "image-1", __brand: "ImageHandle" };

      // Should not throw and not call windowLayer (no-op)
      expect(() => manager.setOverlayIcon(imageHandle, "3 idle agents")).not.toThrow();
    });
  });

  describe("close", () => {
    it("closes the window", () => {
      const deps = createWindowManagerDeps();
      const manager = createWindowManager(deps);
      const handle = manager.getWindowHandle();

      manager.close();

      expect(deps.windowLayer.isDestroyed(handle)).toBe(true);
    });
  });
});
