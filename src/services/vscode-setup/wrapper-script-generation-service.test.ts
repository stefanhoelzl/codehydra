// @vitest-environment node
/**
 * Unit tests for WrapperScriptGenerationService.
 */

import { dirname, sep } from "path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { WrapperScriptGenerationService } from "./wrapper-script-generation-service";
import { createMockPathProvider } from "../platform/path-provider.test-utils";
import { createMockPlatformInfo } from "../platform/platform-info.test-utils";
import {
  createSpyFileSystemLayer,
  type SpyFileSystemLayer,
} from "../platform/filesystem.test-utils";
import type { PathProvider } from "../platform/path-provider";
import type { PlatformInfo } from "../platform/platform-info";

describe("WrapperScriptGenerationService", () => {
  let mockFs: SpyFileSystemLayer;
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
      // Use path.sep to handle platform differences in test runner vs target platform
      expect(mockFs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining(`${sep}bin${sep}code`),
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
      // Use path.sep to handle platform differences in test runner vs target platform
      expect(mockFs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining(`${sep}bin${sep}opencode`),
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
      // Use path.sep to handle platform differences in test runner vs target platform
      expect(mockFs.makeExecutable).toHaveBeenCalledWith(
        expect.stringContaining(`${sep}bin${sep}code`)
      );
      expect(mockFs.makeExecutable).toHaveBeenCalledWith(
        expect.stringContaining(`${sep}bin${sep}opencode`)
      );
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
      // Use path.sep to handle platform differences in test runner vs target platform
      expect(mockFs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining(`${sep}bin${sep}code`),
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
      // Use path.sep to handle platform differences in test runner vs target platform
      expect(mockFs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining(`${sep}bin${sep}code`),
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

    it("creates OpenCode config directory before writing config", async () => {
      const service = new WrapperScriptGenerationService(
        mockPathProvider,
        mockFs,
        mockPlatformInfo
      );

      await service.regenerate();

      // Should create directory for OpenCode config (dirname of mcpConfigPath)
      // Use dirname() to handle platform path differences (forward vs backslash)
      expect(mockFs.mkdir).toHaveBeenCalledWith(dirname(mockPathProvider.mcpConfigPath));
    });
  });
});
