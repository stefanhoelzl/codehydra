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
import { Path } from "../services/platform/path";

// Track mock isPackaged value for ElectronBuildInfo tests
let mockIsPackaged = false;

// Mock __APP_VERSION__ global (Vite-injected constant)
vi.stubGlobal("__APP_VERSION__", "2026.01.01-dev.test1234");

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
        runtimeDir: new Path(pathProvider.dataRootDir, "runtime").toNative(),
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

    it.skipIf(process.platform !== "linux")(
      "returns paths from pathProvider in production mode",
      () => {
        const buildInfo = createMockBuildInfo({ isDevelopment: false });
        const platformInfo = createMockPlatformInfo({
          platform: "linux",
          homeDir: "/home/testuser",
        });
        const pathProvider = new DefaultPathProvider(buildInfo, platformInfo);

        const config = createCodeServerConfig(pathProvider);

        expect(config.runtimeDir).toBe("/home/testuser/.local/share/codehydra/runtime");
        expect(config.extensionsDir).toBe(
          "/home/testuser/.local/share/codehydra/vscode/extensions"
        );
        expect(config.userDataDir).toBe("/home/testuser/.local/share/codehydra/vscode/user-data");
      }
    );
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

  describe.skipIf(process.platform !== "darwin")("Full wiring chain (Darwin)", () => {
    it("BuildInfo -> PlatformInfo -> PathProvider -> services", () => {
      const buildInfo = createMockBuildInfo({ isDevelopment: false });
      const platformInfo = createMockPlatformInfo({
        platform: "darwin",
        homeDir: "/Users/test",
      });
      const pathProvider = new DefaultPathProvider(buildInfo, platformInfo);

      expect(pathProvider.dataRootDir.toString()).toBe(
        "/Users/test/Library/Application Support/Codehydra"
      );
      expect(pathProvider.projectsDir.toString()).toBe(
        "/Users/test/Library/Application Support/Codehydra/projects"
      );
      expect(pathProvider.vscodeDir.toString()).toBe(
        "/Users/test/Library/Application Support/Codehydra/vscode"
      );
      expect(pathProvider.electronDataDir.toString()).toBe(
        "/Users/test/Library/Application Support/Codehydra/electron"
      );
    });
  });

  describe.skipIf(process.platform !== "linux")("Full wiring chain (Linux)", () => {
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
      expect(workspacesDirStr.startsWith("/home/user/.local/share/codehydra/projects")).toBe(true);
    });
  });

  describe.skipIf(process.platform !== "win32")("Full wiring chain (Windows)", () => {
    it("BuildInfo -> PlatformInfo -> PathProvider -> services", () => {
      const buildInfo = createMockBuildInfo({ isDevelopment: false });
      const platformInfo = createMockPlatformInfo({
        platform: "win32",
        homeDir: "C:/Users/test",
      });
      const pathProvider = new DefaultPathProvider(buildInfo, platformInfo);

      // Windows paths are normalized to lowercase by Path class
      expect(pathProvider.dataRootDir.toString()).toBe("c:/users/test/appdata/roaming/codehydra");
      expect(pathProvider.projectsDir.toString()).toBe(
        "c:/users/test/appdata/roaming/codehydra/projects"
      );
      expect(pathProvider.vscodeDir.toString()).toBe(
        "c:/users/test/appdata/roaming/codehydra/vscode"
      );
      expect(pathProvider.electronDataDir.toString()).toBe(
        "c:/users/test/appdata/roaming/codehydra/electron"
      );
    });
  });
});
