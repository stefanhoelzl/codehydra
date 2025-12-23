// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Electron nativeImage
const mockNativeImage = vi.hoisted(() => {
  const createFromBitmap = vi.fn((buffer: Buffer, options: { width: number; height: number }) => ({
    isEmpty: () => false,
    getSize: () => ({ width: options.width, height: options.height }),
    toPNG: () => Buffer.from("mock-png"),
    _buffer: buffer, // Store for testing
    _options: options, // Store for testing
  }));

  return {
    createFromBitmap,
    // Helper to get calls as properly typed array
    getCalls: () =>
      createFromBitmap.mock.calls as Array<[Buffer, { width: number; height: number }]>,
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

      expect(mockNativeImage.createFromBitmap).toHaveBeenCalled();
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

      expect(mockNativeImage.createFromBitmap).not.toHaveBeenCalled();
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
    it("creates a 16x16 bitmap image", () => {
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

      expect(mockNativeImage.createFromBitmap).toHaveBeenCalled();
      const calls = mockNativeImage.getCalls();
      expect(calls[0]?.[1]).toEqual({ width: 16, height: 16 });
    });

    it("creates bitmap buffer with correct size (16x16x4 = 1024 bytes)", () => {
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

      const calls = mockNativeImage.getCalls();
      const buffer = calls[0]?.[0];
      expect(buffer).toBeInstanceOf(Buffer);
      expect(buffer?.length).toBe(16 * 16 * 4); // BGRA format
    });

    it("handles single digit counts", () => {
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

      expect(mockNativeImage.createFromBitmap).toHaveBeenCalledTimes(1);
    });

    it("handles double digit counts", () => {
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

      expect(mockNativeImage.createFromBitmap).toHaveBeenCalledTimes(1);
    });

    it("handles 3+ digit counts by showing overflow indicator", () => {
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

      expect(mockNativeImage.createFromBitmap).toHaveBeenCalledTimes(1);
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
      expect(mockNativeImage.createFromBitmap).toHaveBeenCalledTimes(1);

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
      expect(mockNativeImage.createFromBitmap).toHaveBeenCalledTimes(3);
    });
  });
});
