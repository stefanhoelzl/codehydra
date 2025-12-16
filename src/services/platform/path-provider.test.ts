/**
 * Tests for PathProvider interface, mock factory, and DefaultPathProvider.
 */

import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { createMockPathProvider } from "./path-provider.test-utils";
import { DefaultPathProvider, type PathProvider } from "./path-provider";
import { createMockBuildInfo } from "./build-info.test-utils";
import { createMockPlatformInfo } from "./platform-info.test-utils";

describe("createMockPathProvider", () => {
  it("returns sensible default paths", () => {
    const pathProvider = createMockPathProvider();

    expect(pathProvider.dataRootDir).toBe("/test/app-data");
    expect(pathProvider.projectsDir).toBe("/test/app-data/projects");
    expect(pathProvider.vscodeDir).toBe("/test/app-data/vscode");
    expect(pathProvider.vscodeExtensionsDir).toBe("/test/app-data/vscode/extensions");
    expect(pathProvider.vscodeUserDataDir).toBe("/test/app-data/vscode/user-data");
    expect(pathProvider.vscodeSetupMarkerPath).toBe("/test/app-data/vscode/.setup-completed");
    expect(pathProvider.electronDataDir).toBe("/test/app-data/electron");
    expect(pathProvider.vscodeAssetsDir).toBe("/mock/assets");
    expect(pathProvider.appIconPath).toBe("/test/resources/icon.png");
    expect(pathProvider.binDir).toBe("/test/app-data/bin");
  });

  it("accepts override for individual paths", () => {
    const pathProvider = createMockPathProvider({
      dataRootDir: "/custom/root",
      vscodeDir: "/custom/vscode",
    });

    expect(pathProvider.dataRootDir).toBe("/custom/root");
    expect(pathProvider.vscodeDir).toBe("/custom/vscode");
    // Other paths should still be defaults
    expect(pathProvider.projectsDir).toBe("/test/app-data/projects");
  });

  it("allows overriding all paths", () => {
    const pathProvider = createMockPathProvider({
      dataRootDir: "/a",
      projectsDir: "/b",
      vscodeDir: "/c",
      vscodeExtensionsDir: "/d",
      vscodeUserDataDir: "/e",
      vscodeSetupMarkerPath: "/f",
      electronDataDir: "/g",
      vscodeAssetsDir: "/h",
      appIconPath: "/h/icon.png",
      binDir: "/i",
    });

    expect(pathProvider.dataRootDir).toBe("/a");
    expect(pathProvider.projectsDir).toBe("/b");
    expect(pathProvider.vscodeDir).toBe("/c");
    expect(pathProvider.vscodeExtensionsDir).toBe("/d");
    expect(pathProvider.vscodeUserDataDir).toBe("/e");
    expect(pathProvider.vscodeSetupMarkerPath).toBe("/f");
    expect(pathProvider.electronDataDir).toBe("/g");
    expect(pathProvider.vscodeAssetsDir).toBe("/h");
    expect(pathProvider.appIconPath).toBe("/h/icon.png");
    expect(pathProvider.binDir).toBe("/i");
  });

  it("getProjectWorkspacesDir returns path with project hash", () => {
    const pathProvider = createMockPathProvider();

    const result = pathProvider.getProjectWorkspacesDir("/home/user/myproject");

    // Uses projectDirName internally: <name>-<8-char-hash>
    expect(result).toContain("myproject-");
    expect(result).toContain("/workspaces");
    expect(result.startsWith("/test/app-data/projects/")).toBe(true);
  });

  it("getProjectWorkspacesDir can be overridden", () => {
    const pathProvider = createMockPathProvider({
      getProjectWorkspacesDir: () => "/custom/workspaces",
    });

    expect(pathProvider.getProjectWorkspacesDir("/any/path")).toBe("/custom/workspaces");
  });

  it("returns object satisfying PathProvider interface", () => {
    const pathProvider: PathProvider = createMockPathProvider();

    // TypeScript ensures type compatibility at compile time
    // This test verifies the interface is implemented correctly
    expect(typeof pathProvider.dataRootDir).toBe("string");
    expect(typeof pathProvider.projectsDir).toBe("string");
    expect(typeof pathProvider.vscodeDir).toBe("string");
    expect(typeof pathProvider.vscodeExtensionsDir).toBe("string");
    expect(typeof pathProvider.vscodeUserDataDir).toBe("string");
    expect(typeof pathProvider.vscodeSetupMarkerPath).toBe("string");
    expect(typeof pathProvider.electronDataDir).toBe("string");
    expect(typeof pathProvider.vscodeAssetsDir).toBe("string");
    expect(typeof pathProvider.appIconPath).toBe("string");
    expect(typeof pathProvider.binDir).toBe("string");
    expect(typeof pathProvider.getProjectWorkspacesDir).toBe("function");
  });
});

