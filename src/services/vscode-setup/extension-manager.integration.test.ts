// @vitest-environment node
/**
 * Integration tests for ExtensionManager.
 *
 * Tests verify preflight and install behavior through the manager interface.
 *
 * Test plan items covered:
 * #10: ExtensionManager.preflight detects missing extensions
 */

import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import { ExtensionManager } from "./extension-manager";
import type { FileSystemLayer, DirEntry } from "../platform/filesystem";
import type { PathProvider } from "../platform/path-provider";
import type { ProcessRunner, SpawnedProcess } from "../platform/process";
import { Path } from "../platform/path";

// =============================================================================
// Test Setup
// =============================================================================

const TEST_MANIFEST = JSON.stringify([
  { id: "codehydra.sidekick", version: "0.0.1", vsix: "codehydra-sidekick-0.0.1.vsix" },
  { id: "publisher.extension", version: "1.2.3", vsix: "publisher-extension-1.2.3.vsix" },
]);

function createMockPathProvider(): PathProvider {
  return {
    vscodeAssetsDir: new Path("/app/assets"),
    vscodeExtensionsDir: new Path("/app/vscode/extensions"),
    extensionsRuntimeDir: new Path("/app/extensions"),
    getBinaryPath: (binary: string, version: string) =>
      new Path(`/app/binaries/${binary}-${version}`),
    // Add other required properties with minimal implementations
    dataRootDir: new Path("/app"),
    projectsDir: new Path("/app/projects"),
    remotesDir: new Path("/app/remotes"),
    vscodeDir: new Path("/app/vscode"),
    vscodeUserDataDir: new Path("/app/vscode/user-data"),
    binDir: new Path("/app/bin"),
    binAssetsDir: new Path("/app/assets/bin"),
    setupMarkerPath: new Path("/app/setup.json"),
    opencodeConfig: new Path("/app/opencode.json"),
    electronDataDir: new Path("/app/electron"),
    scriptsRuntimeDir: new Path("/app/scripts"),
    appIconPath: new Path("/app/icon.png"),
    claudeCodeWrapperPath: new Path("/app/claude-wrapper"),
    getBinaryDir: (binary: string, version: string) =>
      new Path(`/app/binaries/${binary}-${version}`),
    getProjectWorkspacesDir: (projectPath: Path) => new Path(`${projectPath}/workspaces`),
  } as PathProvider;
}

function createMockFileSystem(
  options: {
    manifestContent?: string;
    installedExtensions?: Map<string, string>;
    readFileError?: Error;
  } = {}
): FileSystemLayer {
  const manifestContent = options.manifestContent ?? TEST_MANIFEST;
  const installed = options.installedExtensions ?? new Map();

  // Create directory entries from installed extensions
  const entries: DirEntry[] = Array.from(installed.entries()).map(([id, version]) => ({
    name: `${id}-${version}`,
    isDirectory: true,
    isFile: false,
    isSymbolicLink: false,
  }));

  return {
    readFile: vi.fn().mockImplementation(async (filePath: string | Path) => {
      if (options.readFileError) {
        throw options.readFileError;
      }
      const pathStr = filePath.toString();
      if (pathStr.endsWith("manifest.json")) {
        return manifestContent;
      }
      // For VSIX existence check, just return something
      return "vsix-content";
    }),
    readdir: vi.fn().mockResolvedValue(entries),
    mkdir: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
  } as unknown as FileSystemLayer;
}

function createMockProcessRunner(exitCode = 0, stderr = ""): ProcessRunner {
  const mockProcess: SpawnedProcess = {
    wait: vi.fn().mockResolvedValue({ exitCode, stderr, stdout: "" }),
    kill: vi.fn(),
    pid: 12345,
  };

  return {
    run: vi.fn().mockReturnValue(mockProcess),
  } as unknown as ProcessRunner;
}

// =============================================================================
// Tests
// =============================================================================

