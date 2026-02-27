// @vitest-environment node

import { describe, it, expect, beforeEach } from "vitest";

import { BadgeManager } from "./badge-manager";
import { createMockPlatformInfo } from "../../services/platform/platform-info.test-utils";
import { SILENT_LOGGER } from "../../services/logging";
import { createAppLayerMock, type MockAppLayer } from "../../services/platform/app.state-mock";
import {
  createImageLayerMock,
  type MockImageLayer,
} from "../../services/platform/image.state-mock";
import type { WindowManager } from "./window-manager";
import type { ImageHandle } from "../../services/platform/types";

/**
 * Mock WindowManager for BadgeManager testing.
 */
interface MockWindowManager {
  setOverlayIcon: (image: ImageHandle | null, description: string) => void;
  setOverlayIconCalls: Array<{ image: ImageHandle | null; description: string }>;
}

function createMockWindowManager(): MockWindowManager {
  const setOverlayIconCalls: Array<{ image: ImageHandle | null; description: string }> = [];
  return {
    setOverlayIcon: (image: ImageHandle | null, description: string) => {
      setOverlayIconCalls.push({ image, description });
    },
    setOverlayIconCalls,
  };
}

describe("BadgeManager", () => {
  let appLayer: MockAppLayer;
  let imageLayer: MockImageLayer;
  let windowManager: MockWindowManager;

  beforeEach(() => {
    appLayer = createAppLayerMock();
    imageLayer = createImageLayerMock();
    windowManager = createMockWindowManager();
  });

  describe("updateBadge (darwin)", () => {
    it("shows filled circle for all-working state", () => {
      const platformInfo = createMockPlatformInfo({ platform: "darwin" });
      appLayer = createAppLayerMock({ platform: "darwin" });

      const manager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      manager.updateBadge("all-working");

      expect(appLayer).toHaveDockBadge("●");
    });

    it("shows half circle for mixed state", () => {
      const platformInfo = createMockPlatformInfo({ platform: "darwin" });
      appLayer = createAppLayerMock({ platform: "darwin" });

      const manager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      manager.updateBadge("mixed");

      expect(appLayer).toHaveDockBadge("◐");
    });

    it("clears badge for none state", () => {
      const platformInfo = createMockPlatformInfo({ platform: "darwin" });
      appLayer = createAppLayerMock({ platform: "darwin" });

      const manager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      manager.updateBadge("none");

      expect(appLayer).toHaveDockBadge("");
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

      expect(imageLayer).toHaveImages([{ id: "image-1" }]);
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

      expect(imageLayer).toHaveImages([{ id: "image-1" }]);
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

      expect(imageLayer).toHaveImages([]);
      expect(windowManager.setOverlayIconCalls).toHaveLength(1);
      expect(windowManager.setOverlayIconCalls[0]?.image).toBeNull();
      expect(windowManager.setOverlayIconCalls[0]?.description).toBe("");
    });

    it("creates image in shared ImageLayer that WindowLayer would use for lookup", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });
      appLayer = createAppLayerMock({ platform: "win32" });
      const sharedImageLayer = createImageLayerMock();

      let capturedImageHandle: ImageHandle | null = null;
      const mockWindowManager = {
        setOverlayIcon: (image: ImageHandle | null) => {
          capturedImageHandle = image;
        },
      };

      const manager = new BadgeManager(
        platformInfo,
        appLayer,
        sharedImageLayer,
        mockWindowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      manager.updateBadge("all-working");

      expect(capturedImageHandle).not.toBeNull();
      expect(sharedImageLayer).toHaveImage(capturedImageHandle!.id, {
        isEmpty: false,
        size: { width: 16, height: 16 },
      });
    });
  });

  describe("updateBadge (linux)", () => {
    it("sets badge count to 1 for all-working state", () => {
      const platformInfo = createMockPlatformInfo({ platform: "linux" });
      appLayer = createAppLayerMock({ platform: "linux" });

      const manager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      manager.updateBadge("all-working");

      expect(appLayer).toHaveBadgeCount(1);
    });

    it("sets badge count to 1 for mixed state", () => {
      const platformInfo = createMockPlatformInfo({ platform: "linux" });
      appLayer = createAppLayerMock({ platform: "linux" });

      const manager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      manager.updateBadge("mixed");

      expect(appLayer).toHaveBadgeCount(1);
    });

    it("clears badge for none state", () => {
      const platformInfo = createMockPlatformInfo({ platform: "linux" });
      appLayer = createAppLayerMock({ platform: "linux" });

      const manager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      manager.updateBadge("none");

      expect(appLayer).toHaveBadgeCount(0);
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

      expect(imageLayer).toHaveImage("image-1", { size: { width: 16, height: 16 } });
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

      expect(imageLayer).toHaveImages([{ id: "image-1" }, { id: "image-2" }]);
    });

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

      expect(imageLayer).toHaveImage("image-1", { isEmpty: false });
    });

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

      expect(imageLayer).toHaveImage("image-1", { isEmpty: false });
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

      manager.updateBadge("all-working");
      manager.updateBadge("all-working");
      manager.updateBadge("all-working");

      expect(imageLayer).toHaveImages([{ id: "image-1" }]);
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

      expect(imageLayer).toHaveImages([{ id: "image-1" }, { id: "image-2" }]);
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

      manager.updateBadge("all-working");
      manager.updateBadge("mixed");

      expect(imageLayer).toHaveImages([{ id: "image-1" }, { id: "image-2" }]);

      manager.dispose();

      expect(imageLayer).toHaveImages([]);
    });

    it("clears overlay on dispose (win32)", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });

      const manager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      manager.updateBadge("all-working");
      const callsAfterUpdate = windowManager.setOverlayIconCalls.length;
      expect(callsAfterUpdate).toBeGreaterThan(0);

      manager.dispose();

      const lastCall = windowManager.setOverlayIconCalls.at(-1);
      expect(lastCall?.image).toBeNull();
    });

    it("clears badge on dispose (darwin)", () => {
      const platformInfo = createMockPlatformInfo({ platform: "darwin" });
      appLayer = createAppLayerMock({ platform: "darwin" });

      const manager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      manager.updateBadge("all-working");
      expect(appLayer).toHaveDockBadge("●");

      manager.dispose();

      expect(appLayer).toHaveDockBadge("");
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

      manager.dispose();
      manager.dispose();
      manager.dispose();

      expect(imageLayer).toHaveImages([]);
    });
  });
});