describe("DefaultPathProvider", () => {
  describe("development mode", () => {
    it("returns ./app-data/ based paths", () => {
      const buildInfo = createMockBuildInfo({ isDevelopment: true, appPath: "/test/app" });
      const platformInfo = createMockPlatformInfo({ platform: "linux" });
      const pathProvider = new DefaultPathProvider(buildInfo, platformInfo);

      // In dev mode, uses process.cwd() + ./app-data/
      // We can't predict exact cwd, but we can verify the structure
      expect(pathProvider.dataRootDir).toMatch(/app-data$/);
      expect(pathProvider.projectsDir).toMatch(/app-data[/\\]projects$/);
      expect(pathProvider.vscodeDir).toMatch(/app-data[/\\]vscode$/);
      expect(pathProvider.vscodeExtensionsDir).toMatch(/app-data[/\\]vscode[/\\]extensions$/);
      expect(pathProvider.vscodeUserDataDir).toMatch(/app-data[/\\]vscode[/\\]user-data$/);
      expect(pathProvider.vscodeSetupMarkerPath).toMatch(
        /app-data[/\\]vscode[/\\]\.setup-completed$/
      );
      expect(pathProvider.electronDataDir).toMatch(/app-data[/\\]electron$/);
      expect(pathProvider.appIconPath).toMatch(/resources[/\\]icon\.png$/);
      expect(pathProvider.binDir).toMatch(/app-data[/\\]bin$/);
    });

    it("returns vscodeAssetsDir based on appPath", () => {
      const buildInfo = createMockBuildInfo({ isDevelopment: true, appPath: "/dev/project" });
      const platformInfo = createMockPlatformInfo({ platform: "linux" });
      const pathProvider = new DefaultPathProvider(buildInfo, platformInfo);

      expect(pathProvider.vscodeAssetsDir).toBe("/dev/project/out/main/assets");
    });

    it("ignores platform in development mode", () => {
      const buildInfo = createMockBuildInfo({ isDevelopment: true, appPath: "/test/app" });

      // All platforms should get the same dev path structure
      const linuxProvider = new DefaultPathProvider(
        buildInfo,
        createMockPlatformInfo({ platform: "linux", homeDir: "/home/test" })
      );
      const darwinProvider = new DefaultPathProvider(
        buildInfo,
        createMockPlatformInfo({ platform: "darwin", homeDir: "/Users/test" })
      );
      const win32Provider = new DefaultPathProvider(
        buildInfo,
        createMockPlatformInfo({ platform: "win32", homeDir: "C:\\Users\\test" })
      );

      // All should use ./app-data/ structure (relative to cwd)
      expect(linuxProvider.dataRootDir).toMatch(/app-data$/);
      expect(darwinProvider.dataRootDir).toMatch(/app-data$/);
      expect(win32Provider.dataRootDir).toMatch(/app-data$/);
    });
  });

  describe("production mode - Linux", () => {
    it("returns ~/.local/share/codehydra/ based paths", () => {
      const buildInfo = createMockBuildInfo({
        isDevelopment: false,
        appPath: "/opt/codehydra/resources/app.asar",
      });
      const platformInfo = createMockPlatformInfo({
        platform: "linux",
        homeDir: "/home/testuser",
      });
      const pathProvider = new DefaultPathProvider(buildInfo, platformInfo);

      expect(pathProvider.dataRootDir).toBe("/home/testuser/.local/share/codehydra");
      expect(pathProvider.projectsDir).toBe("/home/testuser/.local/share/codehydra/projects");
      expect(pathProvider.vscodeDir).toBe("/home/testuser/.local/share/codehydra/vscode");
      expect(pathProvider.vscodeExtensionsDir).toBe(
        "/home/testuser/.local/share/codehydra/vscode/extensions"
      );
      expect(pathProvider.vscodeUserDataDir).toBe(
        "/home/testuser/.local/share/codehydra/vscode/user-data"
      );
      expect(pathProvider.vscodeSetupMarkerPath).toBe(
        "/home/testuser/.local/share/codehydra/vscode/.setup-completed"
      );
      expect(pathProvider.electronDataDir).toBe("/home/testuser/.local/share/codehydra/electron");
      expect(pathProvider.vscodeAssetsDir).toBe(
        "/opt/codehydra/resources/app.asar/out/main/assets"
      );
      expect(pathProvider.binDir).toBe("/home/testuser/.local/share/codehydra/bin");
    });

    it("binDir is under dataRootDir", () => {
      const buildInfo = createMockBuildInfo({
        isDevelopment: false,
        appPath: "/opt/codehydra/resources/app.asar",
      });
      const platformInfo = createMockPlatformInfo({
        platform: "linux",
        homeDir: "/home/testuser",
      });
      const pathProvider = new DefaultPathProvider(buildInfo, platformInfo);

      expect(pathProvider.binDir.startsWith(pathProvider.dataRootDir)).toBe(true);
    });
  });

  describe("production mode - macOS", () => {
    it("returns ~/Library/Application Support/Codehydra/ based paths", () => {
      const buildInfo = createMockBuildInfo({
        isDevelopment: false,
        appPath: "/Applications/Codehydra.app/Contents/Resources/app.asar",
      });
      const platformInfo = createMockPlatformInfo({
        platform: "darwin",
        homeDir: "/Users/testuser",
      });
      const pathProvider = new DefaultPathProvider(buildInfo, platformInfo);

      expect(pathProvider.dataRootDir).toBe(
        "/Users/testuser/Library/Application Support/Codehydra"
      );
      expect(pathProvider.projectsDir).toBe(
        "/Users/testuser/Library/Application Support/Codehydra/projects"
      );
      expect(pathProvider.vscodeDir).toBe(
        "/Users/testuser/Library/Application Support/Codehydra/vscode"
      );
      expect(pathProvider.vscodeExtensionsDir).toBe(
        "/Users/testuser/Library/Application Support/Codehydra/vscode/extensions"
      );
      expect(pathProvider.vscodeUserDataDir).toBe(
        "/Users/testuser/Library/Application Support/Codehydra/vscode/user-data"
      );
      expect(pathProvider.vscodeSetupMarkerPath).toBe(
        "/Users/testuser/Library/Application Support/Codehydra/vscode/.setup-completed"
      );
      expect(pathProvider.electronDataDir).toBe(
        "/Users/testuser/Library/Application Support/Codehydra/electron"
      );
    });
  });

  describe("production mode - Windows", () => {
    it("returns <home>/AppData/Roaming/Codehydra/ based paths", () => {
      const buildInfo = createMockBuildInfo({
        isDevelopment: false,
        appPath: "C:/Program Files/Codehydra/resources/app.asar",
      });
      // Use forward slashes for homeDir since Node's join() on Linux doesn't handle
      // Windows backslashes. The actual Windows runtime will use native separators.
      const platformInfo = createMockPlatformInfo({
        platform: "win32",
        homeDir: "C:/Users/TestUser",
      });
      const pathProvider = new DefaultPathProvider(buildInfo, platformInfo);

      // Use join() for expected values since path separators are platform-specific
      expect(pathProvider.dataRootDir).toBe(
        join("C:/Users/TestUser", "AppData", "Roaming", "Codehydra")
      );
      expect(pathProvider.projectsDir).toBe(
        join("C:/Users/TestUser", "AppData", "Roaming", "Codehydra", "projects")
      );
      expect(pathProvider.vscodeDir).toBe(
        join("C:/Users/TestUser", "AppData", "Roaming", "Codehydra", "vscode")
      );
    });
  });

  describe("getProjectWorkspacesDir", () => {
    it("returns correct structure for absolute path", () => {
      const buildInfo = createMockBuildInfo({
        isDevelopment: false,
        appPath: "/opt/codehydra/resources/app.asar",
      });
      const platformInfo = createMockPlatformInfo({
        platform: "linux",
        homeDir: "/home/testuser",
      });
      const pathProvider = new DefaultPathProvider(buildInfo, platformInfo);

      const result = pathProvider.getProjectWorkspacesDir("/home/testuser/projects/myapp");

      // Should be <projectsDir>/<name>-<hash>/workspaces/
      expect(result).toContain("myapp-");
      expect(result).toMatch(/workspaces$/);
      expect(result.startsWith("/home/testuser/.local/share/codehydra/projects/")).toBe(true);
    });

    it("throws TypeError for relative path", () => {
      const buildInfo = createMockBuildInfo({
        isDevelopment: false,
        appPath: "/opt/codehydra/resources/app.asar",
      });
      const platformInfo = createMockPlatformInfo({ platform: "linux" });
      const pathProvider = new DefaultPathProvider(buildInfo, platformInfo);

      expect(() => pathProvider.getProjectWorkspacesDir("relative/path")).toThrow(TypeError);
      expect(() => pathProvider.getProjectWorkspacesDir("relative/path")).toThrow(/absolute path/i);
    });

    it("throws TypeError for empty path", () => {
      const buildInfo = createMockBuildInfo({
        isDevelopment: false,
        appPath: "/opt/codehydra/resources/app.asar",
      });
      const platformInfo = createMockPlatformInfo({ platform: "linux" });
      const pathProvider = new DefaultPathProvider(buildInfo, platformInfo);

      expect(() => pathProvider.getProjectWorkspacesDir("")).toThrow(TypeError);
    });
  });
});
