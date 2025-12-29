// @vitest-environment node
import { join } from "path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { VscodeSetupService } from "./vscode-setup-service";
import { type SetupMarker, type ProcessRunner, type ProcessResult } from "./types";
import type { SpawnedProcess } from "../platform/process";
import type { PathProvider } from "../platform/path-provider";
import { createMockPathProvider } from "../platform/path-provider.test-utils";
import {
  createMockFileSystemLayer,
  createSpyFileSystemLayer,
  createDirEntry,
  type SpyFileSystemLayer,
} from "../platform/filesystem.test-utils";
import { createMockPlatformInfo } from "../platform/platform-info.test-utils";
import { FileSystemError, VscodeSetupError } from "../errors";
import type { FileSystemLayer, PathLike, RmOptions } from "../platform/filesystem";
import type { PlatformInfo } from "../platform/platform-info";
import type { BinaryDownloadService } from "../binary-download/binary-download-service";

/**
 * Helper to check if rm was called with a path containing the given pattern.
 */
function wasRmCalledWith(spyFs: SpyFileSystemLayer, pathPattern: string): boolean {
  const calls = spyFs.rm.mock.calls as Array<[PathLike, RmOptions?]>;
  return calls.some(([path]) => String(path).includes(pathPattern));
}

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
 * Create a mock BinaryDownloadService with controllable behavior.
 */
function createMockBinaryDownloadService(
  overrides?: Partial<{
    isInstalled: (binary: "code-server" | "opencode") => Promise<boolean>;
    download: (binary: "code-server" | "opencode") => Promise<void>;
    createWrapperScripts: () => Promise<void>;
    getBinaryPath: (binary: "code-server" | "opencode") => string;
  }>
): BinaryDownloadService {
  return {
    isInstalled: overrides?.isInstalled ?? vi.fn().mockResolvedValue(false),
    download: overrides?.download ?? vi.fn().mockResolvedValue(undefined),
    createWrapperScripts: overrides?.createWrapperScripts ?? vi.fn().mockResolvedValue(undefined),
    getBinaryPath:
      overrides?.getBinaryPath ?? vi.fn().mockImplementation((binary) => `/mock/${binary}/bin`),
  };
}

/**
 * Create default mock extensions.json content.
 */
function createExtensionsConfig(): string {
  return JSON.stringify({
    marketplace: ["sst-dev.opencode"],
    bundled: [
      {
        id: "codehydra.sidekick",
        version: "0.0.3",
        vsix: "codehydra-sidekick-0.0.3.vsix",
      },
    ],
  });
}

/**
 * Create a preflight result for full setup (all components missing).
 */
function createFullSetupPreflightResult(): {
  success: true;
  needsSetup: boolean;
  missingBinaries: readonly ("code-server" | "opencode")[];
  missingExtensions: readonly string[];
  outdatedExtensions: readonly string[];
} {
  return {
    success: true,
    needsSetup: true,
    missingBinaries: ["code-server", "opencode"],
    missingExtensions: ["codehydra.sidekick", "sst-dev.opencode"],
    outdatedExtensions: [],
  };
}

