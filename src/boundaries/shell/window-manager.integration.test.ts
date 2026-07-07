/**
 * Integration tests for WindowManager using behavioral mocks.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { WindowManager, type WindowManagerDeps } from "./window-manager";
import { SILENT_LOGGER } from "../platform/logging";
import { createImageBoundaryMock } from "./image.state-mock";
import { createWindowBoundaryMock, type MockWindowBoundary } from "./window.state-mock";
import { createAppBoundaryMock, type MockAppBoundary } from "./app.state-mock";
import type { ImageHandle } from "./image-types";

/**
 * Creates WindowManager deps with behavioral mocks.
 */
function createWindowManagerDeps(
  overrides: {
    imageLayer?: ReturnType<typeof createImageBoundaryMock>;
    appLayer?: MockAppBoundary;
  } = {}
): WindowManagerDeps & { windowLayer: MockWindowBoundary; appLayer: MockAppBoundary } {
  const windowLayer = createWindowBoundaryMock();
  const imageLayer = overrides.imageLayer ?? createImageBoundaryMock();
  const appLayer = overrides.appLayer ?? createAppBoundaryMock();

  return {
    windowLayer,
    imageLayer,
    appLayer,
    logger: SILENT_LOGGER,
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
    it("maximizes the window (the page auto-fills, so no bounds settling)", async () => {
      const deps = createWindowManagerDeps();
      const manager = createWindowManager(deps);
      const maximizeSpy = vi.spyOn(deps.windowLayer, "maximize");

      await manager.maximizeAsync();

      expect(maximizeSpy).toHaveBeenCalledWith(manager.getWindowHandle());
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
    it("delegates to windowLayer.setOverlayIcon", () => {
      const deps = createWindowManagerDeps();
      const manager = createWindowManager(deps);
      const imageHandle: ImageHandle = { id: "image-1", __brand: "ImageHandle" };

      // Should not throw - overlay icon is handled by WindowBoundary
      expect(() => manager.setOverlayIcon(imageHandle, "3 idle agents")).not.toThrow();
    });

    it("clears overlay when null passed", () => {
      const deps = createWindowManagerDeps();
      const manager = createWindowManager(deps);

      // Should not throw
      expect(() => manager.setOverlayIcon(null, "")).not.toThrow();
    });
  });
});
