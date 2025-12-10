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
import * as fs from "node:fs/promises";

// Mock fs/promises
vi.mock("node:fs/promises");

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
  });

  describe("isSetupComplete", () => {
    it("returns true when marker exists with correct version", async () => {
      const marker: SetupMarker = {
        version: CURRENT_SETUP_VERSION,
        completedAt: "2025-12-09T10:00:00.000Z",
      };
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(marker));

      const service = new VscodeSetupService(
        mockProcessRunner,
        mockPathProvider,
        "/mock/code-server"
      );
      const result = await service.isSetupComplete();

      expect(result).toBe(true);
      expect(fs.readFile).toHaveBeenCalledWith("/mock/vscode/.setup-completed", "utf-8");
    });

    it("returns false when marker is missing", async () => {
      const error = new Error("ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      vi.mocked(fs.readFile).mockRejectedValue(error);

      const service = new VscodeSetupService(
        mockProcessRunner,
        mockPathProvider,
        "/mock/code-server"
      );
      const result = await service.isSetupComplete();

      expect(result).toBe(false);
    });

    it("returns false when version mismatch", async () => {
      const marker: SetupMarker = {
        version: CURRENT_SETUP_VERSION - 1, // Old version
        completedAt: "2025-12-09T10:00:00.000Z",
      };
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(marker));

      const service = new VscodeSetupService(
        mockProcessRunner,
        mockPathProvider,
        "/mock/code-server"
      );
      const result = await service.isSetupComplete();

      expect(result).toBe(false);
    });

    it("returns false when marker has invalid JSON", async () => {
      vi.mocked(fs.readFile).mockResolvedValue("invalid json");

      const service = new VscodeSetupService(
        mockProcessRunner,
        mockPathProvider,
        "/mock/code-server"
      );
      const result = await service.isSetupComplete();

      expect(result).toBe(false);
    });
  });

  describe("cleanVscodeDir", () => {
    it("removes the vscode directory", async () => {
      vi.mocked(fs.rm).mockResolvedValue(undefined);

      const service = new VscodeSetupService(
        mockProcessRunner,
        mockPathProvider,
        "/mock/code-server"
      );
      await service.cleanVscodeDir();

      expect(fs.rm).toHaveBeenCalledWith("/mock/vscode", { recursive: true, force: true });
    });

    it("handles missing directory gracefully", async () => {
      const error = new Error("ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      vi.mocked(fs.rm).mockRejectedValue(error);

      const service = new VscodeSetupService(
        mockProcessRunner,
        mockPathProvider,
        "/mock/code-server"
      );
      // Should not throw
      await expect(service.cleanVscodeDir()).resolves.toBeUndefined();
    });

    it("throws on permission error", async () => {
      const error = new Error("EACCES") as NodeJS.ErrnoException;
      error.code = "EACCES";
      vi.mocked(fs.rm).mockRejectedValue(error);

      const service = new VscodeSetupService(
        mockProcessRunner,
        mockPathProvider,
        "/mock/code-server"
      );
      await expect(service.cleanVscodeDir()).rejects.toThrow("EACCES");
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
        "/mock/code-server"
      );
      await expect(service.cleanVscodeDir()).rejects.toThrow("path-validation");
    });
  });

  describe("installCustomExtensions", () => {
    it("creates extension directory and files", async () => {
      // access throws = file doesn't exist, proceed with installation
      const error = new Error("ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      vi.mocked(fs.access).mockRejectedValue(error);
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      const progressCallback = vi.fn();

      const service = new VscodeSetupService(
        mockProcessRunner,
        mockPathProvider,
        "/mock/code-server"
      );
      await service.installCustomExtensions(progressCallback);

      // Verify directory created
      expect(fs.mkdir).toHaveBeenCalledWith(
        "/mock/vscode/extensions/codehydra.vscode-0.0.1-universal",
        { recursive: true }
      );

      // Verify package.json written
      expect(fs.writeFile).toHaveBeenCalledWith(
        "/mock/vscode/extensions/codehydra.vscode-0.0.1-universal/package.json",
        expect.stringContaining('"name": "codehydra"'),
        "utf-8"
      );

      // Verify extension.js written
      expect(fs.writeFile).toHaveBeenCalledWith(
        "/mock/vscode/extensions/codehydra.vscode-0.0.1-universal/extension.js",
        expect.stringContaining("function activate"),
        "utf-8"
      );

      // Verify progress callback called
      expect(progressCallback).toHaveBeenCalledWith({
        step: "extensions",
        message: "Installing codehydra extension...",
      });
    });

    it("is idempotent when files already exist", async () => {
      // access resolves = file exists, skip installation
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      const service = new VscodeSetupService(
        mockProcessRunner,
        mockPathProvider,
        "/mock/code-server"
      );
      await service.installCustomExtensions();
      await service.installCustomExtensions();

      // Since file exists, mkdir and writeFile should not be called
      expect(fs.mkdir).not.toHaveBeenCalled();
      expect(fs.writeFile).not.toHaveBeenCalled();
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
        "/mock/code-server"
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
        "/mock/code-server"
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
        "/mock/code-server"
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
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      const progressCallback = vi.fn();

      const service = new VscodeSetupService(
        mockProcessRunner,
        mockPathProvider,
        "/mock/code-server"
      );
      await service.writeConfigFiles(progressCallback);

      // Verify directory created
      expect(fs.mkdir).toHaveBeenCalledWith("/mock/vscode/user-data/User", { recursive: true });

      // Verify settings.json written with expected content
      expect(fs.writeFile).toHaveBeenCalledWith(
        "/mock/vscode/user-data/User/settings.json",
        expect.stringContaining('"workbench.colorTheme": "Default Dark+"'),
        "utf-8"
      );

      // Verify keybindings.json written (empty array)
      expect(fs.writeFile).toHaveBeenCalledWith(
        "/mock/vscode/user-data/User/keybindings.json",
        "[]",
        "utf-8"
      );

      // Verify progress callback called
      expect(progressCallback).toHaveBeenCalledWith({
        step: "config",
        message: "Writing configuration...",
      });
    });

    it("includes expected settings", async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      let writtenSettings = "";
      vi.mocked(fs.writeFile).mockImplementation(async (path, data) => {
        if (String(path).endsWith("settings.json")) {
          writtenSettings = String(data);
        }
      });

      const service = new VscodeSetupService(
        mockProcessRunner,
        mockPathProvider,
        "/mock/code-server"
      );
      await service.writeConfigFiles();

      const settings = JSON.parse(writtenSettings);
      expect(settings).toEqual({
        "workbench.startupEditor": "none",
        "workbench.colorTheme": "Default Dark+",
        "extensions.autoUpdate": false,
        "telemetry.telemetryLevel": "off",
        "window.menuBarVisibility": "hidden",
      });
    });
  });

  describe("writeCompletionMarker", () => {
    it("writes marker file with version and timestamp", async () => {
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      const progressCallback = vi.fn();

      const service = new VscodeSetupService(
        mockProcessRunner,
        mockPathProvider,
        "/mock/code-server"
      );
      await service.writeCompletionMarker(progressCallback);

      // Verify marker written
      expect(fs.writeFile).toHaveBeenCalledWith(
        "/mock/vscode/.setup-completed",
        expect.any(String),
        "utf-8"
      );

      // Verify content structure
      const writeCall = vi
        .mocked(fs.writeFile)
        .mock.calls.find((call) => String(call[0]).endsWith(".setup-completed"));
      expect(writeCall).toBeDefined();
      const marker = JSON.parse(String(writeCall?.[1]));
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
      // access throws = file doesn't exist, proceed with installation
      const error = new Error("ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      vi.mocked(fs.access).mockRejectedValue(error);
      // Mock all file operations
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
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
        "/mock/code-server"
      );
      const result = await service.setup(progressCallback);

      expect(result).toEqual({ success: true });

      // Verify progress callbacks were called for each step
      const progressMessages = progressCallback.mock.calls.map((call) => call[0].message);
      expect(progressMessages).toContain("Installing codehydra extension...");
      expect(progressMessages).toContain("Installing OpenCode extension...");
      expect(progressMessages).toContain("Writing configuration...");
      expect(progressMessages).toContain("Finalizing setup...");
    });

    it("returns error when extension install fails", async () => {
      // access throws = file doesn't exist, proceed with installation
      const error = new Error("ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      vi.mocked(fs.access).mockRejectedValue(error);
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
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
        "/mock/code-server"
      );
      const result = await service.setup();

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.type).toBe("network");
      }
    });
  });
});
