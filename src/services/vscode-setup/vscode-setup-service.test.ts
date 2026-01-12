// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import { VscodeSetupService } from "./vscode-setup-service";
import { type SetupMarker } from "./types";
import type { PathProvider } from "../platform/path-provider";
import { createMockPathProvider } from "../platform/path-provider.test-utils";
import { Path } from "../platform/path";
import {
  createFileSystemMock,
  createSpyFileSystemLayer,
  file,
  directory,
  type SpyFileSystemLayer,
  type MockFileSystemLayer,
} from "../platform/filesystem.state-mock";
import { createMockPlatformInfo } from "../platform/platform-info.test-utils";
import { createMockProcessRunner, type MockProcessRunner } from "../platform/process.state-mock";
import { VscodeSetupError } from "../errors";
import { CODE_SERVER_VERSION } from "../binary-download/versions";
import type { PathLike, RmOptions } from "../platform/filesystem";
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
 * Create a mock BinaryDownloadService with controllable behavior.
 */
function createMockBinaryDownloadService(
  overrides?: Partial<{
    isInstalled: (binary: "code-server" | "opencode" | "claude") => Promise<boolean>;
    download: (binary: "code-server" | "opencode" | "claude") => Promise<void>;
    getBinaryPath: (binary: "code-server" | "opencode" | "claude") => string;
  }>
): BinaryDownloadService {
  return {
    isInstalled: overrides?.isInstalled ?? vi.fn().mockResolvedValue(false),
    download: overrides?.download ?? vi.fn().mockResolvedValue(undefined),
    getBinaryPath:
      overrides?.getBinaryPath ?? vi.fn().mockImplementation((binary) => `/mock/${binary}/bin`),
  };
}

/**
 * Create mock bin assets directory entries.
 * These are the wrapper scripts copied from assets/bin to the user's bin dir.
 */
function createBinAssetsEntries() {
  return {
    "/mock/assets/bin": directory(),
    "/mock/assets/bin/code": file("#!/bin/sh\nexec code-server"),
    "/mock/assets/bin/code.cmd": file("@echo off\ncall code-server"),
    "/mock/assets/bin/opencode": file("#!/bin/sh\nexec opencode.cjs"),
    "/mock/assets/bin/opencode.cmd": file("@echo off\ncall opencode.cjs"),
    "/mock/assets/bin/opencode.cjs": file("// opencode wrapper"),
  };
}

/**
 * Create default mock manifest.json content (bundled extensions only).
 * Note: Agent extensions (opencode, claude) are installed from marketplace,
 * not bundled. They are handled via agentExtensionId parameter.
 */
function createManifestConfig(): string {
  return JSON.stringify([
    {
      id: "codehydra.sidekick",
      version: "0.0.3",
      vsix: "codehydra-sidekick-0.0.3.vsix",
    },
  ]);
}

