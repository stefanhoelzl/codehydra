// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Store original platform
const originalPlatform = process.platform;

// Mock Electron app module
const mockApp = vi.hoisted(() => ({
  dock: {
    setBadge: vi.fn(),
  },
  setBadgeCount: vi.fn(() => true),
}));

vi.mock("electron", () => ({
  app: mockApp,
}));

import { DefaultElectronAppApi } from "./electron-app-api";

describe("DefaultElectronAppApi", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Restore original platform
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  describe("dock (macOS)", () => {
    it("provides dock.setBadge on macOS", () => {
      Object.defineProperty(process, "platform", { value: "darwin" });

      const appApi = new DefaultElectronAppApi();

      expect(appApi.dock).toBeDefined();
      appApi.dock?.setBadge("5");
      expect(mockApp.dock.setBadge).toHaveBeenCalledWith("5");
    });

    it("clears dock badge with empty string on macOS", () => {
      Object.defineProperty(process, "platform", { value: "darwin" });

      const appApi = new DefaultElectronAppApi();

      appApi.dock?.setBadge("");
      expect(mockApp.dock.setBadge).toHaveBeenCalledWith("");
    });

    it("returns undefined for dock on non-macOS platforms", () => {
      Object.defineProperty(process, "platform", { value: "linux" });

      const appApi = new DefaultElectronAppApi();

      expect(appApi.dock).toBeUndefined();
    });

    it("returns undefined for dock on Windows", () => {
      Object.defineProperty(process, "platform", { value: "win32" });

      const appApi = new DefaultElectronAppApi();

      expect(appApi.dock).toBeUndefined();
    });
  });

  describe("setBadgeCount", () => {
    it("delegates to app.setBadgeCount", () => {
      const appApi = new DefaultElectronAppApi();

      const result = appApi.setBadgeCount(5);

      expect(mockApp.setBadgeCount).toHaveBeenCalledWith(5);
      expect(result).toBe(true);
    });

    it("passes zero to clear badge", () => {
      const appApi = new DefaultElectronAppApi();

      appApi.setBadgeCount(0);

      expect(mockApp.setBadgeCount).toHaveBeenCalledWith(0);
    });

    it("returns false when setBadgeCount fails", () => {
      mockApp.setBadgeCount.mockReturnValueOnce(false);
      const appApi = new DefaultElectronAppApi();

      const result = appApi.setBadgeCount(5);

      expect(result).toBe(false);
    });
  });
});
