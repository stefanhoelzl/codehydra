/**
 * Tests for PathProvider interface, mock factory, and DefaultPathProvider.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMockPathProvider } from "./path-provider.test-utils";
import { DefaultPathProvider, type PathProvider } from "./path-provider";
import { createMockBuildInfo } from "./build-info.test-utils";
import { createMockPlatformInfo } from "./platform-info.test-utils";
import { Path } from "./path";
import { CODE_SERVER_VERSION } from "../code-server/setup-info";
import { OPENCODE_VERSION } from "../agents/opencode/setup-info";

describe("createMockPathProvider", () => {
  it("returns sensible default paths", () => {
    const pp = createMockPathProvider();

    expect(pp.dataPath("projects")).toBeInstanceOf(Path);
    expect(pp.dataPath("projects").toString()).toBe("/test/app-data/projects");
    expect(pp.dataPath("remotes").toString()).toBe("/test/app-data/remotes");
    expect(pp.dataPath("vscode").toString()).toBe("/test/app-data/vscode");
    expect(pp.dataPath("vscode/extensions").toString()).toBe("/test/app-data/vscode/extensions");
    expect(pp.dataPath("vscode/user-data").toString()).toBe("/test/app-data/vscode/user-data");
    expect(pp.dataPath("electron").toString()).toBe("/test/app-data/electron");
    expect(pp.dataPath("bin").toString()).toBe("/test/app-data/bin");
    expect(pp.dataPath("config.json").toString()).toBe("/test/app-data/config.json");
    expect(pp.appIconPath.toString()).toBe("/test/resources/icon.png");
  });

  it("bundlePath returns correct paths", () => {
    const pp = createMockPathProvider();

    expect(pp.bundlePath("code-server").toString()).toBe("/test/bundles/code-server");
    expect(pp.bundlePath("opencode").toString()).toBe("/test/bundles/opencode");
    expect(pp.bundlePath("claude").toString()).toBe("/test/bundles/claude");
    expect(pp.bundlePath("code-server/4.107.0").toString()).toBe(
      "/test/bundles/code-server/4.107.0"
    );
    expect(pp.bundlePath("opencode/1.0.223").toString()).toBe("/test/bundles/opencode/1.0.223");
  });

  it("tempPath returns correct paths", () => {
    const pp = createMockPathProvider();

    expect(pp.tempPath("some-dir")).toBeInstanceOf(Path);
    expect(pp.tempPath("some-dir").toString()).toBe("/test/temp/some-dir");
    expect(pp.tempPath("nested/sub/dir").toString()).toBe("/test/temp/nested/sub/dir");
  });

  it("tempPath accepts override for root dir", () => {
    const pp = createMockPathProvider({ tempRootDir: "/custom/temp" });

    expect(pp.tempPath("some-dir").toString()).toBe("/custom/temp/some-dir");
  });

  it("runtimePath and assetPath return correct paths", () => {
    const pp = createMockPathProvider();

    expect(pp.runtimePath("bin/claude-code-hook-handler.cjs").toString()).toBe(
      "/mock/runtime/bin/claude-code-hook-handler.cjs"
    );
    expect(pp.runtimePath("extensions").toString()).toBe("/mock/runtime/extensions");
    expect(pp.assetPath("manifest.json").toString()).toBe("/mock/assets/manifest.json");
    expect(pp.assetPath("bin").toString()).toBe("/mock/assets/bin");
  });

  it("accepts override for root dirs", () => {
    const pp = createMockPathProvider({
      dataRootDir: "/custom/root",
      bundlesRootDir: "/custom/bundles",
      runtimeRootDir: "/custom/runtime",
      assetsRootDir: "/custom/assets",
    });

    expect(pp.dataPath("projects").toString()).toBe("/custom/root/projects");
    expect(pp.bundlePath("code-server").toString()).toBe("/custom/bundles/code-server");
    expect(pp.runtimePath("extensions").toString()).toBe("/custom/runtime/extensions");
    expect(pp.assetPath("manifest.json").toString()).toBe("/custom/assets/manifest.json");
  });

  it("accepts Path objects for overrides", () => {
    const pp = createMockPathProvider({
      dataRootDir: new Path("/custom/root"),
    });

    expect(pp.dataPath("projects").toString()).toBe("/custom/root/projects");
  });

  it("cmd option appends .cmd on win32", () => {
    const pp = createMockPathProvider({ platform: "win32" });
    expect(pp.dataPath("bin/ch-claude", { cmd: true }).toString()).toBe(
      "/test/app-data/bin/ch-claude.cmd"
    );

    const ppLinux = createMockPathProvider({ platform: "linux" });
    expect(ppLinux.dataPath("bin/ch-claude", { cmd: true }).toString()).toBe(
      "/test/app-data/bin/ch-claude"
    );
  });

  it("getProjectWorkspacesDir returns Path with project hash", () => {
    const pp = createMockPathProvider();

    const result = pp.getProjectWorkspacesDir("/home/user/myproject");

    expect(result).toBeInstanceOf(Path);
    expect(result.toString()).toContain("myproject-");
    expect(result.toString()).toContain("/workspaces");
    expect(result.toString().startsWith("/test/app-data/projects/")).toBe(true);
  });

  it("getProjectWorkspacesDir can be overridden", () => {
    const customPath = new Path("/custom/workspaces");
    const pp = createMockPathProvider({
      getProjectWorkspacesDir: () => customPath,
    });

    expect(pp.getProjectWorkspacesDir("/any/path")).toBe(customPath);
  });

  it("returns object satisfying PathProvider interface", () => {
    const pp: PathProvider = createMockPathProvider();

    expect(pp.dataPath("projects")).toBeInstanceOf(Path);
    expect(pp.bundlePath("test")).toBeInstanceOf(Path);
    expect(pp.runtimePath("test")).toBeInstanceOf(Path);
    expect(pp.assetPath("test")).toBeInstanceOf(Path);
    expect(pp.appIconPath).toBeInstanceOf(Path);
    expect(typeof pp.getProjectWorkspacesDir).toBe("function");
  });
});

describe("DefaultPathProvider", () => {
  beforeEach(() => {
    vi.stubEnv("_CH_BUNDLE_DIR", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("development mode", () => {
    it("returns ./app-data/ based paths", () => {
      const buildInfo = createMockBuildInfo({ isDevelopment: true, appPath: "/test/app" });
      const platformInfo = createMockPlatformInfo({ platform: "linux" });
      const pp = new DefaultPathProvider(buildInfo, platformInfo);

      expect(pp.dataPath("projects")).toBeInstanceOf(Path);
      expect(pp.dataPath("projects").toString()).toMatch(/app-data\/projects$/);
      expect(pp.dataPath("remotes").toString()).toMatch(/app-data\/remotes$/);
      expect(pp.dataPath("vscode").toString()).toMatch(/app-data\/vscode$/);
      expect(pp.dataPath("vscode/extensions").toString()).toMatch(/app-data\/vscode\/extensions$/);
      expect(pp.dataPath("vscode/user-data").toString()).toMatch(/app-data\/vscode\/user-data$/);
      expect(pp.dataPath("electron").toString()).toMatch(/app-data\/electron$/);
      expect(pp.appIconPath.toString()).toMatch(/resources\/icon\.png$/);
      expect(pp.dataPath("bin").toString()).toMatch(/app-data\/bin$/);
    });

    it("tempPath returns paths under app-data/temp/", () => {
      const buildInfo = createMockBuildInfo({ isDevelopment: true, appPath: "/test/app" });
      const platformInfo = createMockPlatformInfo({ platform: "linux" });
      const pp = new DefaultPathProvider(buildInfo, platformInfo);

      expect(pp.tempPath("some-dir").toString()).toMatch(/app-data\/temp\/some-dir$/);
    });

    it("returns versioned binary directories via bundlePath", () => {
      const buildInfo = createMockBuildInfo({ isDevelopment: true, appPath: "/test/app" });
      const platformInfo = createMockPlatformInfo({ platform: "linux" });
      const pp = new DefaultPathProvider(buildInfo, platformInfo);

      expect(pp.bundlePath(`code-server/${CODE_SERVER_VERSION}`).toString()).toMatch(
        new RegExp(`\\.local/share/codehydra/code-server/${CODE_SERVER_VERSION}$`)
      );
      expect(pp.bundlePath(`opencode/${OPENCODE_VERSION}`).toString()).toMatch(
        new RegExp(`\\.local/share/codehydra/opencode/${OPENCODE_VERSION}$`)
      );
    });

    it("returns assetPath based on appPath", () => {
      const buildInfo = createMockBuildInfo({ isDevelopment: true, appPath: "/dev/project" });
      const platformInfo = createMockPlatformInfo({ platform: "linux" });
      const pp = new DefaultPathProvider(buildInfo, platformInfo);

      expect(pp.assetPath("manifest.json").toString()).toBe(
        "/dev/project/out/main/assets/manifest.json"
      );
      expect(pp.assetPath("bin").toString()).toBe("/dev/project/out/main/assets/bin");
    });

    it("runtimePath uses assets in dev mode", () => {
      const buildInfo = createMockBuildInfo({ isDevelopment: true, appPath: "/dev/project" });
      const platformInfo = createMockPlatformInfo({ platform: "linux" });
      const pp = new DefaultPathProvider(buildInfo, platformInfo);

      expect(pp.runtimePath("extensions").toString()).toBe(
        "/dev/project/out/main/assets/extensions"
      );
      expect(pp.runtimePath("bin/claude-code-hook-handler.cjs").toString()).toBe(
        "/dev/project/out/main/assets/bin/claude-code-hook-handler.cjs"
      );
    });

    it("runtimePath uses resourcesPath in prod mode", () => {
      const buildInfo = createMockBuildInfo({
        isDevelopment: false,
        isPackaged: true,
        appPath: "/opt/codehydra/resources/app.asar",
        resourcesPath: "/opt/codehydra/resources",
      });
      const platformInfo = createMockPlatformInfo({
        platform: "linux",
        homeDir: "/home/testuser",
      });
      const pp = new DefaultPathProvider(buildInfo, platformInfo);

      expect(pp.runtimePath("extensions").toString()).toBe("/opt/codehydra/resources/extensions");
      expect(pp.runtimePath("bin/claude-code-hook-handler.cjs").toString()).toBe(
        "/opt/codehydra/resources/bin/claude-code-hook-handler.cjs"
      );
    });

    it("uses ./app-data/ for packaged dev builds", () => {
      const buildInfo = createMockBuildInfo({
        isDevelopment: true,
        isPackaged: true,
        appPath: "/opt/codehydra/resources/app.asar",
        resourcesPath: "/opt/codehydra/resources",
      });
      const platformInfo = createMockPlatformInfo({ platform: "linux", homeDir: "/home/testuser" });
      const pp = new DefaultPathProvider(buildInfo, platformInfo);

      expect(pp.dataPath("projects").toString()).toMatch(/app-data\/projects$/);
    });

    it("cmd option appends .cmd on win32", () => {
      const buildInfo = createMockBuildInfo({ isDevelopment: true, appPath: "/test/app" });
      const platformInfo = createMockPlatformInfo({ platform: "linux" });
      const pp = new DefaultPathProvider(buildInfo, platformInfo);

      // Linux: no .cmd
      expect(pp.dataPath("bin/ch-claude", { cmd: true }).toString()).toMatch(/bin\/ch-claude$/);
    });

    it("ignores platform in development mode for dataPath", () => {
      const buildInfo = createMockBuildInfo({ isDevelopment: true, appPath: "/test/app" });

      const linuxProvider = new DefaultPathProvider(
        buildInfo,
        createMockPlatformInfo({ platform: "linux", homeDir: "/home/test" })
      );
      const darwinProvider = new DefaultPathProvider(
        buildInfo,
        createMockPlatformInfo({ platform: "darwin", homeDir: "/Users/test" })
      );

      expect(linuxProvider.dataPath("projects").toString()).toMatch(/app-data\/projects$/);
      expect(darwinProvider.dataPath("projects").toString()).toMatch(/app-data\/projects$/);
    });
  });

  describe.skipIf(process.platform === "win32")("production mode - Linux", () => {
    it("returns ~/.local/share/codehydra/ based paths", () => {
      const buildInfo = createMockBuildInfo({
        isDevelopment: false,
        isPackaged: true,
        appPath: "/opt/codehydra/resources/app.asar",
      });
      const platformInfo = createMockPlatformInfo({
        platform: "linux",
        homeDir: "/home/testuser",
      });
      const pp = new DefaultPathProvider(buildInfo, platformInfo);

      expect(pp.dataPath("projects").toString()).toBe(
        "/home/testuser/.local/share/codehydra/projects"
      );
      expect(pp.dataPath("remotes").toString()).toBe(
        "/home/testuser/.local/share/codehydra/remotes"
      );
      expect(pp.dataPath("vscode").toString()).toBe("/home/testuser/.local/share/codehydra/vscode");
      expect(pp.dataPath("vscode/extensions").toString()).toBe(
        "/home/testuser/.local/share/codehydra/vscode/extensions"
      );
      expect(pp.dataPath("vscode/user-data").toString()).toBe(
        "/home/testuser/.local/share/codehydra/vscode/user-data"
      );
      expect(pp.dataPath("electron").toString()).toBe(
        "/home/testuser/.local/share/codehydra/electron"
      );
      expect(pp.assetPath("manifest.json").toString()).toBe(
        "/opt/codehydra/resources/app.asar/out/main/assets/manifest.json"
      );
      expect(pp.dataPath("bin").toString()).toBe("/home/testuser/.local/share/codehydra/bin");
    });

    it("tempPath resolves under data root", () => {
      const buildInfo = createMockBuildInfo({
        isDevelopment: false,
        isPackaged: true,
        appPath: "/opt/codehydra/resources/app.asar",
      });
      const platformInfo = createMockPlatformInfo({
        platform: "linux",
        homeDir: "/home/testuser",
      });
      const pp = new DefaultPathProvider(buildInfo, platformInfo);

      expect(pp.tempPath("some-dir").toString()).toBe(
        "/home/testuser/.local/share/codehydra/temp/some-dir"
      );
    });

    it("bin is under data root", () => {
      const buildInfo = createMockBuildInfo({
        isDevelopment: false,
        isPackaged: true,
        appPath: "/opt/codehydra/resources/app.asar",
      });
      const platformInfo = createMockPlatformInfo({
        platform: "linux",
        homeDir: "/home/testuser",
      });
      const pp = new DefaultPathProvider(buildInfo, platformInfo);

      expect(pp.dataPath("bin").isChildOf(pp.dataPath("projects").dirname)).toBe(true);
    });

    it("returns versioned binary directories", () => {
      const buildInfo = createMockBuildInfo({
        isDevelopment: false,
        isPackaged: true,
        appPath: "/opt/codehydra/resources/app.asar",
      });
      const platformInfo = createMockPlatformInfo({
        platform: "linux",
        homeDir: "/home/testuser",
      });
      const pp = new DefaultPathProvider(buildInfo, platformInfo);

      expect(pp.bundlePath(`code-server/${CODE_SERVER_VERSION}`).toString()).toBe(
        `/home/testuser/.local/share/codehydra/code-server/${CODE_SERVER_VERSION}`
      );
      expect(pp.bundlePath(`opencode/${OPENCODE_VERSION}`).toString()).toBe(
        `/home/testuser/.local/share/codehydra/opencode/${OPENCODE_VERSION}`
      );
    });
  });

  describe.skipIf(process.platform === "win32")("production mode - macOS", () => {
    it("returns ~/Library/Application Support/Codehydra/ based paths", () => {
      const buildInfo = createMockBuildInfo({
        isDevelopment: false,
        isPackaged: true,
        appPath: "/Applications/Codehydra.app/Contents/Resources/app.asar",
      });
      const platformInfo = createMockPlatformInfo({
        platform: "darwin",
        homeDir: "/Users/testuser",
      });
      const pp = new DefaultPathProvider(buildInfo, platformInfo);

      expect(pp.dataPath("projects").toString()).toBe(
        "/Users/testuser/Library/Application Support/Codehydra/projects"
      );
      expect(pp.dataPath("vscode").toString()).toBe(
        "/Users/testuser/Library/Application Support/Codehydra/vscode"
      );
      expect(pp.dataPath("vscode/extensions").toString()).toBe(
        "/Users/testuser/Library/Application Support/Codehydra/vscode/extensions"
      );
      expect(pp.dataPath("vscode/user-data").toString()).toBe(
        "/Users/testuser/Library/Application Support/Codehydra/vscode/user-data"
      );
      expect(pp.dataPath("electron").toString()).toBe(
        "/Users/testuser/Library/Application Support/Codehydra/electron"
      );
    });

    it("returns versioned binary directories", () => {
      const buildInfo = createMockBuildInfo({
        isDevelopment: false,
        isPackaged: true,
        appPath: "/Applications/Codehydra.app/Contents/Resources/app.asar",
      });
      const platformInfo = createMockPlatformInfo({
        platform: "darwin",
        homeDir: "/Users/testuser",
      });
      const pp = new DefaultPathProvider(buildInfo, platformInfo);

      expect(pp.bundlePath(`code-server/${CODE_SERVER_VERSION}`).toString()).toBe(
        `/Users/testuser/Library/Application Support/Codehydra/code-server/${CODE_SERVER_VERSION}`
      );
      expect(pp.bundlePath(`opencode/${OPENCODE_VERSION}`).toString()).toBe(
        `/Users/testuser/Library/Application Support/Codehydra/opencode/${OPENCODE_VERSION}`
      );
    });
  });

  describe.skipIf(process.platform !== "win32")("production mode - Windows", () => {
    it("returns <home>/AppData/Roaming/Codehydra/ based paths", () => {
      const buildInfo = createMockBuildInfo({
        isDevelopment: false,
        isPackaged: true,
        appPath: "C:/Program Files/Codehydra/resources/app.asar",
      });
      const platformInfo = createMockPlatformInfo({
        platform: "win32",
        homeDir: "C:/Users/TestUser",
      });
      const pp = new DefaultPathProvider(buildInfo, platformInfo);

      expect(pp.dataPath("projects").toString()).toBe(
        "c:/users/testuser/appdata/roaming/codehydra/projects"
      );
      expect(pp.dataPath("vscode").toString()).toBe(
        "c:/users/testuser/appdata/roaming/codehydra/vscode"
      );
    });

    it("cmd option appends .cmd extension", () => {
      const buildInfo = createMockBuildInfo({
        isDevelopment: false,
        isPackaged: true,
        appPath: "C:/Program Files/Codehydra/resources/app.asar",
      });
      const platformInfo = createMockPlatformInfo({
        platform: "win32",
        homeDir: "C:/Users/TestUser",
      });
      const pp = new DefaultPathProvider(buildInfo, platformInfo);

      expect(pp.dataPath("bin/ch-claude", { cmd: true }).toString()).toMatch(
        /bin\/ch-claude\.cmd$/
      );
    });
  });

  describe("getProjectWorkspacesDir", () => {
    it("returns correct structure for absolute path", () => {
      const buildInfo = createMockBuildInfo({
        isDevelopment: false,
        isPackaged: true,
        appPath: "/opt/codehydra/resources/app.asar",
      });
      const platformInfo = createMockPlatformInfo({
        platform: "linux",
        homeDir: "/home/testuser",
      });
      const pp = new DefaultPathProvider(buildInfo, platformInfo);

      const result = pp.getProjectWorkspacesDir("/home/testuser/projects/myapp");

      expect(result).toBeInstanceOf(Path);
      expect(result.toString()).toContain("myapp-");
      expect(result.toString()).toMatch(/workspaces$/);
      expect(result.toString().startsWith("/home/testuser/.local/share/codehydra/projects/")).toBe(
        true
      );
    });

    it("accepts Path object as input", () => {
      const buildInfo = createMockBuildInfo({
        isDevelopment: false,
        isPackaged: true,
        appPath: "/opt/codehydra/resources/app.asar",
      });
      const platformInfo = createMockPlatformInfo({
        platform: "linux",
        homeDir: "/home/testuser",
      });
      const pp = new DefaultPathProvider(buildInfo, platformInfo);

      const projectPath = new Path("/home/testuser/projects/myapp");
      const result = pp.getProjectWorkspacesDir(projectPath);

      expect(result).toBeInstanceOf(Path);
      expect(result.toString()).toContain("myapp-");
    });

    it("throws TypeError for relative path", () => {
      const buildInfo = createMockBuildInfo({
        isDevelopment: false,
        isPackaged: true,
        appPath: "/opt/codehydra/resources/app.asar",
      });
      const platformInfo = createMockPlatformInfo({ platform: "linux" });
      const pp = new DefaultPathProvider(buildInfo, platformInfo);

      expect(() => pp.getProjectWorkspacesDir("relative/path")).toThrow(TypeError);
      expect(() => pp.getProjectWorkspacesDir("relative/path")).toThrow(/absolute path/i);
    });

    it("throws TypeError for empty path", () => {
      const buildInfo = createMockBuildInfo({
        isDevelopment: false,
        isPackaged: true,
        appPath: "/opt/codehydra/resources/app.asar",
      });
      const platformInfo = createMockPlatformInfo({ platform: "linux" });
      const pp = new DefaultPathProvider(buildInfo, platformInfo);

      expect(() => pp.getProjectWorkspacesDir("")).toThrow(TypeError);
    });
  });
});
