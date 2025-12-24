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
    it("shows filled circle for all-working state", () => {
      const platformInfo = createMockPlatformInfo({ platform: "darwin" });
      const appApi = createMockElectronAppApi();
      const windowManager = createMockWindowManager();

      const manager = new BadgeManager(
        platformInfo,
        appApi,
        windowManager as unknown as WindowManager,
        createSilentLogger()
      );

      manager.updateBadge("all-working");

      expect(appApi.dockSetBadgeCalls).toEqual(["●"]);
    });

    it("shows half circle for mixed state", () => {
      const platformInfo = createMockPlatformInfo({ platform: "darwin" });
      const appApi = createMockElectronAppApi();
      const windowManager = createMockWindowManager();

      const manager = new BadgeManager(
        platformInfo,
        appApi,
        windowManager as unknown as WindowManager,
        createSilentLogger()
      );

      manager.updateBadge("mixed");

      expect(appApi.dockSetBadgeCalls).toEqual(["◐"]);
    });

    it("clears badge for none state", () => {
      const platformInfo = createMockPlatformInfo({ platform: "darwin" });
      const appApi = createMockElectronAppApi();
      const windowManager = createMockWindowManager();

      const manager = new BadgeManager(
        platformInfo,
        appApi,
        windowManager as unknown as WindowManager,
        createSilentLogger()
      );

      manager.updateBadge("none");

      expect(appApi.dockSetBadgeCalls).toEqual([""]);
    });
  });

  describe("updateBadge (win32)", () => {
    it("generates red circle image for all-working state", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });
      const appApi = createMockElectronAppApi();
      const windowManager = createMockWindowManager();

      const manager = new BadgeManager(
        platformInfo,
        appApi,
        windowManager as unknown as WindowManager,
        createSilentLogger()
      );

      manager.updateBadge("all-working");

      expect(mockNativeImage.createFromBitmap).toHaveBeenCalled();
      expect(windowManager.setOverlayIconCalls).toHaveLength(1);
      expect(windowManager.setOverlayIconCalls[0]?.image).not.toBeNull();
      expect(windowManager.setOverlayIconCalls[0]?.description).toBe("All workspaces working");
    });

    it("generates split circle image for mixed state", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });
      const appApi = createMockElectronAppApi();
      const windowManager = createMockWindowManager();

      const manager = new BadgeManager(
        platformInfo,
        appApi,
        windowManager as unknown as WindowManager,
        createSilentLogger()
      );

      manager.updateBadge("mixed");

      expect(mockNativeImage.createFromBitmap).toHaveBeenCalled();
      expect(windowManager.setOverlayIconCalls).toHaveLength(1);
      expect(windowManager.setOverlayIconCalls[0]?.image).not.toBeNull();
      expect(windowManager.setOverlayIconCalls[0]?.description).toBe("Some workspaces ready");
    });

    it("clears overlay for none state", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });
      const appApi = createMockElectronAppApi();
      const windowManager = createMockWindowManager();

      const manager = new BadgeManager(
        platformInfo,
        appApi,
        windowManager as unknown as WindowManager,
        createSilentLogger()
      );

      manager.updateBadge("none");

      expect(mockNativeImage.createFromBitmap).not.toHaveBeenCalled();
      expect(windowManager.setOverlayIconCalls).toHaveLength(1);
      expect(windowManager.setOverlayIconCalls[0]?.image).toBeNull();
      expect(windowManager.setOverlayIconCalls[0]?.description).toBe("");
    });
  });

  describe("updateBadge (linux)", () => {
    it("sets badge count to 1 for all-working state", () => {
      const platformInfo = createMockPlatformInfo({ platform: "linux" });
      const appApi = createMockElectronAppApi();
      const windowManager = createMockWindowManager();

      const manager = new BadgeManager(
        platformInfo,
        appApi,
        windowManager as unknown as WindowManager,
        createSilentLogger()
      );

      manager.updateBadge("all-working");

      expect(appApi.setBadgeCountCalls).toEqual([1]);
    });

    it("sets badge count to 1 for mixed state", () => {
      const platformInfo = createMockPlatformInfo({ platform: "linux" });
      const appApi = createMockElectronAppApi();
      const windowManager = createMockWindowManager();

      const manager = new BadgeManager(
        platformInfo,
        appApi,
        windowManager as unknown as WindowManager,
        createSilentLogger()
      );

      manager.updateBadge("mixed");

      expect(appApi.setBadgeCountCalls).toEqual([1]);
    });

    it("clears badge for none state", () => {
      const platformInfo = createMockPlatformInfo({ platform: "linux" });
      const appApi = createMockElectronAppApi();
      const windowManager = createMockWindowManager();

      const manager = new BadgeManager(
        platformInfo,
        appApi,
        windowManager as unknown as WindowManager,
        createSilentLogger()
      );

      manager.updateBadge("none");

      expect(appApi.setBadgeCountCalls).toEqual([0]);
    });
  });

  describe("generateBadgeImage", () => {
    it("creates a 16x16 bitmap image for all-working", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });
      const appApi = createMockElectronAppApi();
      const windowManager = createMockWindowManager();

      const manager = new BadgeManager(
        platformInfo,
        appApi,
        windowManager as unknown as WindowManager,
        createSilentLogger()
      );

      manager.updateBadge("all-working");

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

      manager.updateBadge("all-working");

      const calls = mockNativeImage.getCalls();
      const buffer = calls[0]?.[0];
      expect(buffer).toBeInstanceOf(Buffer);
      expect(buffer?.length).toBe(16 * 16 * 4); // BGRA format
    });

    it("creates different images for different states", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });
      const appApi = createMockElectronAppApi();
      const windowManager = createMockWindowManager();

      const manager = new BadgeManager(
        platformInfo,
        appApi,
        windowManager as unknown as WindowManager,
        createSilentLogger()
      );

      manager.updateBadge("all-working");
      manager.updateBadge("mixed");

      // Should create 2 different images
      expect(mockNativeImage.createFromBitmap).toHaveBeenCalledTimes(2);
    });
  });

  describe("image caching", () => {
    it("reuses cached images for same state", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });
      const appApi = createMockElectronAppApi();
      const windowManager = createMockWindowManager();

      const manager = new BadgeManager(
        platformInfo,
        appApi,
        windowManager as unknown as WindowManager,
        createSilentLogger()
      );

      // Update with same state multiple times
      manager.updateBadge("all-working");
      manager.updateBadge("all-working");
      manager.updateBadge("all-working");

      // Should only create image once
      expect(mockNativeImage.createFromBitmap).toHaveBeenCalledTimes(1);

      // But all calls should use the same image
      expect(windowManager.setOverlayIconCalls).toHaveLength(3);
      const firstImage = windowManager.setOverlayIconCalls[0]?.image;
      expect(windowManager.setOverlayIconCalls[1]?.image).toBe(firstImage);
      expect(windowManager.setOverlayIconCalls[2]?.image).toBe(firstImage);
    });

    it("creates new images for different states", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });
      const appApi = createMockElectronAppApi();
      const windowManager = createMockWindowManager();

      const manager = new BadgeManager(
        platformInfo,
        appApi,
        windowManager as unknown as WindowManager,
        createSilentLogger()
      );

      manager.updateBadge("all-working");
      manager.updateBadge("mixed");

      // Should create 2 different images
      expect(mockNativeImage.createFromBitmap).toHaveBeenCalledTimes(2);
    });
  });

  describe("split circle image", () => {
    it("has transparent gap at center column", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });
      const appApi = createMockElectronAppApi();
      const windowManager = createMockWindowManager();

      const manager = new BadgeManager(
        platformInfo,
        appApi,
        windowManager as unknown as WindowManager,
        createSilentLogger()
      );

      manager.updateBadge("mixed");

      const calls = mockNativeImage.getCalls();
      const buffer = calls[0]?.[0];
      expect(buffer).toBeInstanceOf(Buffer);

      // Check center column (x=8 in 16px image) for transparency
      // Center row (y=8) should have alpha=0 at the gap column
      const gapX = 8;
      const centerY = 8;
      const offset = (centerY * 16 + gapX) * 4;
      const alpha = buffer![offset + 3];

      expect(alpha).toBe(0); // Gap should be fully transparent
    });

    it("has green pixels on left side", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });
      const appApi = createMockElectronAppApi();
      const windowManager = createMockWindowManager();

      const manager = new BadgeManager(
        platformInfo,
        appApi,
        windowManager as unknown as WindowManager,
        createSilentLogger()
      );

      manager.updateBadge("mixed");

      const calls = mockNativeImage.getCalls();
      const buffer = calls[0]?.[0];
      expect(buffer).toBeInstanceOf(Buffer);

      // Check a pixel on the left side (x=5, y=8) - should be green
      const leftX = 5;
      const centerY = 8;
      const offset = (centerY * 16 + leftX) * 4;

      // Green color: #16A34A (R=22, G=163, B=74) in BGRA format
      const b = buffer![offset]!;
      const g = buffer![offset + 1]!;
      const r = buffer![offset + 2]!;
      const alpha = buffer![offset + 3]!;

      expect(b).toBe(74); // Blue = 74
      expect(g).toBe(163); // Green = 163
      expect(r).toBe(22); // Red = 22
      expect(alpha).toBeGreaterThan(0); // Should be visible
    });

    it("has red pixels on right side", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });
      const appApi = createMockElectronAppApi();
      const windowManager = createMockWindowManager();

      const manager = new BadgeManager(
        platformInfo,
        appApi,
        windowManager as unknown as WindowManager,
        createSilentLogger()
      );

      manager.updateBadge("mixed");

      const calls = mockNativeImage.getCalls();
      const buffer = calls[0]?.[0];
      expect(buffer).toBeInstanceOf(Buffer);

      // Check a pixel on the right side (x=11, y=8) - should be red
      const rightX = 11;
      const centerY = 8;
      const offset = (centerY * 16 + rightX) * 4;

      // Red color: #E51400 (R=229, G=20, B=0) in BGRA format
      const b = buffer![offset]!;
      const g = buffer![offset + 1]!;
      const r = buffer![offset + 2]!;
      const alpha = buffer![offset + 3]!;

      expect(b).toBe(0); // Blue = 0
      expect(g).toBe(20); // Green = 20
      expect(r).toBe(229); // Red = 229
      expect(alpha).toBeGreaterThan(0); // Should be visible
    });
  });

  describe("solid red circle image", () => {
    it("has red pixels throughout the circle", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });
      const appApi = createMockElectronAppApi();
      const windowManager = createMockWindowManager();

      const manager = new BadgeManager(
        platformInfo,
        appApi,
        windowManager as unknown as WindowManager,
        createSilentLogger()
      );

      manager.updateBadge("all-working");

      const calls = mockNativeImage.getCalls();
      const buffer = calls[0]?.[0];
      expect(buffer).toBeInstanceOf(Buffer);

      // Check center pixel (x=8, y=8) - should be red
      const centerX = 8;
      const centerY = 8;
      const offset = (centerY * 16 + centerX) * 4;

      // Red color: #E51400 (R=229, G=20, B=0) in BGRA format
      const b = buffer![offset]!;
      const g = buffer![offset + 1]!;
      const r = buffer![offset + 2]!;
      const alpha = buffer![offset + 3]!;

      expect(b).toBe(0); // Blue = 0
      expect(g).toBe(20); // Green = 20
      expect(r).toBe(229); // Red = 229
      expect(alpha).toBeGreaterThan(0); // Should be visible
    });
  });
});