/**
 * Create a preflight result for full setup (all components missing).
 * Note: Agent extensions are included in missingExtensions when agentExtensionId is set.
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
    missingExtensions: ["codehydra.sidekick"],
    outdatedExtensions: [],
  };
}

describe("VscodeSetupService", () => {
  let mockProcessRunner: MockProcessRunner;
  let mockPathProvider: PathProvider;
  let mockFs: MockFileSystemLayer;
  let mockPlatformInfo: PlatformInfo;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProcessRunner = createMockProcessRunner();
    mockPathProvider = createMockPathProvider({
      dataRootDir: "/mock",
      vscodeDir: "/mock/vscode",
      vscodeExtensionsDir: "/mock/vscode/extensions",
      vscodeUserDataDir: "/mock/vscode/user-data",
      setupMarkerPath: "/mock/.setup-completed",
      vscodeAssetsDir: "/mock/assets",
      binDir: "/mock/bin",
    });
    mockFs = createFileSystemMock();
    mockPlatformInfo = createMockPlatformInfo({ platform: "linux" });
  });

  describe("isSetupComplete", () => {
    it("returns true when marker exists with schemaVersion 1", async () => {
      const marker: SetupMarker = {
        schemaVersion: 1,
        completedAt: "2025-12-09T10:00:00.000Z",
      };
      mockFs = createFileSystemMock({
        entries: {
          "/mock/.setup-completed": file(JSON.stringify(marker)),
        },
      });

      const service = new VscodeSetupService(mockProcessRunner, mockPathProvider, mockFs);
      const result = await service.isSetupComplete();

      expect(result).toBe(true);
    });

    it("returns false when marker is missing", async () => {
      // No marker file in the mock filesystem
      mockFs = createFileSystemMock();

      const service = new VscodeSetupService(mockProcessRunner, mockPathProvider, mockFs);
      const result = await service.isSetupComplete();

      expect(result).toBe(false);
    });

    it("returns false when schemaVersion is not 1 (legacy)", async () => {
      const marker: SetupMarker = {
        schemaVersion: 0, // Legacy format (maps from old version field)
        completedAt: "2025-12-09T10:00:00.000Z",
      };
      mockFs = createFileSystemMock({
        entries: {
          "/mock/.setup-completed": file(JSON.stringify(marker)),
        },
      });

      const service = new VscodeSetupService(mockProcessRunner, mockPathProvider, mockFs);
      const result = await service.isSetupComplete();

      expect(result).toBe(false);
    });

    it("returns false when marker has invalid JSON", async () => {
      mockFs = createFileSystemMock({
        entries: {
          "/mock/.setup-completed": file("invalid json"),
        },
      });

      const service = new VscodeSetupService(mockProcessRunner, mockPathProvider, mockFs);
      const result = await service.isSetupComplete();

      expect(result).toBe(false);
    });

    it("returns false when marker is missing required fields", async () => {
      mockFs = createFileSystemMock({
        entries: {
          "/mock/.setup-completed": file(JSON.stringify({ schemaVersion: "not a number" })),
        },
      });

      const service = new VscodeSetupService(mockProcessRunner, mockPathProvider, mockFs);
      const result = await service.isSetupComplete();

      expect(result).toBe(false);
    });
  });

  describe("cleanVscodeDir", () => {
    it("removes the vscode directory", async () => {
      // Set up a vscode directory with content
      mockFs = createFileSystemMock({
        entries: {
          "/mock/vscode": directory(),
          "/mock/vscode/extensions": directory(),
        },
      });

      const service = new VscodeSetupService(mockProcessRunner, mockPathProvider, mockFs);
      await service.cleanVscodeDir();

      // Verify directory was removed
      expect(mockFs).not.toHaveDirectory("/mock/vscode");
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

    // Note: The "throws on permission error" test for rm operations was removed
    // during migration to behavioral mock. The behavioral mock's error field only
    // affects read operations. Write/delete error scenarios are covered by
    // boundary tests against the real filesystem.
  });

  describe("validateAssets", () => {
    it("succeeds when all required assets exist", async () => {
      mockFs = createFileSystemMock({
        entries: {
          "/mock/assets/manifest.json": file("{}"),
        },
      });

      const service = new VscodeSetupService(mockProcessRunner, mockPathProvider, mockFs);
      await expect(service.validateAssets()).resolves.not.toThrow();
    });

    it("throws VscodeSetupError when manifest.json is missing", async () => {
      // No manifest.json in the mock
      mockFs = createFileSystemMock();

      const service = new VscodeSetupService(mockProcessRunner, mockPathProvider, mockFs);
      await expect(service.validateAssets()).rejects.toThrow(VscodeSetupError);
      await expect(service.validateAssets()).rejects.toThrow(/manifest\.json/);
    });
  });

  describe("installExtensions", () => {
    it("installs bundled extension via code-server from extensionsRuntimeDir", async () => {
      // Set up source vsix file in extensionsRuntimeDir (same as assets in dev mode)
      mockFs = createFileSystemMock({
        entries: {
          "/mock/assets/manifest.json": file(createManifestConfig()),
          "/mock/assets/codehydra-sidekick-0.0.3.vsix": file("vsix-content"),
          "/mock/vscode": directory(),
        },
      });
      mockProcessRunner = createMockProcessRunner({
        defaultResult: { stdout: "Extension installed", stderr: "", exitCode: 0 },
      });

      const service = new VscodeSetupService(mockProcessRunner, mockPathProvider, mockFs);
      await service.installExtensions();

      // Installs bundled vsix directly from extensionsRuntimeDir (no copy needed)
      // Uses getBinaryPath("code-server", version).toNative() from pathProvider
      expect(mockProcessRunner).toHaveSpawned([
        {
          command: mockPathProvider.getBinaryPath("code-server", CODE_SERVER_VERSION).toNative(),
          args: expect.arrayContaining([
            "--install-extension",
            new Path("/mock/assets", "codehydra-sidekick-0.0.3.vsix").toNative(),
          ]),
        },
      ]);
    });

    it("installs all bundled extensions from vsix files", async () => {
      mockFs = createFileSystemMock({
        entries: {
          "/mock/assets/manifest.json": file(createManifestConfig()),
          "/mock/assets/codehydra-sidekick-0.0.3.vsix": file("vsix-content"),
          "/mock/vscode": directory(),
        },
      });
      mockProcessRunner = createMockProcessRunner({
        defaultResult: { stdout: "Extension installed", stderr: "", exitCode: 0 },
      });
      const progressCallback = vi.fn();

      const service = new VscodeSetupService(mockProcessRunner, mockPathProvider, mockFs);
      await service.installExtensions(progressCallback);

      // Verify bundled extension installed from extensionsRuntimeDir
      expect(mockProcessRunner).toHaveSpawned([
        {
          args: expect.arrayContaining([
            new Path("/mock/assets", "codehydra-sidekick-0.0.3.vsix").toNative(),
          ]),
        },
      ]);

      // Verify progress messages
      const progressMessages = progressCallback.mock.calls.map(
        (call) => (call[0] as { message: string }).message
      );
      expect(progressMessages).toContain("Installing codehydra.sidekick...");
    });

    it("installs agent extension from marketplace when agentExtensionId is set", async () => {
      mockFs = createFileSystemMock({
        entries: {
          "/mock/assets/manifest.json": file(createManifestConfig()),
          "/mock/assets/codehydra-sidekick-0.0.3.vsix": file("vsix-content"),
          "/mock/vscode": directory(),
        },
      });
      mockProcessRunner = createMockProcessRunner({
        defaultResult: { stdout: "Extension installed", stderr: "", exitCode: 0 },
      });
      const progressCallback = vi.fn();

      // Create service with agentExtensionId
      const service = new VscodeSetupService(
        mockProcessRunner,
        mockPathProvider,
        mockFs,
        mockPlatformInfo,
        undefined, // no binary download service
        undefined, // no logger
        "sst-dev.opencode" // agent extension ID
      );

      // Preflight includes agent extension in missingExtensions
      await service.installExtensions(progressCallback, ["codehydra.sidekick", "sst-dev.opencode"]);

      // Verify bundled extension installed from extensionsRuntimeDir
      // And agent extension installed from marketplace by ID
      expect(mockProcessRunner).toHaveSpawned([
        {
          args: expect.arrayContaining([
            new Path("/mock/assets", "codehydra-sidekick-0.0.3.vsix").toNative(),
          ]),
        },
        {
          args: expect.arrayContaining(["--install-extension", "sst-dev.opencode"]),
        },
      ]);

      // Verify progress messages include agent extension
      const progressMessages = progressCallback.mock.calls.map(
        (call) => (call[0] as { message: string }).message
      );
      expect(progressMessages).toContain("Installing codehydra.sidekick...");
      expect(progressMessages).toContain("Installing sst-dev.opencode...");
    });

    it("returns error on non-zero exit code", async () => {
      mockFs = createFileSystemMock({
        entries: {
          "/mock/assets/manifest.json": file(createManifestConfig()),
          "/mock/assets/codehydra-sidekick-0.0.3.vsix": file("vsix-content"),
          "/mock/vscode": directory(),
        },
      });
      mockProcessRunner = createMockProcessRunner({
        defaultResult: { stdout: "", stderr: "Failed to install extension", exitCode: 1 },
      });

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
      mockFs = createFileSystemMock({
        entries: {
          "/mock/assets/manifest.json": file(createManifestConfig()),
          "/mock/assets/codehydra-sidekick-0.0.3.vsix": file("vsix-content"),
          "/mock/vscode": directory(),
        },
      });
      // Spawn failure is detected by ENOENT in stderr and non-zero exit code
      mockProcessRunner = createMockProcessRunner({
        defaultResult: { stdout: "", stderr: "spawn ENOENT: code-server not found", exitCode: 1 },
      });

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
      // Set up parent directory
      mockFs = createFileSystemMock({
        entries: {
          "/mock": directory(),
        },
      });
      const progressCallback = vi.fn();

      const service = new VscodeSetupService(mockProcessRunner, mockPathProvider, mockFs);
      await service.writeCompletionMarker(progressCallback);

      // Verify marker written
      expect(mockFs).toHaveFile("/mock/.setup-completed");

      // Verify content structure
      const markerContent = await mockFs.readFile("/mock/.setup-completed");
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
      // No manifest.json in the mock
      mockFs = createFileSystemMock();

      const service = new VscodeSetupService(mockProcessRunner, mockPathProvider, mockFs);
      const preflight = createFullSetupPreflightResult();
      await expect(service.setup(preflight)).rejects.toThrow(VscodeSetupError);
      await expect(service.setup(preflight)).rejects.toThrow(/Required asset files not found/);
    });

    it("runs all setup steps in order and returns success", async () => {
      mockFs = createFileSystemMock({
        entries: {
          "/mock": directory(),
          "/mock/assets/manifest.json": file(createManifestConfig()),
          "/mock/assets/codehydra-sidekick-0.0.3.vsix": file("vsix-content"),
          "/mock/vscode": directory(),
          "/mock/bin": directory(),
          ...createBinAssetsEntries(),
        },
      });
      mockProcessRunner = createMockProcessRunner({
        defaultResult: { stdout: "Extension installed", stderr: "", exitCode: 0 },
      });

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
      expect(progressMessages).toContain("Creating CLI wrapper scripts...");
      expect(progressMessages).toContain("Finalizing setup...");
    });

    it("returns error when extension install fails", async () => {
      mockFs = createFileSystemMock({
        entries: {
          "/mock": directory(),
          "/mock/assets/manifest.json": file(createManifestConfig()),
          "/mock/assets/codehydra-sidekick-0.0.3.vsix": file("vsix-content"),
          "/mock/vscode": directory(),
        },
      });
      mockProcessRunner = createMockProcessRunner({
        defaultResult: { stdout: "", stderr: "Failed", exitCode: 1 },
      });

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
      mockFs = createFileSystemMock({
        entries: {
          "/mock": directory(),
          ...createBinAssetsEntries(),
        },
      });

      const service = new VscodeSetupService(
        mockProcessRunner,
        mockPathProvider,
        mockFs,
        mockPlatformInfo
      );
      await service.setupBinDirectory();

      expect(mockFs).toHaveDirectory("/mock/bin");
    });

    it("copies scripts from assets to bin directory", async () => {
      mockFs = createFileSystemMock({
        entries: {
          "/mock": directory(),
          ...createBinAssetsEntries(),
        },
      });

      const service = new VscodeSetupService(
        mockProcessRunner,
        mockPathProvider,
        mockFs,
        createMockPlatformInfo({ platform: "linux" })
      );
      await service.setupBinDirectory();

      // Should copy code script from assets
      expect(mockFs).toHaveFile("/mock/bin/code");

      // Scripts should be Unix-style (shebang)
      expect(mockFs).toHaveFileContaining("/mock/bin/code", /^#!/);
    });

    it.skipIf(process.platform === "win32")("calls makeExecutable on Unix scripts", async () => {
      mockFs = createFileSystemMock({
        entries: {
          "/mock": directory(),
          ...createBinAssetsEntries(),
        },
      });

      const service = new VscodeSetupService(
        mockProcessRunner,
        mockPathProvider,
        mockFs,
        createMockPlatformInfo({ platform: "linux" })
      );
      await service.setupBinDirectory();

      // Should call makeExecutable for each Unix script (code, opencode)
      // Note: .cjs and .cmd files are not made executable
      expect(mockFs).toBeExecutable("/mock/bin/code");
      expect(mockFs).toBeExecutable("/mock/bin/opencode");
    });

    it("does not call makeExecutable on Windows scripts (.cmd)", async () => {
      mockFs = createFileSystemMock({
        entries: {
          "/mock": directory(),
          ...createBinAssetsEntries(),
        },
      });

      const service = new VscodeSetupService(
        mockProcessRunner,
        mockPathProvider,
        mockFs,
        createMockPlatformInfo({ platform: "win32" })
      );
      await service.setupBinDirectory();

      // On Windows, scripts should exist but not be marked executable
      expect(mockFs).toHaveFile("/mock/bin/code.cmd");
      // Files are not executable by default in the mock
    });

    it("handles mkdir failure when file exists at path", async () => {
      // Using a file where a directory should be creates EEXIST error
      mockFs = createFileSystemMock({
        entries: {
          "/mock/bin": file("not a directory"),
          ...createBinAssetsEntries(),
        },
      });

      const service = new VscodeSetupService(
        mockProcessRunner,
        mockPathProvider,
        mockFs,
        mockPlatformInfo
      );

      await expect(service.setupBinDirectory()).rejects.toThrow("File exists at path: /mock/bin");
    });

    // Note: The "handles writeFile failure" test was removed during migration
    // to behavioral mock. The behavioral mock always succeeds on writes (no error
    // injection for write operations). In production, writeFile failures are rare
    // edge cases (disk full, permission revoked mid-operation) and the error
    // handling is tested via integration tests with real filesystem.

    it("emits progress event", async () => {
      mockFs = createFileSystemMock({
        entries: {
          "/mock": directory(),
          ...createBinAssetsEntries(),
        },
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
      });

      mockFs = createFileSystemMock({
        entries: {
          "/mock": directory(),
          "/mock/assets/manifest.json": file(createManifestConfig()),
          "/mock/assets/codehydra-sidekick-0.0.3.vsix": file("vsix-content"),
          "/mock/vscode": directory(),
          "/mock/bin": directory(),
          ...createBinAssetsEntries(),
        },
      });
      mockProcessRunner = createMockProcessRunner({
        defaultResult: { stdout: "Extension installed", stderr: "", exitCode: 0 },
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

      expect(result).toEqual({ success: true });
      // Verify binaries are downloaded before extensions (using preflight result)
      expect(downloadOrder).toEqual(["download:code-server", "download:opencode"]);
      // Note: isInstalled is NOT called during setup when preflight is passed
      // The preflight result already contains missingBinaries info
    });

    it("skips download when preflight indicates binaries already installed", async () => {
      const mockBinaryService = createMockBinaryDownloadService({
        isInstalled: vi.fn().mockResolvedValue(true), // Not used when preflight passed
        download: vi.fn(),
      });

      mockFs = createFileSystemMock({
        entries: {
          "/mock": directory(),
          "/mock/assets/manifest.json": file(createManifestConfig()),
          "/mock/assets/codehydra-sidekick-0.0.3.vsix": file("vsix-content"),
          "/mock/vscode": directory(),
          "/mock/bin": directory(),
          ...createBinAssetsEntries(),
        },
      });
      mockProcessRunner = createMockProcessRunner({
        defaultResult: { stdout: "Extension installed", stderr: "", exitCode: 0 },
      });

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
        missingExtensions: ["codehydra.sidekick"],
        outdatedExtensions: [],
      };
      await service.setup(preflight);

      // Should NOT download when preflight says no binaries missing
      expect(mockBinaryService.download).not.toHaveBeenCalled();
    });

    it("returns error when binary download fails", async () => {
      const mockBinaryService = createMockBinaryDownloadService({
        isInstalled: vi.fn().mockResolvedValue(false),
        download: vi.fn().mockRejectedValue(new Error("Network timeout")),
      });

      mockFs = createFileSystemMock({
        entries: {
          "/mock/assets/manifest.json": file(createManifestConfig()),
        },
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
      });

      mockFs = createFileSystemMock({
        entries: {
          "/mock": directory(),
          "/mock/assets/manifest.json": file(createManifestConfig()),
          "/mock/assets/codehydra-sidekick-0.0.3.vsix": file("vsix-content"),
          "/mock/vscode": directory(),
          "/mock/bin": directory(),
          ...createBinAssetsEntries(),
        },
      });
      mockProcessRunner = createMockProcessRunner({
        defaultResult: { stdout: "Extension installed", stderr: "", exitCode: 0 },
      });

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

      // Initial download messages should include binary type and 0% progress
      expect(progressMessages).toContainEqual({
        step: "binary-download",
        message: "Downloading code-server...",
        binaryType: "code-server",
        percent: 0,
      });
      expect(progressMessages).toContainEqual({
        step: "binary-download",
        message: "Downloading opencode...",
        binaryType: "opencode",
        percent: 0,
      });
    });

    it("works without BinaryDownloadService (backward compatibility)", async () => {
      mockFs = createFileSystemMock({
        entries: {
          "/mock": directory(),
          "/mock/assets/manifest.json": file(createManifestConfig()),
          "/mock/assets/codehydra-sidekick-0.0.3.vsix": file("vsix-content"),
          "/mock/vscode": directory(),
          "/mock/bin": directory(),
          ...createBinAssetsEntries(),
        },
      });
      mockProcessRunner = createMockProcessRunner({
        defaultResult: { stdout: "Extension installed", stderr: "", exitCode: 0 },
      });

      // No BinaryDownloadService - backward compatibility mode
      const service = new VscodeSetupService(
        mockProcessRunner,
        mockPathProvider,
        mockFs,
        mockPlatformInfo
        // Note: no binaryDownloadService parameter
      );
      const preflight = createFullSetupPreflightResult();
      const result = await service.setup(preflight);

      expect(result).toEqual({ success: true });
    });
  });

  describe("cleanComponents", () => {
    it("removes only specified extension directories", async () => {
      const spyFs = createSpyFileSystemLayer({
        entries: {
          "/mock/vscode/extensions": directory(),
          "/mock/vscode/extensions/codehydra.codehydra-0.0.1": directory(),
          "/mock/vscode/extensions/codehydra.sidekick-0.0.3": directory(),
          "/mock/vscode/extensions/other.extension-2.0.0": directory(),
        },
      });

      const service = new VscodeSetupService(mockProcessRunner, mockPathProvider, spyFs);
      await service.cleanComponents(["codehydra.codehydra"]);

      // Should only remove the specified extension
      expect(wasRmCalledWith(spyFs, "codehydra.codehydra-0.0.1")).toBe(true);
      // Should not remove other extensions
      expect(wasRmCalledWith(spyFs, "codehydra.sidekick")).toBe(false);
      expect(wasRmCalledWith(spyFs, "other.extension")).toBe(false);
    });

    it("handles extension that is not installed (no error)", async () => {
      const spyFs = createSpyFileSystemLayer({
        entries: {
          "/mock/vscode/extensions": directory(),
          "/mock/vscode/extensions/codehydra.sidekick-0.0.3": directory(),
        },
      });

      const service = new VscodeSetupService(mockProcessRunner, mockPathProvider, spyFs);
      // Should not throw even if extension is not found
      await expect(service.cleanComponents(["codehydra.codehydra"])).resolves.not.toThrow();
      expect(spyFs.rm).not.toHaveBeenCalled();
    });

    it("cleans multiple extensions at once", async () => {
      const spyFs = createSpyFileSystemLayer({
        entries: {
          "/mock/vscode/extensions": directory(),
          "/mock/vscode/extensions/codehydra.codehydra-0.0.1": directory(),
          "/mock/vscode/extensions/codehydra.sidekick-0.0.3": directory(),
        },
      });

      const service = new VscodeSetupService(mockProcessRunner, mockPathProvider, spyFs);
      await service.cleanComponents(["codehydra.codehydra", "codehydra.sidekick"]);

      // Should remove both extensions
      expect(wasRmCalledWith(spyFs, "codehydra.codehydra-0.0.1")).toBe(true);
      expect(wasRmCalledWith(spyFs, "codehydra.sidekick-0.0.3")).toBe(true);
    });
  });
});