describe("VscodeSetupService", () => {
  let mockProcessRunner: ProcessRunner;
  let mockPathProvider: PathProvider;
  let mockFs: FileSystemLayer;
  let mockPlatformInfo: PlatformInfo;

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
      setupMarkerPath: "/mock/.setup-completed",
      vscodeAssetsDir: "/mock/assets",
      binDir: "/mock/bin",
    });
    mockFs = createMockFileSystemLayer();
    mockPlatformInfo = createMockPlatformInfo({ platform: "linux" });
  });

  describe("isSetupComplete", () => {
    it("returns true when marker exists with schemaVersion 1", async () => {
      const marker: SetupMarker = {
        schemaVersion: 1,
        completedAt: "2025-12-09T10:00:00.000Z",
      };
      mockFs = createMockFileSystemLayer({
        readFile: { content: JSON.stringify(marker) },
      });

      const service = new VscodeSetupService(mockProcessRunner, mockPathProvider, mockFs);
      const result = await service.isSetupComplete();

      expect(result).toBe(true);
    });

    it("returns false when marker is missing", async () => {
      mockFs = createMockFileSystemLayer({
        readFile: {
          error: new FileSystemError("ENOENT", "/mock/.setup-completed", "Not found"),
        },
      });

      const service = new VscodeSetupService(mockProcessRunner, mockPathProvider, mockFs);
      const result = await service.isSetupComplete();

      expect(result).toBe(false);
    });

    it("returns false when schemaVersion is not 1 (legacy)", async () => {
      const marker: SetupMarker = {
        schemaVersion: 0, // Legacy format (maps from old version field)
        completedAt: "2025-12-09T10:00:00.000Z",
      };
      mockFs = createMockFileSystemLayer({
        readFile: { content: JSON.stringify(marker) },
      });

      const service = new VscodeSetupService(mockProcessRunner, mockPathProvider, mockFs);
      const result = await service.isSetupComplete();

      expect(result).toBe(false);
    });

    it("returns false when marker has invalid JSON", async () => {
      mockFs = createMockFileSystemLayer({
        readFile: { content: "invalid json" },
      });

      const service = new VscodeSetupService(mockProcessRunner, mockPathProvider, mockFs);
      const result = await service.isSetupComplete();

      expect(result).toBe(false);
    });

    it("returns false when marker is missing required fields", async () => {
      mockFs = createMockFileSystemLayer({
        readFile: { content: JSON.stringify({ schemaVersion: "not a number" }) },
      });

      const service = new VscodeSetupService(mockProcessRunner, mockPathProvider, mockFs);
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
            rmPath = String(path); // Convert PathLike to string
            rmOptions = options;
          },
        },
      });

      const service = new VscodeSetupService(mockProcessRunner, mockPathProvider, mockFs);
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

      const service = new VscodeSetupService(mockProcessRunner, invalidPathProvider, mockFs);
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

      const service = new VscodeSetupService(mockProcessRunner, mockPathProvider, mockFs);
      await expect(service.cleanVscodeDir()).rejects.toThrow("Permission denied");
    });
  });

  describe("validateAssets", () => {
    it("succeeds when all required assets exist", async () => {
      mockFs = createMockFileSystemLayer({
        readFile: { content: "{}" },
      });

      const service = new VscodeSetupService(mockProcessRunner, mockPathProvider, mockFs);
      await expect(service.validateAssets()).resolves.not.toThrow();
    });

    it("throws VscodeSetupError when extensions.json is missing", async () => {
      mockFs = createMockFileSystemLayer({
        readFile: {
          error: new FileSystemError("ENOENT", "/mock/assets/extensions.json", "Not found"),
        },
      });

      const service = new VscodeSetupService(mockProcessRunner, mockPathProvider, mockFs);
      await expect(service.validateAssets()).rejects.toThrow(VscodeSetupError);
      await expect(service.validateAssets()).rejects.toThrow(/extensions\.json/);
    });
  });

  describe("installExtensions", () => {
    it("copies bundled vsix to vscodeDir before install", async () => {
      const copiedFiles: Array<{ src: string; dest: string }> = [];
      mockFs = createMockFileSystemLayer({
        readFile: { content: createExtensionsConfig() },
        mkdir: { implementation: async () => {} },
        copyTree: {
          implementation: async (src: PathLike, dest: PathLike) => {
            copiedFiles.push({ src: String(src), dest: String(dest) });
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

      const service = new VscodeSetupService(mockProcessRunner, mockPathProvider, mockFs);
      await service.installExtensions();

      // Verify vsix was copied from assets to vscode dir
      expect(copiedFiles).toContainEqual({
        src: join("/mock/assets", "codehydra-sidekick-0.0.3.vsix"),
        dest: join("/mock/vscode", "codehydra-sidekick-0.0.3.vsix"),
      });
    });

    it("installs bundled extension via code-server", async () => {
      mockFs = createMockFileSystemLayer({
        readFile: { content: createExtensionsConfig() },
        mkdir: { implementation: async () => {} },
        copyTree: {},
      });
      vi.mocked(mockProcessRunner.run).mockReturnValue(
        createMockSpawnedProcess({
          stdout: "Extension installed",
          stderr: "",
          exitCode: 0,
        })
      );

      const service = new VscodeSetupService(mockProcessRunner, mockPathProvider, mockFs);
      await service.installExtensions();

      // First call is for bundled vsix - uses codeServerBinaryPath.toNative() from pathProvider
      expect(mockProcessRunner.run).toHaveBeenCalledWith(
        mockPathProvider.codeServerBinaryPath.toNative(),
        [
          "--install-extension",
          join("/mock/vscode", "codehydra-sidekick-0.0.3.vsix"),
          "--extensions-dir",
          "/mock/vscode/extensions",
        ]
      );
    });

    it("installs marketplace extensions by ID", async () => {
      mockFs = createMockFileSystemLayer({
        readFile: { content: createExtensionsConfig() },
        mkdir: { implementation: async () => {} },
        copyTree: {},
      });
      vi.mocked(mockProcessRunner.run).mockReturnValue(
        createMockSpawnedProcess({
          stdout: "Extension installed",
          stderr: "",
          exitCode: 0,
        })
      );

      const service = new VscodeSetupService(mockProcessRunner, mockPathProvider, mockFs);
      await service.installExtensions();

      // Second call is for marketplace extension - uses codeServerBinaryPath.toNative() from pathProvider
      expect(mockProcessRunner.run).toHaveBeenCalledWith(
        mockPathProvider.codeServerBinaryPath.toNative(),
        ["--install-extension", "sst-dev.opencode", "--extensions-dir", "/mock/vscode/extensions"]
      );
    });

    it("handles mixed extensions in order (bundled first, then marketplace)", async () => {
      mockFs = createMockFileSystemLayer({
        readFile: { content: createExtensionsConfig() },
        mkdir: { implementation: async () => {} },
        copyTree: {},
      });
      vi.mocked(mockProcessRunner.run).mockReturnValue(
        createMockSpawnedProcess({
          stdout: "Extension installed",
          stderr: "",
          exitCode: 0,
        })
      );
      const progressCallback = vi.fn();

      const service = new VscodeSetupService(mockProcessRunner, mockPathProvider, mockFs);
      await service.installExtensions(progressCallback);

      // Verify order: bundled vsix first, then marketplace
      expect(mockProcessRunner.run).toHaveBeenCalledTimes(2);
      const calls = vi.mocked(mockProcessRunner.run).mock.calls;
      expect(calls[0]?.[1]?.[1]).toBe(join("/mock/vscode", "codehydra-sidekick-0.0.3.vsix"));
      expect(calls[1]?.[1]?.[1]).toBe("sst-dev.opencode");

      // Verify progress messages
      const progressMessages = progressCallback.mock.calls.map(
        (call) => (call[0] as { message: string }).message
      );
      expect(progressMessages).toContain("Installing codehydra.sidekick...");
      expect(progressMessages).toContain("Installing sst-dev.opencode...");
    });

    it("returns error on non-zero exit code", async () => {
      mockFs = createMockFileSystemLayer({
        readFile: { content: createExtensionsConfig() },
        mkdir: { implementation: async () => {} },
        copyTree: {},
      });
      vi.mocked(mockProcessRunner.run).mockReturnValue(
        createMockSpawnedProcess({
          stdout: "",
          stderr: "Failed to install extension",
          exitCode: 1,
        })
      );

      const service = new VscodeSetupService(mockProcessRunner, mockPathProvider, mockFs);
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
        copyTree: {},
      });
      vi.mocked(mockProcessRunner.run).mockReturnValue(
        createMockSpawnedProcess({
          stdout: "",
          stderr: "spawn ENOENT: code-server not found",
          exitCode: null,
        })
      );

      const service = new VscodeSetupService(mockProcessRunner, mockPathProvider, mockFs);
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

  describe("writeCompletionMarker", () => {
    it("writes marker file with version and timestamp", async () => {
      const writtenFiles: Map<string, string> = new Map();
      mockFs = createMockFileSystemLayer({
        writeFile: {
          implementation: async (path: PathLike, content: string) => {
            writtenFiles.set(String(path), content);
          },
        },
      });
      const progressCallback = vi.fn();

      const service = new VscodeSetupService(mockProcessRunner, mockPathProvider, mockFs);
      await service.writeCompletionMarker(progressCallback);

      // Verify marker written
      const markerPath = "/mock/.setup-completed";
      expect(writtenFiles.has(markerPath)).toBe(true);

      // Verify content structure
      const markerContent = writtenFiles.get(markerPath)!;
      const marker = JSON.parse(markerContent) as SetupMarker;
      expect(marker.schemaVersion).toBe(1);
      expect(marker.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      // Verify progress callback called
      expect(progressCallback).toHaveBeenCalledWith({
        step: "finalize",
        message: "Finalizing setup...",
      });
    });
  });

  describe("setup", () => {
    it("validates assets before proceeding", async () => {
      mockFs = createMockFileSystemLayer({
        readFile: {
          error: new FileSystemError("ENOENT", "/mock/assets/extensions.json", "Not found"),
        },
      });

      const service = new VscodeSetupService(mockProcessRunner, mockPathProvider, mockFs);
      const preflight = createFullSetupPreflightResult();
      await expect(service.setup(preflight)).rejects.toThrow(VscodeSetupError);
      await expect(service.setup(preflight)).rejects.toThrow(/Required asset files not found/);
    });

    it("runs all setup steps in order and returns success", async () => {
      mockFs = createMockFileSystemLayer({
        readFile: { content: createExtensionsConfig() },
        mkdir: { implementation: async () => {} },
        copyTree: {},
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
      const service = new VscodeSetupService(mockProcessRunner, mockPathProvider, mockFs);
      const preflight = createFullSetupPreflightResult();
      const result = await service.setup(preflight, progressCallback);

      expect(result).toEqual({ success: true });

      // Verify progress callbacks were called for each step
      const progressMessages = progressCallback.mock.calls.map(
        (call) => (call[0] as { message: string }).message
      );
      expect(progressMessages).toContain("Installing codehydra.sidekick...");
      expect(progressMessages).toContain("Installing sst-dev.opencode...");
      expect(progressMessages).toContain("Creating CLI wrapper scripts...");
      expect(progressMessages).toContain("Finalizing setup...");
    });

    it("returns error when extension install fails", async () => {
      mockFs = createMockFileSystemLayer({
        readFile: { content: createExtensionsConfig() },
        mkdir: { implementation: async () => {} },
        copyTree: {},
      });
      vi.mocked(mockProcessRunner.run).mockReturnValue(
        createMockSpawnedProcess({
          stdout: "",
          stderr: "Failed",
          exitCode: 1,
        })
      );

      const service = new VscodeSetupService(mockProcessRunner, mockPathProvider, mockFs);
      const preflight = createFullSetupPreflightResult();
      const result = await service.setup(preflight);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.type).toBe("network");
      }
    });
  });

  describe("setupBinDirectory", () => {
    it("creates bin directory", async () => {
      const createdDirs: string[] = [];
      const writtenFiles = new Map<string, string>();

      mockFs = createMockFileSystemLayer({
        mkdir: {
          implementation: async (path: PathLike) => {
            createdDirs.push(String(path));
          },
        },
        writeFile: {
          implementation: async (path: PathLike, content: string) => {
            writtenFiles.set(String(path), content);
          },
        },
        makeExecutable: { implementation: async () => {} },
      });

      const service = new VscodeSetupService(
        mockProcessRunner,
        mockPathProvider,
        mockFs,
        mockPlatformInfo
      );
      await service.setupBinDirectory();

      expect(createdDirs).toContain("/mock/bin");
    });

    it("generates scripts for current platform", async () => {
      const writtenFiles = new Map<string, string>();

      mockFs = createMockFileSystemLayer({
        mkdir: { implementation: async () => {} },
        writeFile: {
          implementation: async (path: PathLike, content: string) => {
            writtenFiles.set(String(path), content);
          },
        },
        makeExecutable: { implementation: async () => {} },
      });

      const service = new VscodeSetupService(
        mockProcessRunner,
        mockPathProvider,
        mockFs,
        createMockPlatformInfo({ platform: "linux" })
      );
      await service.setupBinDirectory();

      // Should generate code script (opencode may be skipped if not found)
      // Note: code-server wrapper is not generated - we launch code-server directly
      expect(writtenFiles.has(join("/mock/bin", "code"))).toBe(true);

      // Scripts should be Unix-style (shebang)
      const codeScript = writtenFiles.get(join("/mock/bin", "code"));
      expect(codeScript).toMatch(/^#!/);
    });

    it("calls makeExecutable on Unix scripts", async () => {
      const executablePaths: string[] = [];

      mockFs = createMockFileSystemLayer({
        mkdir: { implementation: async () => {} },
        writeFile: { implementation: async () => {} },
        makeExecutable: {
          implementation: async (path: PathLike) => {
            executablePaths.push(String(path));
          },
        },
      });

      const service = new VscodeSetupService(
        mockProcessRunner,
        mockPathProvider,
        mockFs,
        createMockPlatformInfo({ platform: "linux" })
      );
      await service.setupBinDirectory();

      // Should call makeExecutable for each Unix script (code, and opencode if found)
      // Note: code-server wrapper is not generated - we launch code-server directly
      expect(executablePaths).toContain(join("/mock/bin", "code"));
    });

    it("does not call makeExecutable on Windows", async () => {
      const executablePaths: string[] = [];

      mockFs = createMockFileSystemLayer({
        mkdir: { implementation: async () => {} },
        writeFile: { implementation: async () => {} },
        makeExecutable: {
          implementation: async (path: PathLike) => {
            executablePaths.push(String(path));
          },
        },
      });

      const service = new VscodeSetupService(
        mockProcessRunner,
        mockPathProvider,
        mockFs,
        createMockPlatformInfo({ platform: "win32" })
      );
      await service.setupBinDirectory();

      // Should NOT call makeExecutable for Windows scripts
      expect(executablePaths).toHaveLength(0);
    });

    it("handles mkdir failure", async () => {
      mockFs = createMockFileSystemLayer({
        mkdir: {
          error: new FileSystemError("EACCES", "/mock/bin", "Permission denied"),
        },
      });

      const service = new VscodeSetupService(
        mockProcessRunner,
        mockPathProvider,
        mockFs,
        mockPlatformInfo
      );

      await expect(service.setupBinDirectory()).rejects.toThrow("Permission denied");
    });

    it("handles writeFile failure", async () => {
      mockFs = createMockFileSystemLayer({
        mkdir: { implementation: async () => {} },
        writeFile: {
          error: new FileSystemError("EACCES", "/mock/bin/code", "Permission denied"),
        },
      });

      const service = new VscodeSetupService(
        mockProcessRunner,
        mockPathProvider,
        mockFs,
        mockPlatformInfo
      );

      await expect(service.setupBinDirectory()).rejects.toThrow("Permission denied");
    });

    it("emits progress event", async () => {
      mockFs = createMockFileSystemLayer({
        mkdir: { implementation: async () => {} },
        writeFile: { implementation: async () => {} },
        makeExecutable: { implementation: async () => {} },
      });
      const progressCallback = vi.fn();

      const service = new VscodeSetupService(
        mockProcessRunner,
        mockPathProvider,
        mockFs,
        mockPlatformInfo
      );
      await service.setupBinDirectory(progressCallback);

      expect(progressCallback).toHaveBeenCalledWith({
        step: "config",
        message: "Creating CLI wrapper scripts...",
      });
    });
  });

  describe("binary download integration", () => {
    it("downloads binaries first when BinaryDownloadService is provided", async () => {
      const downloadOrder: string[] = [];
      const mockBinaryService = createMockBinaryDownloadService({
        isInstalled: vi.fn().mockResolvedValue(false),
        download: vi.fn().mockImplementation(async (binary) => {
          downloadOrder.push(`download:${binary}`);
        }),
        createWrapperScripts: vi.fn().mockImplementation(async () => {
          downloadOrder.push("createWrapperScripts");
        }),
      });

      mockFs = createMockFileSystemLayer({
        readFile: { content: createExtensionsConfig() },
        mkdir: { implementation: async () => {} },
        copyTree: {},
        writeFile: { implementation: async () => {} },
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
        mockFs,
        mockPlatformInfo,
        mockBinaryService
      );
      const preflight = createFullSetupPreflightResult();
      const result = await service.setup(preflight);

      expect(result).toEqual({ success: true });
      // Verify binaries are downloaded before extensions (using preflight result)
      expect(downloadOrder).toEqual([
        "download:code-server",
        "download:opencode",
        "createWrapperScripts",
      ]);
      // Note: isInstalled is NOT called during setup when preflight is passed
      // The preflight result already contains missingBinaries info
    });

    it("skips download when preflight indicates binaries already installed", async () => {
      const mockBinaryService = createMockBinaryDownloadService({
        isInstalled: vi.fn().mockResolvedValue(true), // Not used when preflight passed
        download: vi.fn(),
        createWrapperScripts: vi.fn(),
      });

      mockFs = createMockFileSystemLayer({
        readFile: { content: createExtensionsConfig() },
        mkdir: { implementation: async () => {} },
        copyTree: {},
        writeFile: { implementation: async () => {} },
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
        mockFs,
        mockPlatformInfo,
        mockBinaryService
      );
      // Use preflight with empty missingBinaries to indicate already installed
      const preflight: {
        success: true;
        needsSetup: boolean;
        missingBinaries: readonly ("code-server" | "opencode")[];
        missingExtensions: readonly string[];
        outdatedExtensions: readonly string[];
      } = {
        success: true,
        needsSetup: true, // Still needs setup for extensions
        missingBinaries: [], // No missing binaries
        missingExtensions: ["codehydra.codehydra", "sst-dev.opencode"],
        outdatedExtensions: [],
      };
      await service.setup(preflight);

      // Should NOT download when preflight says no binaries missing
      expect(mockBinaryService.download).not.toHaveBeenCalled();
      // Should still create wrapper scripts
      expect(mockBinaryService.createWrapperScripts).toHaveBeenCalled();
    });

    it("returns error when binary download fails", async () => {
      const mockBinaryService = createMockBinaryDownloadService({
        isInstalled: vi.fn().mockResolvedValue(false),
        download: vi.fn().mockRejectedValue(new Error("Network timeout")),
        createWrapperScripts: vi.fn(),
      });

      mockFs = createMockFileSystemLayer({
        readFile: { content: createExtensionsConfig() },
      });

      const service = new VscodeSetupService(
        mockProcessRunner,
        mockPathProvider,
        mockFs,
        mockPlatformInfo,
        mockBinaryService
      );
      const preflight = createFullSetupPreflightResult();
      const result = await service.setup(preflight);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.type).toBe("network");
        expect(result.error.message).toContain("Failed to download code-server");
        expect(result.error.message).toContain("Network timeout");
      }
    });

    it("emits progress events during binary download", async () => {
      const mockBinaryService = createMockBinaryDownloadService({
        isInstalled: vi.fn().mockResolvedValue(false),
        download: vi.fn().mockResolvedValue(undefined),
        createWrapperScripts: vi.fn().mockResolvedValue(undefined),
      });

      mockFs = createMockFileSystemLayer({
        readFile: { content: createExtensionsConfig() },
        mkdir: { implementation: async () => {} },
        copyTree: {},
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
        mockFs,
        mockPlatformInfo,
        mockBinaryService
      );
      const preflight = createFullSetupPreflightResult();
      await service.setup(preflight, progressCallback);

      const progressMessages = progressCallback.mock.calls.map(
        (call) => call[0] as { message: string; step: string }
      );

      expect(progressMessages).toContainEqual({
        step: "binary-download",
        message: "Setting up code-server...",
      });
      expect(progressMessages).toContainEqual({
        step: "binary-download",
        message: "Setting up opencode...",
      });
    });

    it("works without BinaryDownloadService (backward compatibility)", async () => {
      mockFs = createMockFileSystemLayer({
        readFile: { content: createExtensionsConfig() },
        mkdir: { implementation: async () => {} },
        copyTree: {},
        writeFile: { implementation: async () => {} },
      });
      vi.mocked(mockProcessRunner.run).mockReturnValue(
        createMockSpawnedProcess({
          stdout: "Extension installed",
          stderr: "",
          exitCode: 0,
        })
      );

      // No binaryDownloadService passed
      const service = new VscodeSetupService(
        mockProcessRunner,
        mockPathProvider,
        mockFs,
        mockPlatformInfo
      );
      const preflight = createFullSetupPreflightResult();
      const result = await service.setup(preflight);

      expect(result).toEqual({ success: true });
    });
  });

  describe("cleanComponents", () => {
    it("removes only specified extension directories", async () => {
      const spyFs = createSpyFileSystemLayer({
        readdir: {
          entries: [
            createDirEntry("codehydra.codehydra-0.0.1", { isDirectory: true }),
            createDirEntry("sst-dev.opencode-1.0.0", { isDirectory: true }),
            createDirEntry("other.extension-2.0.0", { isDirectory: true }),
          ],
        },
      });

      const service = new VscodeSetupService(mockProcessRunner, mockPathProvider, spyFs);
      await service.cleanComponents(["codehydra.codehydra"]);

      // Should only remove the specified extension
      expect(wasRmCalledWith(spyFs, "codehydra.codehydra-0.0.1")).toBe(true);
      // Should not remove other extensions
      expect(wasRmCalledWith(spyFs, "sst-dev.opencode")).toBe(false);
      expect(wasRmCalledWith(spyFs, "other.extension")).toBe(false);
    });

    it("handles extension that is not installed (no error)", async () => {
      const spyFs = createSpyFileSystemLayer({
        readdir: {
          entries: [createDirEntry("sst-dev.opencode-1.0.0", { isDirectory: true })],
        },
      });

      const service = new VscodeSetupService(mockProcessRunner, mockPathProvider, spyFs);
      // Should not throw even if extension is not found
      await expect(service.cleanComponents(["codehydra.codehydra"])).resolves.not.toThrow();
      expect(spyFs.rm).not.toHaveBeenCalled();
    });

    it("cleans multiple extensions at once", async () => {
      const spyFs = createSpyFileSystemLayer({
        readdir: {
          entries: [
            createDirEntry("codehydra.codehydra-0.0.1", { isDirectory: true }),
            createDirEntry("sst-dev.opencode-1.0.0", { isDirectory: true }),
          ],
        },
      });

      const service = new VscodeSetupService(mockProcessRunner, mockPathProvider, spyFs);
      await service.cleanComponents(["codehydra.codehydra", "sst-dev.opencode"]);

      // Should remove both extensions
      expect(wasRmCalledWith(spyFs, "codehydra.codehydra-0.0.1")).toBe(true);
      expect(wasRmCalledWith(spyFs, "sst-dev.opencode-1.0.0")).toBe(true);
    });
  });
});
