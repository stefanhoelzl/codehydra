// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import { VscodeSetupService } from "./vscode-setup-service";
import {
  CURRENT_SETUP_VERSION,
  type SetupMarker,
  type ProcessRunner,
  type ProcessResult,
} from "./types";
import type { SpawnedProcess } from "../platform/process";
import type { PathProvider } from "../platform/path-provider";
import { createMockPathProvider } from "../platform/path-provider.test-utils";
import { createMockFileSystemLayer } from "../platform/filesystem.test-utils";
import { FileSystemError, VscodeSetupError } from "../errors";
import type { FileSystemLayer } from "../platform/filesystem";

/**
 * Create a mock SpawnedProcess with controllable wait() result.
 */
function createMockSpawnedProcess(result: ProcessResult): SpawnedProcess {
  return {
    pid: 12345,
    kill: vi.fn().mockReturnValue(true),
    wait: vi.fn().mockResolvedValue(result),
  };
}

/**
 * Create default mock extensions.json content.
 */
function createExtensionsConfig(): string {
  return JSON.stringify({
    marketplace: ["sst-dev.opencode"],
    bundled: ["codehydra.vscode-0.0.1.vsix"],
  });
}

describe("VscodeSetupService", () => {
  let mockProcessRunner: ProcessRunner;
  let mockPathProvider: PathProvider;
  let mockFs: FileSystemLayer;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProcessRunner = {
      run: vi.fn(),
    };
    mockPathProvider = createMockPathProvider({
      dataRootDir: "/mock",
      vscodeDir: "/mock/vscode",
      vscodeExtensionsDir: "/mock/vscode/extensions",
      vscodeUserDataDir: "/mock/vscode/user-data",
      vscodeSetupMarkerPath: "/mock/vscode/.setup-completed",
      vscodeAssetsDir: "/mock/assets",
    });
    mockFs = createMockFileSystemLayer();
  });

  describe("isSetupComplete", () => {
    it("returns true when marker exists with correct version", async () => {
      const marker: SetupMarker = {
        version: CURRENT_SETUP_VERSION,
        completedAt: "2025-12-09T10:00:00.000Z",
      };
      mockFs = createMockFileSystemLayer({
        readFile: { content: JSON.stringify(marker) },
      });

      const service = new VscodeSetupService(
        mockProcessRunner,
        mockPathProvider,
        "/mock/code-server",
        mockFs
      );
      const result = await service.isSetupComplete();

      expect(result).toBe(true);
    });

    it("returns false when marker is missing", async () => {
      mockFs = createMockFileSystemLayer({
        readFile: {
          error: new FileSystemError("ENOENT", "/mock/vscode/.setup-completed", "Not found"),
        },
      });

      const service = new VscodeSetupService(
        mockProcessRunner,
        mockPathProvider,
        "/mock/code-server",
        mockFs
      );
      const result = await service.isSetupComplete();

      expect(result).toBe(false);
    });

    it("returns false when version mismatch", async () => {
      const marker: SetupMarker = {
        version: CURRENT_SETUP_VERSION - 1, // Old version
        completedAt: "2025-12-09T10:00:00.000Z",
      };
      mockFs = createMockFileSystemLayer({
        readFile: { content: JSON.stringify(marker) },
      });

      const service = new VscodeSetupService(
        mockProcessRunner,
        mockPathProvider,
        "/mock/code-server",
        mockFs
      );
      const result = await service.isSetupComplete();

      expect(result).toBe(false);
    });

    it("returns false when marker has invalid JSON", async () => {
      mockFs = createMockFileSystemLayer({
        readFile: { content: "invalid json" },
      });

      const service = new VscodeSetupService(
        mockProcessRunner,
        mockPathProvider,
        "/mock/code-server",
        mockFs
      );
      const result = await service.isSetupComplete();

      expect(result).toBe(false);
    });

    it("returns false when marker is missing required fields", async () => {
      mockFs = createMockFileSystemLayer({
        readFile: { content: JSON.stringify({ version: "not a number" }) },
      });

      const service = new VscodeSetupService(
        mockProcessRunner,
        mockPathProvider,
        "/mock/code-server",
        mockFs
      );
      const result = await service.isSetupComplete();

      expect(result).toBe(false);
    });
  });

  describe("cleanVscodeDir", () => {
    it("removes the vscode directory", async () => {
      let rmCalled = false;
      let rmPath = "";
      let rmOptions: { recursive?: boolean; force?: boolean } | undefined;
      mockFs = createMockFileSystemLayer({
        rm: {
          implementation: async (path, options) => {
            rmCalled = true;
            rmPath = path;
            rmOptions = options;
          },
        },
      });

      const service = new VscodeSetupService(
        mockProcessRunner,
        mockPathProvider,
        "/mock/code-server",
        mockFs
      );
      await service.cleanVscodeDir();

      expect(rmCalled).toBe(true);
      expect(rmPath).toBe("/mock/vscode");
      expect(rmOptions).toEqual({ recursive: true, force: true });
    });

    it("validates path is under app data directory", async () => {
      // Create PathProvider with vscodeDir outside of dataRootDir
      const invalidPathProvider = createMockPathProvider({
        dataRootDir: "/mock/app-data",
        vscodeDir: "/outside/path/vscode",
      });

      const service = new VscodeSetupService(
        mockProcessRunner,
        invalidPathProvider,
        "/mock/code-server",
        mockFs
      );
      await expect(service.cleanVscodeDir()).rejects.toThrow(VscodeSetupError);
      try {
        await service.cleanVscodeDir();
      } catch (error) {
        expect(error).toBeInstanceOf(VscodeSetupError);
        expect((error as VscodeSetupError).code).toBe("path-validation");
        expect((error as VscodeSetupError).message).toContain("Invalid vscode directory path");
      }
    });

    it("throws on permission error", async () => {
      mockFs = createMockFileSystemLayer({
        rm: {
          error: new FileSystemError("EACCES", "/mock/vscode", "Permission denied"),
        },
      });

      const service = new VscodeSetupService(
        mockProcessRunner,
        mockPathProvider,
        "/mock/code-server",
        mockFs
      );
      await expect(service.cleanVscodeDir()).rejects.toThrow("Permission denied");
    });
  });

  describe("validateAssets", () => {
    it("succeeds when all required assets exist", async () => {
      mockFs = createMockFileSystemLayer({
        readFile: { content: "{}" },
      });

      const service = new VscodeSetupService(
        mockProcessRunner,
        mockPathProvider,
        "/mock/code-server",
        mockFs
      );
      await expect(service.validateAssets()).resolves.not.toThrow();
    });

    it("throws VscodeSetupError when assets are missing", async () => {
      mockFs = createMockFileSystemLayer({
        readFile: {
          error: new FileSystemError("ENOENT", "/mock/assets/settings.json", "Not found"),
        },
      });

      const service = new VscodeSetupService(
        mockProcessRunner,
        mockPathProvider,
        "/mock/code-server",
        mockFs
      );
      await expect(service.validateAssets()).rejects.toThrow(VscodeSetupError);
      await expect(service.validateAssets()).rejects.toThrow(/settings\.json/);
    });
  });

  describe("installExtensions", () => {
    const defaultCopyResult = { copiedCount: 1, skippedSymlinks: [] };

    it("copies bundled vsix to vscodeDir before install", async () => {
      const copiedFiles: Array<{ src: string; dest: string }> = [];
      mockFs = createMockFileSystemLayer({
        readFile: { content: createExtensionsConfig() },
        mkdir: { implementation: async () => {} },
        copyTree: {
          implementation: async (src, dest) => {
            copiedFiles.push({ src, dest });
            return defaultCopyResult;
          },
        },
      });
      vi.mocked(mockProcessRunner.run).mockReturnValue(
        createMockSpawnedProcess({
          stdout: "Extension installed",
          stderr: "",
          exitCode: 0,
        })
      );

      const service = new VscodeSetupService(
        mockProcessRunner,
        mockPathProvider,
        "/mock/code-server",
        mockFs
      );
      await service.installExtensions();

      // Verify vsix was copied from assets to vscode dir
      expect(copiedFiles).toContainEqual({
        src: "/mock/assets/codehydra.vscode-0.0.1.vsix",
        dest: "/mock/vscode/codehydra.vscode-0.0.1.vsix",
      });
    });

    it("installs bundled extension via code-server", async () => {
      mockFs = createMockFileSystemLayer({
        readFile: { content: createExtensionsConfig() },
        mkdir: { implementation: async () => {} },
        copyTree: { result: defaultCopyResult },
      });
      vi.mocked(mockProcessRunner.run).mockReturnValue(
        createMockSpawnedProcess({
          stdout: "Extension installed",
          stderr: "",
          exitCode: 0,
        })
      );

      const service = new VscodeSetupService(
        mockProcessRunner,
        mockPathProvider,
        "/mock/code-server",
        mockFs
      );
      await service.installExtensions();

      // First call is for bundled vsix
      expect(mockProcessRunner.run).toHaveBeenCalledWith("/mock/code-server", [
        "--install-extension",
        "/mock/vscode/codehydra.vscode-0.0.1.vsix",
        "--extensions-dir",
        "/mock/vscode/extensions",
      ]);
    });

    it("installs marketplace extensions by ID", async () => {
      mockFs = createMockFileSystemLayer({
        readFile: { content: createExtensionsConfig() },
        mkdir: { implementation: async () => {} },
        copyTree: { result: defaultCopyResult },
      });
      vi.mocked(mockProcessRunner.run).mockReturnValue(
        createMockSpawnedProcess({
          stdout: "Extension installed",
          stderr: "",
          exitCode: 0,
        })
      );

      const service = new VscodeSetupService(
        mockProcessRunner,
        mockPathProvider,
        "/mock/code-server",
        mockFs
      );
      await service.installExtensions();

      // Second call is for marketplace extension
      expect(mockProcessRunner.run).toHaveBeenCalledWith("/mock/code-server", [
        "--install-extension",
        "sst-dev.opencode",
        "--extensions-dir",
        "/mock/vscode/extensions",
      ]);
    });

    it("handles mixed extensions in order (bundled first, then marketplace)", async () => {
      mockFs = createMockFileSystemLayer({
        readFile: { content: createExtensionsConfig() },
        mkdir: { implementation: async () => {} },
        copyTree: { result: defaultCopyResult },
      });
      vi.mocked(mockProcessRunner.run).mockReturnValue(
        createMockSpawnedProcess({
          stdout: "Extension installed",
          stderr: "",
          exitCode: 0,
        })
      );
      const progressCallback = vi.fn();

      const service = new VscodeSetupService(
        mockProcessRunner,
        mockPathProvider,
        "/mock/code-server",
        mockFs
      );
      await service.installExtensions(progressCallback);

      // Verify order: bundled vsix first, then marketplace
      expect(mockProcessRunner.run).toHaveBeenCalledTimes(2);
      const calls = vi.mocked(mockProcessRunner.run).mock.calls;
      expect(calls[0]?.[1]?.[1]).toBe("/mock/vscode/codehydra.vscode-0.0.1.vsix");
      expect(calls[1]?.[1]?.[1]).toBe("sst-dev.opencode");

      // Verify progress messages
      const progressMessages = progressCallback.mock.calls.map(
        (call) => (call[0] as { message: string }).message
      );
      expect(progressMessages).toContain("Installing codehydra.vscode-0.0.1.vsix...");
      expect(progressMessages).toContain("Installing sst-dev.opencode...");
    });

    it("returns error on non-zero exit code", async () => {
      mockFs = createMockFileSystemLayer({
        readFile: { content: createExtensionsConfig() },
        mkdir: { implementation: async () => {} },
        copyTree: { result: defaultCopyResult },
      });
      vi.mocked(mockProcessRunner.run).mockReturnValue(
        createMockSpawnedProcess({
          stdout: "",
          stderr: "Failed to install extension",
          exitCode: 1,
        })
      );

      const service = new VscodeSetupService(
        mockProcessRunner,
        mockPathProvider,
        "/mock/code-server",
        mockFs
      );
      const result = await service.installExtensions();

      expect(result).toEqual({
        success: false,
        error: {
          type: "network",
          message: expect.stringContaining("Failed to install extension"),
          code: "EXTENSION_INSTALL_FAILED",
        },
      });
    });

    it("returns binary-not-found error when spawn fails", async () => {
      mockFs = createMockFileSystemLayer({
        readFile: { content: createExtensionsConfig() },
        mkdir: { implementation: async () => {} },
        copyTree: { result: defaultCopyResult },
      });
      vi.mocked(mockProcessRunner.run).mockReturnValue(
        createMockSpawnedProcess({
          stdout: "",
          stderr: "spawn ENOENT: code-server not found",
          exitCode: null,
        })
      );

      const service = new VscodeSetupService(
        mockProcessRunner,
        mockPathProvider,
        "/mock/code-server",
        mockFs
      );
      const result = await service.installExtensions();

      expect(result).toEqual({
        success: false,
        error: {
          type: "binary-not-found",
          message: expect.stringContaining("ENOENT"),
          code: "BINARY_ERROR",
        },
      });
    });
  });

  describe("writeConfigFiles", () => {
    const defaultCopyResult = { copiedCount: 1, skippedSymlinks: [] };

    it("creates user-data directory and copies config files", async () => {
      const createdDirs: string[] = [];
      const copiedFiles: Array<{ src: string; dest: string }> = [];

      mockFs = createMockFileSystemLayer({
        mkdir: {
          implementation: async (path) => {
            createdDirs.push(path);
          },
        },
        copyTree: {
          implementation: async (src, dest) => {
            copiedFiles.push({ src, dest });
            return defaultCopyResult;
          },
        },
      });
      const progressCallback = vi.fn();

      const service = new VscodeSetupService(
        mockProcessRunner,
        mockPathProvider,
        "/mock/code-server",
        mockFs
      );
      await service.writeConfigFiles(progressCallback);

      // Verify directory created
      expect(createdDirs).toContain("/mock/vscode/user-data/User");

      // Verify settings.json copied from assets
      expect(copiedFiles).toContainEqual({
        src: "/mock/assets/settings.json",
        dest: "/mock/vscode/user-data/User/settings.json",
      });

      // Verify keybindings.json copied from assets
      expect(copiedFiles).toContainEqual({
        src: "/mock/assets/keybindings.json",
        dest: "/mock/vscode/user-data/User/keybindings.json",
      });

      // Verify progress callback called
      expect(progressCallback).toHaveBeenCalledWith({
        step: "config",
        message: "Writing configuration...",
      });
    });
  });

  describe("writeCompletionMarker", () => {
    it("writes marker file with version and timestamp", async () => {
      const writtenFiles: Map<string, string> = new Map();
      mockFs = createMockFileSystemLayer({
        writeFile: {
          implementation: async (path, content) => {
            writtenFiles.set(path, content);
          },
        },
      });
      const progressCallback = vi.fn();

      const service = new VscodeSetupService(
        mockProcessRunner,
        mockPathProvider,
        "/mock/code-server",
        mockFs
      );
      await service.writeCompletionMarker(progressCallback);

      // Verify marker written
      const markerPath = "/mock/vscode/.setup-completed";
      expect(writtenFiles.has(markerPath)).toBe(true);

      // Verify content structure
      const markerContent = writtenFiles.get(markerPath)!;
      const marker = JSON.parse(markerContent) as SetupMarker;
      expect(marker.version).toBe(CURRENT_SETUP_VERSION);
      expect(marker.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      // Verify progress callback called
      expect(progressCallback).toHaveBeenCalledWith({
        step: "finalize",
        message: "Finalizing setup...",
      });
    });
  });

  describe("setup", () => {
    const defaultCopyResult = { copiedCount: 1, skippedSymlinks: [] };

    it("validates assets before proceeding", async () => {
      mockFs = createMockFileSystemLayer({
        readFile: {
          error: new FileSystemError("ENOENT", "/mock/assets/settings.json", "Not found"),
        },
      });

      const service = new VscodeSetupService(
        mockProcessRunner,
        mockPathProvider,
        "/mock/code-server",
        mockFs
      );
      await expect(service.setup()).rejects.toThrow(VscodeSetupError);
      await expect(service.setup()).rejects.toThrow(/Required asset files not found/);
    });

    it("runs all setup steps in order and returns success", async () => {
      mockFs = createMockFileSystemLayer({
        readFile: { content: createExtensionsConfig() },
        mkdir: { implementation: async () => {} },
        copyTree: { result: defaultCopyResult },
        writeFile: { implementation: async () => {} },
      });
      vi.mocked(mockProcessRunner.run).mockReturnValue(
        createMockSpawnedProcess({
          stdout: "Extension installed",
          stderr: "",
          exitCode: 0,
        })
      );

      const progressCallback = vi.fn();
      const service = new VscodeSetupService(
        mockProcessRunner,
        mockPathProvider,
        "/mock/code-server",
        mockFs
      );
      const result = await service.setup(progressCallback);

      expect(result).toEqual({ success: true });

      // Verify progress callbacks were called for each step
      const progressMessages = progressCallback.mock.calls.map(
        (call) => (call[0] as { message: string }).message
      );
      expect(progressMessages).toContain("Installing codehydra.vscode-0.0.1.vsix...");
      expect(progressMessages).toContain("Installing sst-dev.opencode...");
      expect(progressMessages).toContain("Writing configuration...");
      expect(progressMessages).toContain("Finalizing setup...");
    });

    it("returns error when extension install fails", async () => {
      mockFs = createMockFileSystemLayer({
        readFile: { content: createExtensionsConfig() },
        mkdir: { implementation: async () => {} },
        copyTree: { result: defaultCopyResult },
      });
      vi.mocked(mockProcessRunner.run).mockReturnValue(
        createMockSpawnedProcess({
          stdout: "",
          stderr: "Failed",
          exitCode: 1,
        })
      );

      const service = new VscodeSetupService(
        mockProcessRunner,
        mockPathProvider,
        "/mock/code-server",
        mockFs
      );
      const result = await service.setup();

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.type).toBe("network");
      }
    });
  });
});
