/**
 * Integration tests for main process wiring.
 *
 * Tests the integration of BuildInfo, PlatformInfo, and PathProvider
 * which are wired together in main/index.ts.
 *
 * Note: The actual main/index.ts cannot be imported in tests due to
 * Electron dependencies, but we can test the wiring pattern it uses.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DefaultPathProvider, type CodeServerConfig } from "../services";
import { createMockBuildInfo } from "../services/platform/build-info.test-utils";
import { createMockPlatformInfo } from "../services/platform/platform-info.test-utils";
import nodePath from "node:path";

// Track mock isPackaged value for ElectronBuildInfo tests
let mockIsPackaged = false;

// Mock Electron app module with getters and methods
vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return mockIsPackaged;
    },
    getAppPath() {
      return "/mock/app/path";
    },
    getVersion: () => "1.0.0-test",
  },
}));

describe("Main process wiring", () => {
  beforeEach(() => {
    mockIsPackaged = false;
  });

  afterEach(() => {
    mockIsPackaged = false;
  });

  describe("createCodeServerConfig pattern", () => {
    /**
     * This tests the same pattern used in main/index.ts createCodeServerConfig()
     * PathProvider now returns Path objects, so we convert to native strings for external use.
     */
    function createCodeServerConfig(pathProvider: DefaultPathProvider): CodeServerConfig {
      return {
        binaryPath: pathProvider.codeServerBinaryPath.toNative(),
        runtimeDir: nodePath.join(pathProvider.dataRootDir.toNative(), "runtime"),
        extensionsDir: pathProvider.vscodeExtensionsDir.toNative(),
        userDataDir: pathProvider.vscodeUserDataDir.toNative(),
        binDir: pathProvider.binDir.toNative(),
      };
    }

    it("returns paths from pathProvider in development mode", () => {
      const buildInfo = createMockBuildInfo({ isDevelopment: true });
      const platformInfo = createMockPlatformInfo({ platform: "linux" });
      const pathProvider = new DefaultPathProvider(buildInfo, platformInfo);

      const config = createCodeServerConfig(pathProvider);

      expect(config.runtimeDir).toMatch(/app-data[/\\]runtime$/);
      expect(config.extensionsDir).toMatch(/app-data[/\\]vscode[/\\]extensions$/);
      expect(config.userDataDir).toMatch(/app-data[/\\]vscode[/\\]user-data$/);
    });

    it("returns paths from pathProvider in production mode", () => {
      const buildInfo = createMockBuildInfo({ isDevelopment: false });
      const platformInfo = createMockPlatformInfo({
        platform: "linux",
        homeDir: "/home/testuser",
      });
      const pathProvider = new DefaultPathProvider(buildInfo, platformInfo);

      const config = createCodeServerConfig(pathProvider);

      expect(config.runtimeDir).toBe(
        nodePath.join("/home/testuser", ".local", "share", "codehydra", "runtime")
      );
      expect(config.extensionsDir).toBe(
        nodePath.join("/home/testuser", ".local", "share", "codehydra", "vscode", "extensions")
      );
      expect(config.userDataDir).toBe(
        nodePath.join("/home/testuser", ".local", "share", "codehydra", "vscode", "user-data")
      );
    });
  });

  describe("DevTools registration pattern", () => {
    it("isDevelopment controls DevTools availability", async () => {
      // This tests the pattern used in bootstrap():
      // if (buildInfo.isDevelopment) { ... register DevTools handler ... }

      // Import ElectronBuildInfo which uses the mocked app.isPackaged
      mockIsPackaged = false;
      const { ElectronBuildInfo } = await import("./build-info");

      const devBuildInfo = new ElectronBuildInfo();
      expect(devBuildInfo.isDevelopment).toBe(true);

      // Change mock for production
      mockIsPackaged = true;
      // Need to create a new instance to get the new value
      const prodBuildInfo = new ElectronBuildInfo();
      expect(prodBuildInfo.isDevelopment).toBe(false);
    });
  });

  describe("Full wiring chain", () => {
    it("BuildInfo -> PlatformInfo -> PathProvider -> services", () => {
      // This tests the full chain as wired in main/index.ts
      // PathProvider now returns Path objects
      const buildInfo = createMockBuildInfo({ isDevelopment: false });
      const platformInfo = createMockPlatformInfo({
        platform: "darwin",
        homeDir: "/Users/test",
      });
      const pathProvider = new DefaultPathProvider(buildInfo, platformInfo);

      // Verify all derived paths are correct using .toString() for comparison
      expect(pathProvider.dataRootDir.toString()).toBe(
        nodePath.join("/Users/test", "Library", "Application Support", "Codehydra")
      );
      expect(pathProvider.projectsDir.toString()).toBe(
        nodePath.join("/Users/test", "Library", "Application Support", "Codehydra", "projects")
      );
      expect(pathProvider.vscodeDir.toString()).toBe(
        nodePath.join("/Users/test", "Library", "Application Support", "Codehydra", "vscode")
      );
      expect(pathProvider.electronDataDir.toString()).toBe(
        nodePath.join("/Users/test", "Library", "Application Support", "Codehydra", "electron")
      );
    });

    it("getProjectWorkspacesDir works through the chain", () => {
      const buildInfo = createMockBuildInfo({ isDevelopment: false });
      const platformInfo = createMockPlatformInfo({
        platform: "linux",
        homeDir: "/home/user",
      });
      const pathProvider = new DefaultPathProvider(buildInfo, platformInfo);

      const workspacesDir = pathProvider.getProjectWorkspacesDir("/home/user/myproject");
      const workspacesDirStr = workspacesDir.toString();

      expect(workspacesDirStr).toContain("myproject-");
      expect(workspacesDirStr).toMatch(/workspaces$/);
      const expectedPrefix = nodePath.join(
        "/home/user",
        ".local",
        "share",
        "codehydra",
        "projects"
      );
      expect(workspacesDirStr.startsWith(expectedPrefix)).toBe(true);
    });
  });
});
