// @vitest-environment node

import { describe, it, expect, beforeEach } from "vitest";

import { BadgeManager } from "./badge-manager";
import { createMockPlatformInfo } from "../../services/platform/platform-info.test-utils";
import { SILENT_LOGGER } from "../../services/logging";
import {
  createBehavioralAppLayer,
  type BehavioralAppLayer,
} from "../../services/platform/app.test-utils";
import {
  createBehavioralImageLayer,
  type BehavioralImageLayer,
} from "../../services/platform/image.test-utils";
import type { WindowManager } from "./window-manager";
import type { NativeImage } from "electron";

/**
 * Mock WindowManager for BadgeManager testing.
 */
interface MockWindowManager {
  setOverlayIcon: (image: NativeImage | null, description: string) => void;
  setOverlayIconCalls: Array<{ image: NativeImage | null; description: string }>;
}

function createMockWindowManager(): MockWindowManager {
  const setOverlayIconCalls: Array<{ image: NativeImage | null; description: string }> = [];
  return {
    setOverlayIcon: (image: NativeImage | null, description: string) => {
      setOverlayIconCalls.push({ image, description });
    },
    setOverlayIconCalls,
  };
}

describe("BadgeManager", () => {
  let appLayer: BehavioralAppLayer;
  let imageLayer: BehavioralImageLayer;
  let windowManager: MockWindowManager;

  beforeEach(() => {
    appLayer = createBehavioralAppLayer();
    imageLayer = createBehavioralImageLayer();
    windowManager = createMockWindowManager();
  });

  describe("updateBadge (darwin)", () => {
    it("shows filled circle for all-working state", () => {
      const platformInfo = createMockPlatformInfo({ platform: "darwin" });
      appLayer = createBehavioralAppLayer({ platform: "darwin" });

      const manager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      manager.updateBadge("all-working");

      expect(appLayer._getState().dockSetBadgeCalls).toEqual(["●"]);
    });

    it("shows half circle for mixed state", () => {
      const platformInfo = createMockPlatformInfo({ platform: "darwin" });
      appLayer = createBehavioralAppLayer({ platform: "darwin" });

      const manager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      manager.updateBadge("mixed");

      expect(appLayer._getState().dockSetBadgeCalls).toEqual(["◐"]);
    });

    it("clears badge for none state", () => {
      const platformInfo = createMockPlatformInfo({ platform: "darwin" });
      appLayer = createBehavioralAppLayer({ platform: "darwin" });

      const manager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      manager.updateBadge("none");

      expect(appLayer._getState().dockSetBadgeCalls).toEqual([""]);
    });
  });

  describe("updateBadge (win32)", () => {
    it("generates image for all-working state", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });

      const manager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      manager.updateBadge("all-working");

      // Verify image was created
      expect(imageLayer._getState().images.size).toBe(1);
      expect(windowManager.setOverlayIconCalls).toHaveLength(1);
      expect(windowManager.setOverlayIconCalls[0]?.description).toBe("All workspaces working");
    });

    it("generates image for mixed state", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });

      const manager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      manager.updateBadge("mixed");

      expect(imageLayer._getState().images.size).toBe(1);
      expect(windowManager.setOverlayIconCalls).toHaveLength(1);
      expect(windowManager.setOverlayIconCalls[0]?.description).toBe("Some workspaces ready");
    });

    it("clears overlay for none state", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });

      const manager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      manager.updateBadge("none");

      // No image created for "none"
      expect(imageLayer._getState().images.size).toBe(0);
      expect(windowManager.setOverlayIconCalls).toHaveLength(1);
      expect(windowManager.setOverlayIconCalls[0]?.image).toBeNull();
      expect(windowManager.setOverlayIconCalls[0]?.description).toBe("");
    });
  });

  describe("updateBadge (linux)", () => {
    it("sets badge count to 1 for all-working state", () => {
      const platformInfo = createMockPlatformInfo({ platform: "linux" });
      appLayer = createBehavioralAppLayer({ platform: "linux" });

      const manager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      manager.updateBadge("all-working");

      expect(appLayer._getState().setBadgeCountCalls).toEqual([1]);
    });

    it("sets badge count to 1 for mixed state", () => {
      const platformInfo = createMockPlatformInfo({ platform: "linux" });
      appLayer = createBehavioralAppLayer({ platform: "linux" });

      const manager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      manager.updateBadge("mixed");

      expect(appLayer._getState().setBadgeCountCalls).toEqual([1]);
    });

    it("clears badge for none state", () => {
      const platformInfo = createMockPlatformInfo({ platform: "linux" });
      appLayer = createBehavioralAppLayer({ platform: "linux" });

      const manager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      manager.updateBadge("none");

      expect(appLayer._getState().setBadgeCountCalls).toEqual([0]);
    });
  });

  describe("generateBadgeImage", () => {
    it("creates a 16x16 bitmap image for all-working", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });

      const manager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      manager.updateBadge("all-working");

      const state = imageLayer._getState();
      expect(state.images.size).toBe(1);
      const image = state.images.get("image-1");
      expect(image?.size).toEqual({ width: 16, height: 16 });
    });

    it("creates different images for different states", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });

      const manager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      manager.updateBadge("all-working");
      manager.updateBadge("mixed");

      // Should create 2 different images
      expect(imageLayer._getState().images.size).toBe(2);
    });
  });

  describe("image caching", () => {
    it("reuses cached images for same state", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });

      const manager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      // Update with same state multiple times
      manager.updateBadge("all-working");
      manager.updateBadge("all-working");
      manager.updateBadge("all-working");

      // Should only create image once
      expect(imageLayer._getState().images.size).toBe(1);

      // But all calls should update the overlay
      expect(windowManager.setOverlayIconCalls).toHaveLength(3);
    });

    it("creates new images for different states", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });

      const manager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      manager.updateBadge("all-working");
      manager.updateBadge("mixed");

      // Should create 2 different images
      expect(imageLayer._getState().images.size).toBe(2);
    });
  });

  describe("split circle image (behavioral mock)", () => {
    it("creates non-empty image for mixed state", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });

      const manager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      manager.updateBadge("mixed");

      const state = imageLayer._getState();
      const image = state.images.get("image-1");
      expect(image).toBeDefined();
      expect(image?.isEmpty).toBe(false);
    });
  });

  describe("solid red circle image (behavioral mock)", () => {
    it("creates non-empty image for all-working state", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });

      const manager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      manager.updateBadge("all-working");

      const state = imageLayer._getState();
      const image = state.images.get("image-1");
      expect(image).toBeDefined();
      expect(image?.isEmpty).toBe(false);
    });
  });

  describe("dispose", () => {
    it("releases all cached images", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });

      const manager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      // Create cached images for both states
      manager.updateBadge("all-working");
      manager.updateBadge("mixed");

      // Verify images are cached
      expect(imageLayer._getState().images.size).toBe(2);

      // Dispose should release all cached images
      manager.dispose();

      // Verify all images have been released
      expect(imageLayer._getState().images.size).toBe(0);
    });

    it("clears overlay on dispose", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });

      const manager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      // Show an overlay
      manager.updateBadge("all-working");
      expect(windowManager.setOverlayIconCalls).toHaveLength(1);

      // Dispose
      manager.dispose();

      // Should have cleared overlay (null image via disconnect)
      const lastCall = windowManager.setOverlayIconCalls.at(-1);
      expect(lastCall?.image).toBeNull();
    });

    it("is idempotent - can be called multiple times safely", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });

      const manager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      manager.updateBadge("all-working");

      // Call dispose multiple times - should not throw
      manager.dispose();
      manager.dispose();
      manager.dispose();

      expect(imageLayer._getState().images.size).toBe(0);
    });
  });
});
