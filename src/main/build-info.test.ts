/**
 * Tests for ElectronBuildInfo.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Track mock state values using vi.hoisted
const { mockState } = vi.hoisted(() => {
  const state = { isPackaged: false, appPath: "/mock/app/path" };
  return { mockState: state };
});

// Mock __APP_VERSION__ global (Vite-injected constant)
vi.stubGlobal("__APP_VERSION__", "2026.01.01-dev.test1234");

// Mock __IS_DEV_BUILD__ global (Vite-injected constant)
vi.stubGlobal("__IS_DEV_BUILD__", true);

// Mock Electron app module with getters
vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return mockState.isPackaged;
    },
    getAppPath() {
      return mockState.appPath;
    },
    getVersion: () => "1.2.3-test",
  },
}));

import { ElectronBuildInfo } from "./build-info";

describe("ElectronBuildInfo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.isPackaged = false;
  });

  afterEach(() => {
    mockState.isPackaged = false;
  });

  describe("version", () => {
    it("returns __APP_VERSION__ (Vite-injected)", () => {
      const buildInfo = new ElectronBuildInfo();

      expect(buildInfo.version).toBe("2026.01.01-dev.test1234");
    });
  });

  describe("isDevelopment", () => {
    it("reflects __IS_DEV_BUILD__ build-time constant", () => {
      // __IS_DEV_BUILD__ is stubbed as true
      const buildInfo = new ElectronBuildInfo();

      expect(buildInfo.isDevelopment).toBe(true);
    });

    it("is independent of app.isPackaged", () => {
      // Even when packaged, isDevelopment reflects the build-time flag
      mockState.isPackaged = true;

      const buildInfo = new ElectronBuildInfo();

      expect(buildInfo.isDevelopment).toBe(true);
      expect(buildInfo.isPackaged).toBe(true);
    });
  });

  describe("isPackaged", () => {
    it("returns false when app is not packaged", () => {
      mockState.isPackaged = false;

      const buildInfo = new ElectronBuildInfo();

      expect(buildInfo.isPackaged).toBe(false);
    });

    it("returns true when app is packaged", () => {
      mockState.isPackaged = true;

      const buildInfo = new ElectronBuildInfo();

      expect(buildInfo.isPackaged).toBe(true);
    });

    it("caches the value at construction time", () => {
      mockState.isPackaged = false;
      const buildInfo = new ElectronBuildInfo();

      // Change the mock value after construction
      mockState.isPackaged = true;

      // Should still return the original cached value
      expect(buildInfo.isPackaged).toBe(false);
    });
  });

  describe("appPath", () => {
    it("returns the app path from Electron", () => {
      mockState.appPath = "/test/electron/app";

      const buildInfo = new ElectronBuildInfo();

      expect(buildInfo.appPath).toBe("/test/electron/app");
    });

    it("is available in both packaged and unpackaged mode", () => {
      mockState.appPath = "/some/path";

      mockState.isPackaged = false;
      const devInfo = new ElectronBuildInfo();

      mockState.isPackaged = true;
      const prodInfo = new ElectronBuildInfo();

      expect(devInfo.appPath).toBe("/some/path");
      expect(prodInfo.appPath).toBe("/some/path");
    });
  });

  describe("gitBranch", () => {
    it("returns the git branch name when not packaged", () => {
      mockState.isPackaged = false;
      const mockGetBranch = vi.fn(() => "feature/my-branch");

      const buildInfo = new ElectronBuildInfo(mockGetBranch);

      expect(buildInfo.gitBranch).toBe("feature/my-branch");
      expect(mockGetBranch).toHaveBeenCalledOnce();
    });

    it("returns undefined when packaged", () => {
      mockState.isPackaged = true;
      const mockGetBranch = vi.fn(() => "should-not-be-called");

      const buildInfo = new ElectronBuildInfo(mockGetBranch);

      expect(buildInfo.gitBranch).toBeUndefined();
      expect(mockGetBranch).not.toHaveBeenCalled();
    });

    it("returns 'unknown branch' when git function returns it", () => {
      mockState.isPackaged = false;
      const mockGetBranch = vi.fn(() => "unknown branch");

      const buildInfo = new ElectronBuildInfo(mockGetBranch);

      expect(buildInfo.gitBranch).toBe("unknown branch");
    });

    it("uses default getGitBranch function when not provided", () => {
      mockState.isPackaged = false;

      // This test runs the real getGitBranch function
      // which will return the actual branch or "unknown branch"
      const buildInfo = new ElectronBuildInfo();

      // gitBranch should be a non-empty string
      expect(buildInfo.gitBranch).toBeDefined();
      expect(typeof buildInfo.gitBranch).toBe("string");
      expect(buildInfo.gitBranch!.length).toBeGreaterThan(0);
    });
  });
});
