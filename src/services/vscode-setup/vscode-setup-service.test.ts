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
import { FileSystemError } from "../errors";
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
      await expect(service.cleanVscodeDir()).rejects.toThrow("path-validation");
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

  describe("installCustomExtensions", () => {
    it("creates extension directory and files when not exists", async () => {
      const createdDirs: string[] = [];
      const writtenFiles: Map<string, string> = new Map();

      mockFs = createMockFileSystemLayer({
        readFile: {
          // readFile throws ENOENT = file doesn't exist, proceed with installation
          error: new FileSystemError("ENOENT", "/mock/vscode/extensions", "Not found"),
        },
        mkdir: {
          implementation: async (path) => {
            createdDirs.push(path);
          },
        },
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
      await service.installCustomExtensions(progressCallback);

      // Verify directory created
      expect(createdDirs).toContain("/mock/vscode/extensions/codehydra.vscode-0.0.1-universal");

      // Verify package.json written
      const packageJsonPath =
        "/mock/vscode/extensions/codehydra.vscode-0.0.1-universal/package.json";
      expect(writtenFiles.has(packageJsonPath)).toBe(true);
      expect(writtenFiles.get(packageJsonPath)).toContain('"name": "codehydra"');

      // Verify extension.js written
      const extensionJsPath =
        "/mock/vscode/extensions/codehydra.vscode-0.0.1-universal/extension.js";
      expect(writtenFiles.has(extensionJsPath)).toBe(true);
      expect(writtenFiles.get(extensionJsPath)).toContain("function activate");

      // Verify progress callback called
      expect(progressCallback).toHaveBeenCalledWith({
        step: "extensions",
        message: "Installing codehydra extension...",
      });
    });

    it("is idempotent when files already exist", async () => {
      let mkdirCalled = false;
      let writeFileCalled = false;

      mockFs = createMockFileSystemLayer({
        readFile: {
          // readFile succeeds = file exists, skip installation
          content: '{"name": "codehydra"}',
        },
        mkdir: {
          implementation: async () => {
            mkdirCalled = true;
          },
        },
        writeFile: {
          implementation: async () => {
            writeFileCalled = true;
          },
        },
      });

      const service = new VscodeSetupService(
        mockProcessRunner,
        mockPathProvider,
        "/mock/code-server",
        mockFs
      );
      await service.installCustomExtensions();

      // Since file exists, mkdir and writeFile should not be called
      expect(mkdirCalled).toBe(false);
      expect(writeFileCalled).toBe(false);
    });
  });

  describe("installMarketplaceExtensions", () => {
    it("runs code-server to install opencode extension", async () => {
      vi.mocked(mockProcessRunner.run).mockReturnValue(
        createMockSpawnedProcess({
          stdout: "Extension 'sst-dev.opencode' was successfully installed.",
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
      await service.installMarketplaceExtensions(progressCallback);

      expect(mockProcessRunner.run).toHaveBeenCalledWith("/mock/code-server", [
        "--install-extension",
        "sst-dev.opencode",
        "--extensions-dir",
        "/mock/vscode/extensions",
      ]);

      expect(progressCallback).toHaveBeenCalledWith({
        step: "extensions",
        message: "Installing OpenCode extension...",
      });
    });

    it("returns error on non-zero exit code", async () => {
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
      const result = await service.installMarketplaceExtensions();

      expect(result).toEqual({
        success: false,
        error: {
          type: "network",
          message: "Failed to install OpenCode extension",
          code: "EXTENSION_INSTALL_FAILED",
        },
      });
    });

    it("returns binary-not-found error when spawn fails", async () => {
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
      const result = await service.installMarketplaceExtensions();

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
    it("creates user-data directory and writes config files", async () => {
      const createdDirs: string[] = [];
      const writtenFiles: Map<string, string> = new Map();

      mockFs = createMockFileSystemLayer({
        mkdir: {
          implementation: async (path) => {
            createdDirs.push(path);
          },
        },
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
      await service.writeConfigFiles(progressCallback);

      // Verify directory created
      expect(createdDirs).toContain("/mock/vscode/user-data/User");

      // Verify settings.json written with expected content
      const settingsPath = "/mock/vscode/user-data/User/settings.json";
      expect(writtenFiles.has(settingsPath)).toBe(true);
      expect(writtenFiles.get(settingsPath)).toContain('"workbench.colorTheme": "Default Dark+"');

      // Verify keybindings.json written with panel toggle remap
      const keybindingsPath = "/mock/vscode/user-data/User/keybindings.json";
      expect(writtenFiles.has(keybindingsPath)).toBe(true);
      expect(writtenFiles.get(keybindingsPath)).toContain(
        '"command": "workbench.action.togglePanel"'
      );

      // Verify progress callback called
      expect(progressCallback).toHaveBeenCalledWith({
        step: "config",
        message: "Writing configuration...",
      });
    });

    it("includes expected settings", async () => {
      const writtenFiles: Map<string, string> = new Map();
      mockFs = createMockFileSystemLayer({
        mkdir: { implementation: async () => {} },
        writeFile: {
          implementation: async (path, content) => {
            writtenFiles.set(path, content);
          },
        },
      });

      const service = new VscodeSetupService(
        mockProcessRunner,
        mockPathProvider,
        "/mock/code-server",
        mockFs
      );
      await service.writeConfigFiles();

      const settingsContent = writtenFiles.get("/mock/vscode/user-data/User/settings.json")!;
      const settings = JSON.parse(settingsContent) as Record<string, unknown>;
      expect(settings).toEqual({
        "workbench.startupEditor": "none",
        "workbench.colorTheme": "Default Dark+",
        "window.autoDetectColorScheme": true,
        "workbench.preferredDarkColorTheme": "Default Dark+",
        "workbench.preferredLightColorTheme": "Default Light+",
        "extensions.autoUpdate": false,
        "telemetry.telemetryLevel": "off",
        "window.menuBarVisibility": "hidden",
        "terminal.integrated.gpuAcceleration": "off",
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
    it("runs all setup steps in order and returns success", async () => {
      // readFile throws = file doesn't exist, proceed with installation
      mockFs = createMockFileSystemLayer({
        readFile: {
          error: new FileSystemError("ENOENT", "/mock/vscode/extensions", "Not found"),
        },
        mkdir: { implementation: async () => {} },
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
      expect(progressMessages).toContain("Installing codehydra extension...");
      expect(progressMessages).toContain("Installing OpenCode extension...");
      expect(progressMessages).toContain("Writing configuration...");
      expect(progressMessages).toContain("Finalizing setup...");
    });

    it("returns error when extension install fails", async () => {
      // readFile throws = file doesn't exist, proceed with installation
      mockFs = createMockFileSystemLayer({
        readFile: {
          error: new FileSystemError("ENOENT", "/mock/vscode/extensions", "Not found"),
        },
        mkdir: { implementation: async () => {} },
        writeFile: { implementation: async () => {} },
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
