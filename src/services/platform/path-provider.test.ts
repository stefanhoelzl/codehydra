/**
 * Tests for PathProvider interface, mock factory, and DefaultPathProvider.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMockPathProvider } from "./path-provider.test-utils";
import { DefaultPathProvider, type PathProvider } from "./path-provider";
import { createMockBuildInfo } from "./build-info.test-utils";
import { createMockPlatformInfo } from "./platform-info.test-utils";
import { Path } from "./path";
import { CODE_SERVER_VERSION, OPENCODE_VERSION } from "../binary-download/versions";

describe("createMockPathProvider", () => {
  it("returns sensible default paths as Path objects", () => {
    const pathProvider = createMockPathProvider();

    // All properties should be Path objects with normalized POSIX paths
    expect(pathProvider.dataRootDir).toBeInstanceOf(Path);
    expect(pathProvider.dataRootDir.toString()).toBe("/test/app-data");
    expect(pathProvider.projectsDir.toString()).toBe("/test/app-data/projects");
    expect(pathProvider.remotesDir.toString()).toBe("/test/app-data/remotes");
    expect(pathProvider.vscodeDir.toString()).toBe("/test/app-data/vscode");
    expect(pathProvider.vscodeExtensionsDir.toString()).toBe("/test/app-data/vscode/extensions");
    expect(pathProvider.vscodeUserDataDir.toString()).toBe("/test/app-data/vscode/user-data");
    expect(pathProvider.setupMarkerPath.toString()).toBe("/test/app-data/.setup-completed");
    expect(pathProvider.electronDataDir.toString()).toBe("/test/app-data/electron");
    expect(pathProvider.vscodeAssetsDir.toString()).toBe("/mock/assets");
    expect(pathProvider.scriptsDir.toString()).toBe("/mock/assets/scripts");
    expect(pathProvider.appIconPath.toString()).toBe("/test/resources/icon.png");
    expect(pathProvider.binDir.toString()).toBe("/test/app-data/bin");
  });

  it("dynamic methods return correct paths", () => {
    const pathProvider = createMockPathProvider();

    // Test getBinaryBaseDir
    expect(pathProvider.getBinaryBaseDir("code-server").toString()).toBe(
      "/test/bundles/code-server"
    );
    expect(pathProvider.getBinaryBaseDir("opencode").toString()).toBe("/test/bundles/opencode");
    expect(pathProvider.getBinaryBaseDir("claude").toString()).toBe("/test/bundles/claude");

    // Test getBinaryDir
    expect(pathProvider.getBinaryDir("code-server", "4.107.0").toString()).toBe(
      "/test/bundles/code-server/4.107.0"
    );
    expect(pathProvider.getBinaryDir("opencode", "1.0.223").toString()).toBe(
      "/test/bundles/opencode/1.0.223"
    );

    // Test getBinaryPath (Linux - default platform)
    expect(pathProvider.getBinaryPath("code-server", "4.107.0").toString()).toBe(
      "/test/bundles/code-server/4.107.0/bin/code-server"
    );
    expect(pathProvider.getBinaryPath("opencode", "1.0.223").toString()).toBe(
      "/test/bundles/opencode/1.0.223/opencode"
    );
    expect(pathProvider.getBinaryPath("claude", "1.0.58").toString()).toBe(
      "/test/bundles/claude/1.0.58/claude"
    );

    // Test getBundledNodePath
    expect(pathProvider.getBundledNodePath("4.107.0").toString()).toBe(
      "/test/bundles/code-server/4.107.0/lib/node"
    );
  });

  it("accepts override for individual paths with strings", () => {
    const pathProvider = createMockPathProvider({
      dataRootDir: "/custom/root",
      vscodeDir: "/custom/vscode",
    });

    expect(pathProvider.dataRootDir.toString()).toBe("/custom/root");
    expect(pathProvider.vscodeDir.toString()).toBe("/custom/vscode");
    // Data paths derived from dataRootDir should use the override
    expect(pathProvider.projectsDir.toString()).toBe("/custom/root/projects");
    expect(pathProvider.remotesDir.toString()).toBe("/custom/root/remotes");
    // Bundle paths should still use defaults
    expect(pathProvider.getBinaryDir("code-server", CODE_SERVER_VERSION).toString()).toBe(
      `/test/bundles/code-server/${CODE_SERVER_VERSION}`
    );
  });

  it("accepts override for individual paths with Path objects", () => {
    const pathProvider = createMockPathProvider({
      dataRootDir: new Path("/custom/root"),
      vscodeDir: new Path("/custom/vscode"),
    });

    expect(pathProvider.dataRootDir.toString()).toBe("/custom/root");
    expect(pathProvider.vscodeDir.toString()).toBe("/custom/vscode");
  });

  it("allows overriding all paths", () => {
    const pathProvider = createMockPathProvider({
      dataRootDir: "/a",
      projectsDir: "/b",
      vscodeDir: "/c",
      vscodeExtensionsDir: "/d",
      vscodeUserDataDir: "/e",
      setupMarkerPath: "/f",
      electronDataDir: "/g",
      vscodeAssetsDir: "/h",
      scriptsDir: "/h/scripts",
      appIconPath: "/h/icon.png",
      binDir: "/i",
    });

    expect(pathProvider.dataRootDir.toString()).toBe("/a");
    expect(pathProvider.projectsDir.toString()).toBe("/b");
    expect(pathProvider.vscodeDir.toString()).toBe("/c");
    expect(pathProvider.vscodeExtensionsDir.toString()).toBe("/d");
    expect(pathProvider.vscodeUserDataDir.toString()).toBe("/e");
    expect(pathProvider.setupMarkerPath.toString()).toBe("/f");
    expect(pathProvider.electronDataDir.toString()).toBe("/g");
    expect(pathProvider.vscodeAssetsDir.toString()).toBe("/h");
    expect(pathProvider.scriptsDir.toString()).toBe("/h/scripts");
    expect(pathProvider.appIconPath.toString()).toBe("/h/icon.png");
    expect(pathProvider.binDir.toString()).toBe("/i");
  });

  it("allows overriding bundlesRootDir", () => {
    const pathProvider = createMockPathProvider({
      bundlesRootDir: "/custom/bundles",
    });

    expect(pathProvider.getBinaryBaseDir("code-server").toString()).toBe(
      "/custom/bundles/code-server"
    );
    expect(pathProvider.getBinaryDir("opencode", "1.0.0").toString()).toBe(
      "/custom/bundles/opencode/1.0.0"
    );
  });

  it("respects platform option for binary paths", () => {
    const linuxProvider = createMockPathProvider({ platform: "linux" });
    const win32Provider = createMockPathProvider({ platform: "win32" });

    // Linux uses non-.exe extensions
    expect(linuxProvider.getBinaryPath("opencode", "1.0.0").toString()).toBe(
      "/test/bundles/opencode/1.0.0/opencode"
    );
    expect(linuxProvider.getBinaryPath("code-server", "4.0.0").toString()).toBe(
      "/test/bundles/code-server/4.0.0/bin/code-server"
    );

    // Windows uses .exe/.cmd extensions
    expect(win32Provider.getBinaryPath("opencode", "1.0.0").toString()).toBe(
      "/test/bundles/opencode/1.0.0/opencode.exe"
    );
    expect(win32Provider.getBinaryPath("code-server", "4.0.0").toString()).toBe(
      "/test/bundles/code-server/4.0.0/bin/code-server.cmd"
    );
  });

  it("getProjectWorkspacesDir returns Path with project hash", () => {
    const pathProvider = createMockPathProvider();

    const result = pathProvider.getProjectWorkspacesDir("/home/user/myproject");

    // Returns Path object
    expect(result).toBeInstanceOf(Path);
    // Uses projectDirName internally: <name>-<8-char-hash>
    expect(result.toString()).toContain("myproject-");
    expect(result.toString()).toContain("/workspaces");
    expect(result.toString().startsWith("/test/app-data/projects/")).toBe(true);
  });

  it("getProjectWorkspacesDir can be overridden", () => {
    const customPath = new Path("/custom/workspaces");
    const pathProvider = createMockPathProvider({
      getProjectWorkspacesDir: () => customPath,
    });

    expect(pathProvider.getProjectWorkspacesDir("/any/path")).toBe(customPath);
  });

  it("returns object satisfying PathProvider interface", () => {
    const pathProvider: PathProvider = createMockPathProvider();

    // TypeScript ensures type compatibility at compile time
    // This test verifies the interface is implemented correctly - all should be Path instances
    expect(pathProvider.dataRootDir).toBeInstanceOf(Path);
    expect(pathProvider.projectsDir).toBeInstanceOf(Path);
    expect(pathProvider.remotesDir).toBeInstanceOf(Path);
    expect(pathProvider.vscodeDir).toBeInstanceOf(Path);
    expect(pathProvider.vscodeExtensionsDir).toBeInstanceOf(Path);
    expect(pathProvider.vscodeUserDataDir).toBeInstanceOf(Path);
    expect(pathProvider.setupMarkerPath).toBeInstanceOf(Path);
    expect(pathProvider.electronDataDir).toBeInstanceOf(Path);
    expect(pathProvider.vscodeAssetsDir).toBeInstanceOf(Path);
    expect(pathProvider.scriptsDir).toBeInstanceOf(Path);
    expect(pathProvider.appIconPath).toBeInstanceOf(Path);
    expect(pathProvider.binDir).toBeInstanceOf(Path);
    expect(typeof pathProvider.getProjectWorkspacesDir).toBe("function");
    expect(typeof pathProvider.getBinaryBaseDir).toBe("function");
    expect(typeof pathProvider.getBinaryDir).toBe("function");
    expect(typeof pathProvider.getBinaryPath).toBe("function");
    expect(typeof pathProvider.getBundledNodePath).toBe("function");
  });
});

describe("DefaultPathProvider", () => {
  // Clear CODEHYDRA_BUNDLE_DIR to ensure tests use expected paths
  beforeEach(() => {
    vi.stubEnv("CODEHYDRA_BUNDLE_DIR", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("development mode", () => {
    it("returns ./app-data/ based paths as Path objects", () => {
      const buildInfo = createMockBuildInfo({ isDevelopment: true, appPath: "/test/app" });
      const platformInfo = createMockPlatformInfo({ platform: "linux" });
      const pathProvider = new DefaultPathProvider(buildInfo, platformInfo);

      // All should be Path objects
      expect(pathProvider.dataRootDir).toBeInstanceOf(Path);

      // In dev mode, uses process.cwd() + ./app-data/
      // We can't predict exact cwd, but we can verify the structure
      expect(pathProvider.dataRootDir.toString()).toMatch(/app-data$/);
      expect(pathProvider.projectsDir.toString()).toMatch(/app-data\/projects$/);
      expect(pathProvider.remotesDir.toString()).toMatch(/app-data\/remotes$/);
      expect(pathProvider.vscodeDir.toString()).toMatch(/app-data\/vscode$/);
      expect(pathProvider.vscodeExtensionsDir.toString()).toMatch(/app-data\/vscode\/extensions$/);
      expect(pathProvider.vscodeUserDataDir.toString()).toMatch(/app-data\/vscode\/user-data$/);
      expect(pathProvider.setupMarkerPath.toString()).toMatch(/app-data\/\.setup-completed$/);
      expect(pathProvider.electronDataDir.toString()).toMatch(/app-data\/electron$/);
      expect(pathProvider.appIconPath.toString()).toMatch(/resources\/icon\.png$/);
      expect(pathProvider.binDir.toString()).toMatch(/app-data\/bin$/);
    });

    it("returns versioned binary directories via dynamic methods", () => {
      const buildInfo = createMockBuildInfo({ isDevelopment: true, appPath: "/test/app" });
      const platformInfo = createMockPlatformInfo({ platform: "linux" });
      const pathProvider = new DefaultPathProvider(buildInfo, platformInfo);

      // Binaries always use production paths, even in development
      expect(pathProvider.getBinaryDir("code-server", CODE_SERVER_VERSION).toString()).toMatch(
        new RegExp(`\\.local/share/codehydra/code-server/${CODE_SERVER_VERSION}$`)
      );
      expect(pathProvider.getBinaryDir("opencode", OPENCODE_VERSION).toString()).toMatch(
        new RegExp(`\\.local/share/codehydra/opencode/${OPENCODE_VERSION}$`)
      );
    });

    it("returns correct binary paths for Linux", () => {
      const buildInfo = createMockBuildInfo({ isDevelopment: true, appPath: "/test/app" });
      const platformInfo = createMockPlatformInfo({ platform: "linux" });
      const pathProvider = new DefaultPathProvider(buildInfo, platformInfo);

      expect(pathProvider.getBinaryPath("code-server", CODE_SERVER_VERSION).toString()).toMatch(
        /bin\/code-server$/
      );
      expect(pathProvider.getBinaryPath("opencode", OPENCODE_VERSION).toString()).toMatch(
        /opencode$/
      );
      expect(pathProvider.getBinaryPath("opencode", OPENCODE_VERSION).toString()).not.toMatch(
        /\.exe$/
      );
    });

    it("returns bundled Node path for Unix", () => {
      const buildInfo = createMockBuildInfo({ isDevelopment: true, appPath: "/test/app" });
      const platformInfo = createMockPlatformInfo({ platform: "linux" });
      const pathProvider = new DefaultPathProvider(buildInfo, platformInfo);

      expect(pathProvider.getBundledNodePath(CODE_SERVER_VERSION).toString()).toMatch(/lib\/node$/);
      expect(pathProvider.getBundledNodePath(CODE_SERVER_VERSION).toString()).not.toMatch(/\.exe$/);
    });

    it("returns vscodeAssetsDir and scriptsDir based on appPath", () => {
      const buildInfo = createMockBuildInfo({ isDevelopment: true, appPath: "/dev/project" });
      const platformInfo = createMockPlatformInfo({ platform: "linux" });
      const pathProvider = new DefaultPathProvider(buildInfo, platformInfo);

      // Path normalizes to POSIX format
      expect(pathProvider.vscodeAssetsDir.toString()).toBe("/dev/project/out/main/assets");
      expect(pathProvider.scriptsDir.toString()).toBe("/dev/project/out/main/assets/scripts");
    });

    it("uses ./app-data/ for packaged dev builds", () => {
      const buildInfo = createMockBuildInfo({
        isDevelopment: true,
        isPackaged: true,
        appPath: "/opt/codehydra/resources/app.asar",
        resourcesPath: "/opt/codehydra/resources",
      });
      const platformInfo = createMockPlatformInfo({ platform: "linux", homeDir: "/home/testuser" });
      const pathProvider = new DefaultPathProvider(buildInfo, platformInfo);

      // Packaged dev builds should still use ./app-data/ (not system paths)
      expect(pathProvider.dataRootDir.toString()).toMatch(/app-data$/);
      expect(pathProvider.projectsDir.toString()).toMatch(/app-data\/projects$/);
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

      // All should use ./app-data/ structure (relative to cwd)
      expect(linuxProvider.dataRootDir.toString()).toMatch(/app-data$/);
      expect(darwinProvider.dataRootDir.toString()).toMatch(/app-data$/);

      // Skip Windows test on non-Windows platforms due to Path constructor limitations
      if (process.platform === "win32") {
        const win32Provider = new DefaultPathProvider(
          buildInfo,
          createMockPlatformInfo({ platform: "win32", homeDir: "C:/Users/test" })
        );
        expect(win32Provider.dataRootDir.toString()).toMatch(/app-data$/);
      }
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
      const pathProvider = new DefaultPathProvider(buildInfo, platformInfo);

      // Path normalizes to POSIX format
      expect(pathProvider.dataRootDir.toString()).toBe("/home/testuser/.local/share/codehydra");
      expect(pathProvider.projectsDir.toString()).toBe(
        "/home/testuser/.local/share/codehydra/projects"
      );
      expect(pathProvider.remotesDir.toString()).toBe(
        "/home/testuser/.local/share/codehydra/remotes"
      );
      expect(pathProvider.vscodeDir.toString()).toBe(
        "/home/testuser/.local/share/codehydra/vscode"
      );
      expect(pathProvider.vscodeExtensionsDir.toString()).toBe(
        "/home/testuser/.local/share/codehydra/vscode/extensions"
      );
      expect(pathProvider.vscodeUserDataDir.toString()).toBe(
        "/home/testuser/.local/share/codehydra/vscode/user-data"
      );
      expect(pathProvider.setupMarkerPath.toString()).toBe(
        "/home/testuser/.local/share/codehydra/.setup-completed"
      );
      expect(pathProvider.electronDataDir.toString()).toBe(
        "/home/testuser/.local/share/codehydra/electron"
      );
      expect(pathProvider.vscodeAssetsDir.toString()).toBe(
        "/opt/codehydra/resources/app.asar/out/main/assets"
      );
      expect(pathProvider.binDir.toString()).toBe("/home/testuser/.local/share/codehydra/bin");
    });

    it("binDir is under dataRootDir", () => {
      const buildInfo = createMockBuildInfo({
        isDevelopment: false,
        isPackaged: true,
        appPath: "/opt/codehydra/resources/app.asar",
      });
      const platformInfo = createMockPlatformInfo({
        platform: "linux",
        homeDir: "/home/testuser",
      });
      const pathProvider = new DefaultPathProvider(buildInfo, platformInfo);

      expect(pathProvider.binDir.isChildOf(pathProvider.dataRootDir)).toBe(true);
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
      const pathProvider = new DefaultPathProvider(buildInfo, platformInfo);

      expect(pathProvider.getBinaryDir("code-server", CODE_SERVER_VERSION).toString()).toBe(
        `/home/testuser/.local/share/codehydra/code-server/${CODE_SERVER_VERSION}`
      );
      expect(pathProvider.getBinaryDir("opencode", OPENCODE_VERSION).toString()).toBe(
        `/home/testuser/.local/share/codehydra/opencode/${OPENCODE_VERSION}`
      );
    });

    it("returns correct binary paths", () => {
      const buildInfo = createMockBuildInfo({
        isDevelopment: false,
        isPackaged: true,
        appPath: "/opt/codehydra/resources/app.asar",
      });
      const platformInfo = createMockPlatformInfo({
        platform: "linux",
        homeDir: "/home/testuser",
      });
      const pathProvider = new DefaultPathProvider(buildInfo, platformInfo);

      expect(pathProvider.getBinaryPath("code-server", CODE_SERVER_VERSION).toString()).toBe(
        `/home/testuser/.local/share/codehydra/code-server/${CODE_SERVER_VERSION}/bin/code-server`
      );
      expect(pathProvider.getBinaryPath("opencode", OPENCODE_VERSION).toString()).toBe(
        `/home/testuser/.local/share/codehydra/opencode/${OPENCODE_VERSION}/opencode`
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
      const pathProvider = new DefaultPathProvider(buildInfo, platformInfo);

      // Path normalizes to POSIX format
      expect(pathProvider.dataRootDir.toString()).toBe(
        "/Users/testuser/Library/Application Support/Codehydra"
      );
      expect(pathProvider.projectsDir.toString()).toBe(
        "/Users/testuser/Library/Application Support/Codehydra/projects"
      );
      expect(pathProvider.vscodeDir.toString()).toBe(
        "/Users/testuser/Library/Application Support/Codehydra/vscode"
      );
      expect(pathProvider.vscodeExtensionsDir.toString()).toBe(
        "/Users/testuser/Library/Application Support/Codehydra/vscode/extensions"
      );
      expect(pathProvider.vscodeUserDataDir.toString()).toBe(
        "/Users/testuser/Library/Application Support/Codehydra/vscode/user-data"
      );
      expect(pathProvider.setupMarkerPath.toString()).toBe(
        "/Users/testuser/Library/Application Support/Codehydra/.setup-completed"
      );
      expect(pathProvider.electronDataDir.toString()).toBe(
        "/Users/testuser/Library/Application Support/Codehydra/electron"
      );
    });

    it("returns versioned binary directories and correct paths", () => {
      const buildInfo = createMockBuildInfo({
        isDevelopment: false,
        isPackaged: true,
        appPath: "/Applications/Codehydra.app/Contents/Resources/app.asar",
      });
      const platformInfo = createMockPlatformInfo({
        platform: "darwin",
        homeDir: "/Users/testuser",
      });
      const pathProvider = new DefaultPathProvider(buildInfo, platformInfo);

      expect(pathProvider.getBinaryDir("code-server", CODE_SERVER_VERSION).toString()).toBe(
        `/Users/testuser/Library/Application Support/Codehydra/code-server/${CODE_SERVER_VERSION}`
      );
      expect(pathProvider.getBinaryDir("opencode", OPENCODE_VERSION).toString()).toBe(
        `/Users/testuser/Library/Application Support/Codehydra/opencode/${OPENCODE_VERSION}`
      );
      // macOS uses Unix-style paths (no .exe extension)
      expect(pathProvider.getBinaryPath("code-server", CODE_SERVER_VERSION).toString()).toContain(
        "/bin/code-server"
      );
      expect(
        pathProvider.getBinaryPath("code-server", CODE_SERVER_VERSION).toString()
      ).not.toContain(".cmd");
      expect(pathProvider.getBinaryPath("opencode", OPENCODE_VERSION).toString()).toContain(
        "opencode"
      );
      expect(pathProvider.getBinaryPath("opencode", OPENCODE_VERSION).toString()).not.toContain(
        ".exe"
      );
    });
  });

  // Windows-specific tests only run on Windows because Path class checks actual platform
  describe.skipIf(process.platform !== "win32")("production mode - Windows", () => {
    it("returns <home>/AppData/Roaming/Codehydra/ based paths", () => {
      const buildInfo = createMockBuildInfo({
        isDevelopment: false,
        isPackaged: true,
        appPath: "C:/Program Files/Codehydra/resources/app.asar",
      });
      // Use forward slashes for homeDir since Node's join() on Linux doesn't handle
      // Windows backslashes. The actual Windows runtime will use native separators.
      const platformInfo = createMockPlatformInfo({
        platform: "win32",
        homeDir: "C:/Users/TestUser",
      });
      const pathProvider = new DefaultPathProvider(buildInfo, platformInfo);

      // Path normalizes to POSIX format with lowercase on Windows
      expect(pathProvider.dataRootDir.toString()).toBe(
        "c:/users/testuser/appdata/roaming/codehydra"
      );
      expect(pathProvider.projectsDir.toString()).toBe(
        "c:/users/testuser/appdata/roaming/codehydra/projects"
      );
      expect(pathProvider.vscodeDir.toString()).toBe(
        "c:/users/testuser/appdata/roaming/codehydra/vscode"
      );
    });

    it("returns Windows binary paths with correct extensions", () => {
      const buildInfo = createMockBuildInfo({
        isDevelopment: false,
        isPackaged: true,
        appPath: "C:/Program Files/Codehydra/resources/app.asar",
      });
      const platformInfo = createMockPlatformInfo({
        platform: "win32",
        homeDir: "C:/Users/TestUser",
      });
      const pathProvider = new DefaultPathProvider(buildInfo, platformInfo);

      // Windows uses .cmd for code-server and .exe for opencode
      expect(pathProvider.getBinaryPath("code-server", CODE_SERVER_VERSION).toString()).toMatch(
        /bin\/code-server\.cmd$/
      );
      expect(pathProvider.getBinaryPath("opencode", OPENCODE_VERSION).toString()).toMatch(
        /opencode\.exe$/
      );
    });

    it("returns bundled Node path with .exe extension", () => {
      const buildInfo = createMockBuildInfo({
        isDevelopment: false,
        isPackaged: true,
        appPath: "C:/Program Files/Codehydra/resources/app.asar",
      });
      const platformInfo = createMockPlatformInfo({
        platform: "win32",
        homeDir: "C:/Users/TestUser",
      });
      const pathProvider = new DefaultPathProvider(buildInfo, platformInfo);

      expect(pathProvider.getBundledNodePath(CODE_SERVER_VERSION).toString()).toMatch(
        /lib\/node\.exe$/
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
      const pathProvider = new DefaultPathProvider(buildInfo, platformInfo);

      const result = pathProvider.getProjectWorkspacesDir("/home/testuser/projects/myapp");

      // Should return a Path object
      expect(result).toBeInstanceOf(Path);
      // Should be <projectsDir>/<name>-<hash>/workspaces/
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
      const pathProvider = new DefaultPathProvider(buildInfo, platformInfo);

      const projectPath = new Path("/home/testuser/projects/myapp");
      const result = pathProvider.getProjectWorkspacesDir(projectPath);

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
      const pathProvider = new DefaultPathProvider(buildInfo, platformInfo);

      expect(() => pathProvider.getProjectWorkspacesDir("relative/path")).toThrow(TypeError);
      expect(() => pathProvider.getProjectWorkspacesDir("relative/path")).toThrow(/absolute path/i);
    });

    it("throws TypeError for empty path", () => {
      const buildInfo = createMockBuildInfo({
        isDevelopment: false,
        isPackaged: true,
        appPath: "/opt/codehydra/resources/app.asar",
      });
      const platformInfo = createMockPlatformInfo({ platform: "linux" });
      const pathProvider = new DefaultPathProvider(buildInfo, platformInfo);

      expect(() => pathProvider.getProjectWorkspacesDir("")).toThrow(TypeError);
    });
  });
});
