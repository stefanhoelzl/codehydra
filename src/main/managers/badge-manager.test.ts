// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Electron nativeImage
const mockNativeImage = vi.hoisted(() => {
  const createFromDataURL = vi.fn((url: string) => ({
    isEmpty: () => false,
    toDataURL: () => "data:image/png;base64,mock",
    _sourceUrl: url, // Store for testing
  }));

  return {
    createFromDataURL,
    // Helper to get calls as properly typed array
    getCalls: () => createFromDataURL.mock.calls as Array<[string]>,
  };
});

vi.mock("electron", () => ({
  nativeImage: mockNativeImage,
}));

import { BadgeManager } from "./badge-manager";
import { createMockPlatformInfo } from "../../services/platform/platform-info.test-utils";
import { createSilentLogger } from "../../services/logging";
import {
  createMockElectronAppApi,
  createMockWindowManagerForBadge as createMockWindowManager,
} from "./badge-manager.test-utils";
import type { WindowManager } from "./window-manager";

describe("BadgeManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("updateBadge (darwin)", () => {
    it("calls appApi.dock.setBadge with correct string", () => {
      const platformInfo = createMockPlatformInfo({ platform: "darwin" });
      const appApi = createMockElectronAppApi();
      const windowManager = createMockWindowManager();

      const manager = new BadgeManager(
        platformInfo,
        appApi,
        windowManager as unknown as WindowManager,
        createSilentLogger()
      );

      manager.updateBadge(5);

      expect(appApi.dockSetBadgeCalls).toEqual(["5"]);
    });

    it("clears badge with empty string when count is 0", () => {
      const platformInfo = createMockPlatformInfo({ platform: "darwin" });
      const appApi = createMockElectronAppApi();
      const windowManager = createMockWindowManager();

      const manager = new BadgeManager(
        platformInfo,
        appApi,
        windowManager as unknown as WindowManager,
        createSilentLogger()
      );

      manager.updateBadge(0);

      expect(appApi.dockSetBadgeCalls).toEqual([""]);
    });

    it("shows large counts correctly", () => {
      const platformInfo = createMockPlatformInfo({ platform: "darwin" });
      const appApi = createMockElectronAppApi();
      const windowManager = createMockWindowManager();

      const manager = new BadgeManager(
        platformInfo,
        appApi,
        windowManager as unknown as WindowManager,
        createSilentLogger()
      );

      manager.updateBadge(42);

      expect(appApi.dockSetBadgeCalls).toEqual(["42"]);
    });
  });

  describe("updateBadge (win32)", () => {
    it("generates image and calls setOverlayIcon", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });
      const appApi = createMockElectronAppApi();
      const windowManager = createMockWindowManager();

      const manager = new BadgeManager(
        platformInfo,
        appApi,
        windowManager as unknown as WindowManager,
        createSilentLogger()
      );

      manager.updateBadge(3);

      expect(mockNativeImage.createFromDataURL).toHaveBeenCalled();
      expect(windowManager.setOverlayIconCalls).toHaveLength(1);
      expect(windowManager.setOverlayIconCalls[0]?.image).not.toBeNull();
      expect(windowManager.setOverlayIconCalls[0]?.description).toBe("3 idle workspaces");
    });

    it("uses singular form for count of 1", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });
      const appApi = createMockElectronAppApi();
      const windowManager = createMockWindowManager();

      const manager = new BadgeManager(
        platformInfo,
        appApi,
        windowManager as unknown as WindowManager,
        createSilentLogger()
      );

      manager.updateBadge(1);

      expect(windowManager.setOverlayIconCalls[0]?.description).toBe("1 idle workspace");
    });

    it("clears overlay when count is 0", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });
      const appApi = createMockElectronAppApi();
      const windowManager = createMockWindowManager();

      const manager = new BadgeManager(
        platformInfo,
        appApi,
        windowManager as unknown as WindowManager,
        createSilentLogger()
      );

      manager.updateBadge(0);

      expect(mockNativeImage.createFromDataURL).not.toHaveBeenCalled();
      expect(windowManager.setOverlayIconCalls).toHaveLength(1);
      expect(windowManager.setOverlayIconCalls[0]?.image).toBeNull();
      expect(windowManager.setOverlayIconCalls[0]?.description).toBe("");
    });
  });

  describe("updateBadge (linux)", () => {
    it("calls appApi.setBadgeCount", () => {
      const platformInfo = createMockPlatformInfo({ platform: "linux" });
      const appApi = createMockElectronAppApi();
      const windowManager = createMockWindowManager();

      const manager = new BadgeManager(
        platformInfo,
        appApi,
        windowManager as unknown as WindowManager,
        createSilentLogger()
      );

      manager.updateBadge(5);

      expect(appApi.setBadgeCountCalls).toEqual([5]);
    });

    it("clears badge with 0", () => {
      const platformInfo = createMockPlatformInfo({ platform: "linux" });
      const appApi = createMockElectronAppApi();
      const windowManager = createMockWindowManager();

      const manager = new BadgeManager(
        platformInfo,
        appApi,
        windowManager as unknown as WindowManager,
        createSilentLogger()
      );

      manager.updateBadge(0);

      expect(appApi.setBadgeCountCalls).toEqual([0]);
    });
  });

  describe("updateBadge (negative count)", () => {
    it("treats negative as 0 (defensive)", () => {
      const platformInfo = createMockPlatformInfo({ platform: "darwin" });
      const appApi = createMockElectronAppApi();
      const windowManager = createMockWindowManager();

      const manager = new BadgeManager(
        platformInfo,
        appApi,
        windowManager as unknown as WindowManager,
        createSilentLogger()
      );

      manager.updateBadge(-5);

      expect(appApi.dockSetBadgeCalls).toEqual([""]);
    });
  });

  describe("generateBadgeImage", () => {
    /**
     * Helper to get the SVG content from the mock call.
     */
    function getSvgFromMockCall(): string {
      const calls = mockNativeImage.getCalls();
      expect(calls.length).toBeGreaterThan(0);
      const lastCall = calls[calls.length - 1];
      expect(lastCall).toBeDefined();
      const dataUrl = lastCall![0];
      return Buffer.from(dataUrl.replace("data:image/svg+xml;base64,", ""), "base64").toString(
        "utf8"
      );
    }

    it("returns valid NativeImage", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });
      const appApi = createMockElectronAppApi();
      const windowManager = createMockWindowManager();

      const manager = new BadgeManager(
        platformInfo,
        appApi,
        windowManager as unknown as WindowManager,
        createSilentLogger()
      );

      manager.updateBadge(5);

      expect(mockNativeImage.createFromDataURL).toHaveBeenCalled();
      const calls = mockNativeImage.getCalls();
      expect(calls[0]?.[0]).toMatch(/^data:image\/svg\+xml;base64,/);
    });

    it("adjusts font size for 1-digit counts", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });
      const appApi = createMockElectronAppApi();
      const windowManager = createMockWindowManager();

      const manager = new BadgeManager(
        platformInfo,
        appApi,
        windowManager as unknown as WindowManager,
        createSilentLogger()
      );

      manager.updateBadge(5);

      const svg = getSvgFromMockCall();
      expect(svg).toContain('font-size="10"');
    });

    it("adjusts font size for 2-digit counts", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });
      const appApi = createMockElectronAppApi();
      const windowManager = createMockWindowManager();

      const manager = new BadgeManager(
        platformInfo,
        appApi,
        windowManager as unknown as WindowManager,
        createSilentLogger()
      );

      manager.updateBadge(42);

      const svg = getSvgFromMockCall();
      expect(svg).toContain('font-size="8"');
    });

    it("adjusts font size for 3+ digit counts", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });
      const appApi = createMockElectronAppApi();
      const windowManager = createMockWindowManager();

      const manager = new BadgeManager(
        platformInfo,
        appApi,
        windowManager as unknown as WindowManager,
        createSilentLogger()
      );

      manager.updateBadge(123);

      const svg = getSvgFromMockCall();
      expect(svg).toContain('font-size="6"');
    });
  });

  describe("image caching", () => {
    it("reuses cached images for same count", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });
      const appApi = createMockElectronAppApi();
      const windowManager = createMockWindowManager();

      const manager = new BadgeManager(
        platformInfo,
        appApi,
        windowManager as unknown as WindowManager,
        createSilentLogger()
      );

      // Update with same count multiple times
      manager.updateBadge(5);
      manager.updateBadge(5);
      manager.updateBadge(5);

      // Should only create image once
      expect(mockNativeImage.createFromDataURL).toHaveBeenCalledTimes(1);

      // But all calls should use the same image
      expect(windowManager.setOverlayIconCalls).toHaveLength(3);
      const firstImage = windowManager.setOverlayIconCalls[0]?.image;
      expect(windowManager.setOverlayIconCalls[1]?.image).toBe(firstImage);
      expect(windowManager.setOverlayIconCalls[2]?.image).toBe(firstImage);
    });

    it("creates new images for different counts", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });
      const appApi = createMockElectronAppApi();
      const windowManager = createMockWindowManager();

      const manager = new BadgeManager(
        platformInfo,
        appApi,
        windowManager as unknown as WindowManager,
        createSilentLogger()
      );

      manager.updateBadge(1);
      manager.updateBadge(2);
      manager.updateBadge(3);

      // Should create 3 different images
      expect(mockNativeImage.createFromDataURL).toHaveBeenCalledTimes(3);
    });
  });
});
