// @vitest-environment node
/**
 * Integration tests for AgentBinaryManager.
 *
 * Tests verify preflight and download behavior through the manager interface.
 *
 * Test plan items covered:
 * #8: AgentBinaryManager.preflight detects missing binary
 * #9: AgentBinaryManager.preflight detects installed binary
 */

import { describe, it, expect, vi } from "vitest";
import { AgentBinaryManager } from "./agent-binary-manager";
import type { BinaryDownloadService } from "./binary-download-service";
import type { AgentBinaryConfig } from "./agent-binary-manager";
import type { DownloadProgressCallback } from "./types";

// =============================================================================
// Test Setup
// =============================================================================

function createMockBinaryDownloadService(
  options: {
    isInstalled?: boolean;
    downloadError?: Error;
  } = {}
): BinaryDownloadService {
  return {
    isInstalled: vi.fn().mockResolvedValue(options.isInstalled ?? false),
    download: options.downloadError
      ? vi.fn().mockRejectedValue(options.downloadError)
      : vi.fn().mockResolvedValue(undefined),
  };
}

const opencodeConfig: AgentBinaryConfig = {
  name: "opencode",
  version: "0.1.47",
  destDir: "/app-data/opencode/0.1.47",
  url: "https://example.com/opencode.tar.gz",
  executablePath: "opencode",
  subPath: "opencode-linux-x64",
};

const claudeNullVersionConfig: AgentBinaryConfig = {
  name: "claude",
  version: null,
  destDir: "/app-data/claude/latest",
  url: "https://example.com/claude.tar.gz",
  executablePath: "claude",
  subPath: "claude-linux-x64",
};

// =============================================================================
// Tests
// =============================================================================

describe("AgentBinaryManager", () => {
  describe("preflight", () => {
    it("returns needsDownload: true when binary is not installed (#8)", async () => {
      const binaryService = createMockBinaryDownloadService({ isInstalled: false });
      const manager = new AgentBinaryManager(opencodeConfig, binaryService);

      const result = await manager.preflight();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.needsDownload).toBe(true);
        expect(result.binaryType).toBe("opencode");
      }
      expect(binaryService.isInstalled).toHaveBeenCalledWith(opencodeConfig.destDir);
    });

    it("returns needsDownload: false when binary is installed (#9)", async () => {
      const binaryService = createMockBinaryDownloadService({ isInstalled: true });
      const manager = new AgentBinaryManager(opencodeConfig, binaryService);

      const result = await manager.preflight();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.needsDownload).toBe(false);
        expect(result.binaryType).toBeUndefined();
      }
    });

    it("returns needsDownload: false for binaries with null version (system binary)", async () => {
      const binaryService = createMockBinaryDownloadService({ isInstalled: false });
      const manager = new AgentBinaryManager(claudeNullVersionConfig, binaryService);

      const result = await manager.preflight();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.needsDownload).toBe(false);
      }
      // Should NOT have called isInstalled - skips check for null version
      expect(binaryService.isInstalled).not.toHaveBeenCalled();
    });

    it("returns error on exception", async () => {
      const binaryService = createMockBinaryDownloadService();
      (binaryService.isInstalled as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Read error")
      );
      const manager = new AgentBinaryManager(opencodeConfig, binaryService);

      const result = await manager.preflight();

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toContain("Read error");
      }
    });
  });

  describe("downloadBinary", () => {
    it("downloads binary via BinaryDownloadService", async () => {
      const binaryService = createMockBinaryDownloadService();
      const manager = new AgentBinaryManager(opencodeConfig, binaryService);
      const onProgress: DownloadProgressCallback = vi.fn();

      await manager.downloadBinary(onProgress);

      expect(binaryService.download).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "opencode",
          url: opencodeConfig.url,
          destDir: opencodeConfig.destDir,
          executablePath: opencodeConfig.executablePath,
        }),
        onProgress
      );
    });

    it("skips download for binaries with null version", async () => {
      const binaryService = createMockBinaryDownloadService();
      const manager = new AgentBinaryManager(claudeNullVersionConfig, binaryService);

      await manager.downloadBinary();

      expect(binaryService.download).not.toHaveBeenCalled();
    });

    it("throws AgentBinaryError on download failure", async () => {
      const binaryService = createMockBinaryDownloadService({
        downloadError: new Error("Network timeout"),
      });
      const manager = new AgentBinaryManager(opencodeConfig, binaryService);

      await expect(manager.downloadBinary()).rejects.toThrow("Failed to download opencode");
    });
  });

  describe("getBinaryType", () => {
    it("returns opencode for opencode agent", () => {
      const binaryService = createMockBinaryDownloadService();
      const manager = new AgentBinaryManager(opencodeConfig, binaryService);

      expect(manager.getBinaryType()).toBe("opencode");
    });

    it("returns claude for claude agent", () => {
      const binaryService = createMockBinaryDownloadService();
      const manager = new AgentBinaryManager(claudeNullVersionConfig, binaryService);

      expect(manager.getBinaryType()).toBe("claude");
    });
  });
});
