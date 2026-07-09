/**
 * Integration tests for main process wiring.
 *
 * Tests the integration of BuildInfo, PlatformInfo, and PathProvider
 * which are wired together in main.ts.
 *
 * Note: The actual main.ts cannot be imported in tests due to
 * Electron dependencies, but we can test the wiring pattern it uses.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DefaultPathProvider } from "./boundaries/platform/path-provider";
import { createMockBuildInfo } from "./boundaries/platform/build-info.test-utils";
import { createMockPlatformInfo } from "./boundaries/platform/platform-info.test-utils";
import { createVscodiumIdeServer, VSCODIUM_VERSION } from "./modules/ide-server-module/vscodium";
import { OPENCODE_VERSION } from "./modules/agent-module/opencode/setup-info";
import { Path } from "./utils/path/path";
import type { PathProvider } from "./boundaries/platform/path-provider";
import type { SupportedPlatform } from "./boundaries/platform/platform-info";
import { ElectronBuildInfo } from "./boundaries/platform/electron-build-info";

// Mock __APP_VERSION__ global (Vite-injected constant)
vi.stubGlobal("__APP_VERSION__", "2026.01.01-dev.test1234");

// Mock __IS_DEV_BUILD__ global (Vite-injected constant)
vi.stubGlobal("__IS_DEV_BUILD__", true);

// Shared fake: __mocks__/electron.ts
vi.mock("electron");
import { appState, resetElectronFake } from "./test/mocks/electron";

describe("Main process wiring", () => {
  beforeEach(() => {
    resetElectronFake();
    vi.stubGlobal("__IS_DEV_BUILD__", true);
    // Clear _CH_BUNDLE_DIR to ensure tests use expected paths
    vi.stubEnv("_CH_BUNDLE_DIR", "");
  });

  afterEach(() => {
    resetElectronFake();
    vi.stubGlobal("__IS_DEV_BUILD__", true);
    vi.unstubAllEnvs();
  });

  describe("createIdeServerConfig pattern", () => {
    /**
     * This tests the same pattern used in main.ts createIdeServerConfig()
     * PathProvider now returns Path objects, so we convert to native strings for external use.
     * Uses dynamic bundlePath methods with version constants and setup-info functions.
     */
    interface TestIdeServerConfig {
      readonly binaryPath: string;
      readonly runtimeDir: string;
      readonly extensionsDir: string;
      readonly userDataDir: string;
      readonly binDir: string;
      readonly ideServerDir: string;
      readonly opencodeDir: string;
    }

    function createIdeServerConfig(
      pathProvider: PathProvider,
      platform: SupportedPlatform
    ): TestIdeServerConfig {
      const ideServerBinaryPath = new Path(
        pathProvider.bundlePath(`vscodium/${VSCODIUM_VERSION}`),
        createVscodiumIdeServer().executablePath(platform)
      ).toNative();

      return {
        binaryPath: ideServerBinaryPath,
        runtimeDir: pathProvider.dataPath("runtime").toNative(),
        extensionsDir: pathProvider.dataPath("vscode/extensions").toNative(),
        userDataDir: pathProvider.dataPath("vscode/user-data").toNative(),
        binDir: pathProvider.dataPath("bin").toNative(),
        ideServerDir: pathProvider.bundlePath(`vscodium/${VSCODIUM_VERSION}`).toNative(),
        opencodeDir: pathProvider.bundlePath(`opencode/${OPENCODE_VERSION}`).toNative(),
      };
    }

    it("returns paths from pathProvider in development mode", () => {
      const buildInfo = createMockBuildInfo({ isDevelopment: true });
      const platformInfo = createMockPlatformInfo({ platform: "linux" });
      const pathProvider = new DefaultPathProvider(buildInfo, platformInfo);

      const config = createIdeServerConfig(pathProvider, "linux");

      expect(config.runtimeDir).toMatch(/app-data[/\\]runtime$/);
      expect(config.extensionsDir).toMatch(/app-data[/\\]vscode[/\\]extensions$/);
      expect(config.userDataDir).toMatch(/app-data[/\\]vscode[/\\]user-data$/);
    });

    it.skipIf(process.platform !== "linux")(
      "returns paths from pathProvider in production mode",
      () => {
        const buildInfo = createMockBuildInfo({ isDevelopment: false, isPackaged: true });
        const platformInfo = createMockPlatformInfo({
          platform: "linux",
          homeDir: "/home/testuser",
        });
        const pathProvider = new DefaultPathProvider(buildInfo, platformInfo);

        const config = createIdeServerConfig(pathProvider, "linux");

        expect(config.runtimeDir).toBe("/home/testuser/.local/share/codehydra/runtime");
        expect(config.extensionsDir).toBe(
          "/home/testuser/.local/share/codehydra/vscode/extensions"
        );
        expect(config.userDataDir).toBe("/home/testuser/.local/share/codehydra/vscode/user-data");
      }
    );
  });

  describe("DevTools registration pattern", () => {
    it("isDevelopment reflects __IS_DEV_BUILD__ build-time flag", async () => {
      // This tests the pattern used in bootstrap():
      // if (buildInfo.isDevelopment) { ... register DevTools handler ... }
      // isDevelopment now comes from __IS_DEV_BUILD__, not app.isPackaged

      // Dev build (default __IS_DEV_BUILD__ = true)
      const devBuildInfo = new ElectronBuildInfo();
      expect(devBuildInfo.isDevelopment).toBe(true);

      // A packaged dev build still has isDevelopment = true
      appState.isPackaged = true;
      const packagedDevBuildInfo = new ElectronBuildInfo();
      expect(packagedDevBuildInfo.isDevelopment).toBe(true);
      expect(packagedDevBuildInfo.isPackaged).toBe(true);
    });
  });

  describe.skipIf(process.platform === "win32")("Full wiring chain (Darwin)", () => {
    it("BuildInfo -> PlatformInfo -> PathProvider -> services", () => {
      const buildInfo = createMockBuildInfo({ isDevelopment: false, isPackaged: true });
      const platformInfo = createMockPlatformInfo({
        platform: "darwin",
        homeDir: "/Users/test",
      });
      const pathProvider = new DefaultPathProvider(buildInfo, platformInfo);

      expect(pathProvider.dataPath("projects").toString()).toBe(
        "/Users/test/Library/Application Support/Codehydra/projects"
      );
      expect(pathProvider.dataPath("vscode").toString()).toBe(
        "/Users/test/Library/Application Support/Codehydra/vscode"
      );
      expect(pathProvider.dataPath("electron").toString()).toBe(
        "/Users/test/Library/Application Support/Codehydra/electron"
      );
    });
  });

  describe.skipIf(process.platform !== "linux")("Full wiring chain (Linux)", () => {
    it("getProjectWorkspacesDir works through the chain", () => {
      const buildInfo = createMockBuildInfo({ isDevelopment: false, isPackaged: true });
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
      const buildInfo = createMockBuildInfo({ isDevelopment: false, isPackaged: true });
      const platformInfo = createMockPlatformInfo({
        platform: "win32",
        homeDir: "C:/Users/test",
      });
      const pathProvider = new DefaultPathProvider(buildInfo, platformInfo);

      // Windows paths are normalized to lowercase by Path class
      expect(pathProvider.dataPath("projects").toString()).toBe(
        "c:/users/test/appdata/roaming/codehydra/projects"
      );
      expect(pathProvider.dataPath("vscode").toString()).toBe(
        "c:/users/test/appdata/roaming/codehydra/vscode"
      );
      expect(pathProvider.dataPath("electron").toString()).toBe(
        "c:/users/test/appdata/roaming/codehydra/electron"
      );
    });
  });
});
