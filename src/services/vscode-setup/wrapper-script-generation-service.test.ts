// @vitest-environment node
/**
 * Unit tests for WrapperScriptGenerationService.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { WrapperScriptGenerationService } from "./wrapper-script-generation-service";
import { createMockPathProvider } from "../platform/path-provider.test-utils";
import { createMockPlatformInfo } from "../platform/platform-info.test-utils";
import type { FileSystemLayer } from "../platform/filesystem";
import type { PathProvider } from "../platform/path-provider";
import type { PlatformInfo } from "../platform/platform-info";

/**
 * Create a mock FileSystemLayer with vi.fn() spies for test assertions.
 */
function createSpyFileSystemLayer(): FileSystemLayer {
  return {
    readFile: vi.fn().mockResolvedValue(""),
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    readdir: vi.fn().mockResolvedValue([]),
    unlink: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
    copyTree: vi.fn().mockResolvedValue(undefined),
    makeExecutable: vi.fn().mockResolvedValue(undefined),
    writeFileBuffer: vi.fn().mockResolvedValue(undefined),
    symlink: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
  };
}

describe("WrapperScriptGenerationService", () => {
  let mockFs: FileSystemLayer;
  let mockPathProvider: PathProvider;
  let mockPlatformInfo: PlatformInfo;

  beforeEach(() => {
    mockFs = createSpyFileSystemLayer();
    mockPathProvider = createMockPathProvider();
    mockPlatformInfo = createMockPlatformInfo({ platform: "linux" });
  });

  describe("regenerate()", () => {
    it("creates bin directory if it does not exist", async () => {
      const service = new WrapperScriptGenerationService(
        mockPathProvider,
        mockFs,
        mockPlatformInfo
      );

      await service.regenerate();

      expect(mockFs.mkdir).toHaveBeenCalledWith(mockPathProvider.binDir);
    });

    it("generates code wrapper script on Unix", async () => {
      mockPlatformInfo = createMockPlatformInfo({ platform: "linux" });
      const service = new WrapperScriptGenerationService(
        mockPathProvider,
        mockFs,
        mockPlatformInfo
      );

      await service.regenerate();

      // Should write code script
      expect(mockFs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining("/bin/code"),
        expect.stringContaining("#!/bin/sh")
      );
    });

    it("generates opencode wrapper script on Unix", async () => {
      mockPlatformInfo = createMockPlatformInfo({ platform: "linux" });
      const service = new WrapperScriptGenerationService(
        mockPathProvider,
        mockFs,
        mockPlatformInfo
      );

      await service.regenerate();

      // Should write opencode script
      expect(mockFs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining("/bin/opencode"),
        expect.stringContaining("#!/bin/sh")
      );
    });

    it("generates .cmd scripts on Windows", async () => {
      mockPlatformInfo = createMockPlatformInfo({ platform: "win32" });
      const service = new WrapperScriptGenerationService(
        mockPathProvider,
        mockFs,
        mockPlatformInfo
      );

      await service.regenerate();

      // Should write code.cmd
      expect(mockFs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining("code.cmd"),
        expect.stringContaining("@echo off")
      );

      // Should write opencode.cmd
      expect(mockFs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining("opencode.cmd"),
        expect.stringContaining("@echo off")
      );
    });

    it("makes scripts executable on Unix", async () => {
      mockPlatformInfo = createMockPlatformInfo({ platform: "linux" });
      const service = new WrapperScriptGenerationService(
        mockPathProvider,
        mockFs,
        mockPlatformInfo
      );

      await service.regenerate();

      // Should call makeExecutable for each script
      expect(mockFs.makeExecutable).toHaveBeenCalledWith(expect.stringContaining("/bin/code"));
      expect(mockFs.makeExecutable).toHaveBeenCalledWith(expect.stringContaining("/bin/opencode"));
    });

    it("does not call makeExecutable on Windows", async () => {
      mockPlatformInfo = createMockPlatformInfo({ platform: "win32" });
      const service = new WrapperScriptGenerationService(
        mockPathProvider,
        mockFs,
        mockPlatformInfo
      );

      await service.regenerate();

      // makeExecutable should not be called on Windows
      expect(mockFs.makeExecutable).not.toHaveBeenCalled();
    });

    it("generates correct remote-cli path on Linux", async () => {
      mockPlatformInfo = createMockPlatformInfo({ platform: "linux" });
      const service = new WrapperScriptGenerationService(
        mockPathProvider,
        mockFs,
        mockPlatformInfo
      );

      await service.regenerate();

      // The code script should reference code-linux.sh
      expect(mockFs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining("/bin/code"),
        expect.stringContaining("code-linux.sh")
      );
    });

    it("generates correct remote-cli path on macOS", async () => {
      mockPlatformInfo = createMockPlatformInfo({ platform: "darwin" });
      const service = new WrapperScriptGenerationService(
        mockPathProvider,
        mockFs,
        mockPlatformInfo
      );

      await service.regenerate();

      // The code script should reference code-darwin.sh
      expect(mockFs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining("/bin/code"),
        expect.stringContaining("code-darwin.sh")
      );
    });

    it("generates correct remote-cli path on Windows", async () => {
      mockPlatformInfo = createMockPlatformInfo({ platform: "win32" });
      const service = new WrapperScriptGenerationService(
        mockPathProvider,
        mockFs,
        mockPlatformInfo
      );

      await service.regenerate();

      // The code.cmd script should reference code.cmd
      expect(mockFs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining("code.cmd"),
        expect.stringContaining("remote-cli\\code.cmd")
      );
    });

    it("writes exactly 3 scripts plus OpenCode config on Unix", async () => {
      mockPlatformInfo = createMockPlatformInfo({ platform: "linux" });
      const service = new WrapperScriptGenerationService(
        mockPathProvider,
        mockFs,
        mockPlatformInfo
      );

      await service.regenerate();

      // writeFile should be called 4 times (code, opencode.cjs, opencode, and OpenCode config)
      expect(mockFs.writeFile).toHaveBeenCalledTimes(4);
    });

    it("writes exactly 3 scripts plus OpenCode config on Windows", async () => {
      mockPlatformInfo = createMockPlatformInfo({ platform: "win32" });
      const service = new WrapperScriptGenerationService(
        mockPathProvider,
        mockFs,
        mockPlatformInfo
      );

      await service.regenerate();

      // writeFile should be called 4 times (code.cmd, opencode.cjs, opencode.cmd, and OpenCode config)
      expect(mockFs.writeFile).toHaveBeenCalledTimes(4);
    });

    it("logs script generation with logger", async () => {
      const mockLogger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        silly: vi.fn(),
      };
      const service = new WrapperScriptGenerationService(
        mockPathProvider,
        mockFs,
        mockPlatformInfo,
        mockLogger
      );

      await service.regenerate();

      expect(mockLogger.debug).toHaveBeenCalledWith("Regenerating wrapper scripts", {
        binDir: mockPathProvider.binDir,
      });
      expect(mockLogger.info).toHaveBeenCalledWith("Startup files regenerated", {
        scripts: 3,
        config: 1,
      });
    });

    it("regenerates OpenCode config with default_agent set to plan", async () => {
      const service = new WrapperScriptGenerationService(
        mockPathProvider,
        mockFs,
        mockPlatformInfo
      );

      await service.regenerate();

      // Should write OpenCode config
      expect(mockFs.writeFile).toHaveBeenCalledWith(
        mockPathProvider.mcpConfigPath,
        expect.stringContaining('"default_agent": "plan"')
      );
    });

    it("creates OpenCode config directory before writing config", async () => {
      const service = new WrapperScriptGenerationService(
        mockPathProvider,
        mockFs,
        mockPlatformInfo
      );

      await service.regenerate();

      // Should create directory for OpenCode config (dirname of mcpConfigPath)
      // mcpConfigPath is /test/app-data/opencode/codehydra-mcp.json
      expect(mockFs.mkdir).toHaveBeenCalledWith("/test/app-data/opencode");
    });
  });
});