describe("ExtensionManager", () => {
  describe("preflight", () => {
    it("returns needsInstall: true when extensions are missing (#10)", async () => {
      const pathProvider = createMockPathProvider();
      const fs = createMockFileSystem({ installedExtensions: new Map() });
      const processRunner = createMockProcessRunner();

      const manager = new ExtensionManager(pathProvider, fs, processRunner);
      const result = await manager.preflight();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.needsInstall).toBe(true);
        expect(result.missingExtensions).toContain("codehydra.sidekick");
        expect(result.missingExtensions).toContain("publisher.extension");
        expect(result.outdatedExtensions).toHaveLength(0);
      }
    });

    it("returns needsInstall: false when all extensions are installed", async () => {
      const pathProvider = createMockPathProvider();
      const installed = new Map([
        ["codehydra.sidekick", "0.0.1"],
        ["publisher.extension", "1.2.3"],
      ]);
      const fs = createMockFileSystem({ installedExtensions: installed });
      const processRunner = createMockProcessRunner();

      const manager = new ExtensionManager(pathProvider, fs, processRunner);
      const result = await manager.preflight();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.needsInstall).toBe(false);
        expect(result.missingExtensions).toHaveLength(0);
        expect(result.outdatedExtensions).toHaveLength(0);
      }
    });

    it("detects outdated extensions", async () => {
      const pathProvider = createMockPathProvider();
      const installed = new Map([
        ["codehydra.sidekick", "0.0.0"], // Wrong version
        ["publisher.extension", "1.2.3"], // Correct version
      ]);
      const fs = createMockFileSystem({ installedExtensions: installed });
      const processRunner = createMockProcessRunner();

      const manager = new ExtensionManager(pathProvider, fs, processRunner);
      const result = await manager.preflight();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.needsInstall).toBe(true);
        expect(result.missingExtensions).toHaveLength(0);
        expect(result.outdatedExtensions).toContain("codehydra.sidekick");
      }
    });

    it("returns error on manifest read failure", async () => {
      const pathProvider = createMockPathProvider();
      const fs = createMockFileSystem({ readFileError: new Error("File not found") });
      const processRunner = createMockProcessRunner();

      const manager = new ExtensionManager(pathProvider, fs, processRunner);
      const result = await manager.preflight();

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toContain("File not found");
      }
    });

    it("returns error on invalid manifest", async () => {
      const pathProvider = createMockPathProvider();
      const fs = createMockFileSystem({ manifestContent: "not valid json" });
      const processRunner = createMockProcessRunner();

      const manager = new ExtensionManager(pathProvider, fs, processRunner);
      const result = await manager.preflight();

      expect(result.success).toBe(false);
    });
  });

  describe("install", () => {
    it("installs specified extensions via code-server", async () => {
      const pathProvider = createMockPathProvider();
      const fs = createMockFileSystem();
      const processRunner = createMockProcessRunner();

      const manager = new ExtensionManager(pathProvider, fs, processRunner);
      await manager.install(["codehydra.sidekick"]);

      expect(processRunner.run).toHaveBeenCalledWith(
        path.normalize("/app/binaries/code-server-4.109.2"),
        expect.arrayContaining([
          "--install-extension",
          expect.stringContaining("codehydra-sidekick-0.0.1.vsix"),
        ])
      );
    });

    it("does nothing when no extensions to install", async () => {
      const pathProvider = createMockPathProvider();
      const fs = createMockFileSystem();
      const processRunner = createMockProcessRunner();

      const manager = new ExtensionManager(pathProvider, fs, processRunner);
      await manager.install([]);

      expect(processRunner.run).not.toHaveBeenCalled();
    });

    it("throws ExtensionError when code-server fails", async () => {
      const pathProvider = createMockPathProvider();
      const fs = createMockFileSystem();
      const processRunner = createMockProcessRunner(1, "Installation failed");

      const manager = new ExtensionManager(pathProvider, fs, processRunner);

      await expect(manager.install(["codehydra.sidekick"])).rejects.toThrow(
        "Failed to install extension"
      );
    });

    it("calls progress callback for each extension", async () => {
      const pathProvider = createMockPathProvider();
      const fs = createMockFileSystem();
      const processRunner = createMockProcessRunner();
      const onProgress = vi.fn();

      const manager = new ExtensionManager(pathProvider, fs, processRunner);
      await manager.install(["codehydra.sidekick", "publisher.extension"], onProgress);

      expect(onProgress).toHaveBeenCalledWith("Installing codehydra.sidekick...");
      expect(onProgress).toHaveBeenCalledWith("Installing publisher.extension...");
    });
  });

  describe("cleanOutdated", () => {
    it("removes outdated extension directories", async () => {
      const pathProvider = createMockPathProvider();
      const installed = new Map([["codehydra.sidekick", "0.0.0"]]);
      const fs = createMockFileSystem({ installedExtensions: installed });
      const processRunner = createMockProcessRunner();

      const manager = new ExtensionManager(pathProvider, fs, processRunner);
      await manager.cleanOutdated(["codehydra.sidekick"]);

      expect(fs.rm).toHaveBeenCalledWith(
        expect.objectContaining({
          toString: expect.any(Function),
        }),
        { recursive: true, force: true }
      );
    });
  });
});
