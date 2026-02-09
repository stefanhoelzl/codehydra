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

describe("BadgeManager Integration", () => {
  let appLayer: MockAppLayer;
  let imageLayer: MockImageLayer;
  let windowManager: MockWindowManager;

  beforeEach(() => {
    appLayer = createAppLayerMock({ platform: "darwin" });
    imageLayer = createImageLayerMock();
    windowManager = createMockWindowManager();
  });

  describe("Badge state via updateBadge()", () => {
    it("shows no badge for none state", () => {
      const platformInfo = createMockPlatformInfo({ platform: "darwin" });

      const badgeManager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      badgeManager.updateBadge("none");
      expect(appLayer).toHaveDockBadge("");
    });

    it("shows red badge for all-working state", () => {
      const platformInfo = createMockPlatformInfo({ platform: "darwin" });

      const badgeManager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      badgeManager.updateBadge("all-working");
      expect(appLayer).toHaveDockBadge("\u25CF");
    });

    it("shows mixed badge for mixed state", () => {
      const platformInfo = createMockPlatformInfo({ platform: "darwin" });

      const badgeManager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      badgeManager.updateBadge("mixed");
      expect(appLayer).toHaveDockBadge("\u25D0");
    });
  });

  describe("Windows overlay icon", () => {
    it("creates image in same ImageLayer that WindowLayer would use for lookup", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });
      appLayer = createAppLayerMock({ platform: "win32" });
      const sharedImageLayer = createImageLayerMock();

      let capturedImageHandle: ImageHandle | null = null;
      const mockWindowManager = {
        setOverlayIcon: (image: ImageHandle | null) => {
          capturedImageHandle = image;
        },
      };

      const badgeManager = new BadgeManager(
        platformInfo,
        appLayer,
        sharedImageLayer,
        mockWindowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      badgeManager.updateBadge("all-working");

      expect(capturedImageHandle).not.toBeNull();
      expect(sharedImageLayer).toHaveImage(capturedImageHandle!.id, {
        isEmpty: false,
        size: { width: 16, height: 16 },
      });
    });

    it("generates image for mixed state", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });
      appLayer = createAppLayerMock({ platform: "win32" });

      const badgeManager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      badgeManager.updateBadge("mixed");

      expect(imageLayer).toHaveImages([{ id: "image-1" }]);
      expect(windowManager.setOverlayIconCalls).toHaveLength(1);
      expect(windowManager.setOverlayIconCalls[0]?.description).toBe("Some workspaces ready");
    });

    it("generates image for all-working state", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });
      appLayer = createAppLayerMock({ platform: "win32" });

      const badgeManager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      badgeManager.updateBadge("all-working");

      expect(imageLayer).toHaveImages([{ id: "image-1" }]);
      expect(windowManager.setOverlayIconCalls).toHaveLength(1);
      expect(windowManager.setOverlayIconCalls[0]?.description).toBe("All workspaces working");
    });
  });

  describe("dispose", () => {
    it("clears badge and releases images on dispose", () => {
      const platformInfo = createMockPlatformInfo({ platform: "darwin" });

      const badgeManager = new BadgeManager(
        platformInfo,
        appLayer,
        imageLayer,
        windowManager as unknown as WindowManager,
        SILENT_LOGGER
      );

      badgeManager.updateBadge("all-working");
      expect(appLayer).toHaveDockBadge("\u25CF");

      badgeManager.dispose();

      // Badge should be cleared
      expect(appLayer).toHaveDockBadge("");
    });
  });
});
