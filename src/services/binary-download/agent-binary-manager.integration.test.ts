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
import type { DownloadProgressCallback } from "./types";
import { BINARY_CONFIGS } from "./versions";

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
    getBinaryPath: vi.fn().mockReturnValue("/mock/path/to/binary"),
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("AgentBinaryManager", () => {
  describe("preflight", () => {
    it("returns needsDownload: true when binary is not installed (#8)", async () => {
      const binaryService = createMockBinaryDownloadService({ isInstalled: false });
      const manager = new AgentBinaryManager("opencode", binaryService);

      const result = await manager.preflight();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.needsDownload).toBe(true);
        expect(result.binaryType).toBe("opencode");
      }
      expect(binaryService.isInstalled).toHaveBeenCalledWith("opencode");
    });

    it("returns needsDownload: false when binary is installed (#9)", async () => {
      const binaryService = createMockBinaryDownloadService({ isInstalled: true });
      const manager = new AgentBinaryManager("opencode", binaryService);

      const result = await manager.preflight();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.needsDownload).toBe(false);
        expect(result.binaryType).toBeUndefined();
      }
    });

    it("returns needsDownload: false for binaries with null version (system binary)", async () => {
      // Only run this test if claude has null version
      if (BINARY_CONFIGS.claude.version !== null) {
        return;
      }

      const binaryService = createMockBinaryDownloadService({ isInstalled: false });
      const manager = new AgentBinaryManager("claude", binaryService);

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
      const manager = new AgentBinaryManager("opencode", binaryService);

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
      const manager = new AgentBinaryManager("opencode", binaryService);
      const onProgress: DownloadProgressCallback = vi.fn();

      await manager.downloadBinary(onProgress);

      expect(binaryService.download).toHaveBeenCalledWith("opencode", onProgress);
    });

    it("skips download for binaries with null version", async () => {
      // Only run this test if claude has null version
      if (BINARY_CONFIGS.claude.version !== null) {
        return;
      }

      const binaryService = createMockBinaryDownloadService();
      const manager = new AgentBinaryManager("claude", binaryService);

      await manager.downloadBinary();

      expect(binaryService.download).not.toHaveBeenCalled();
    });

    it("throws AgentBinaryError on download failure", async () => {
      const binaryService = createMockBinaryDownloadService({
        downloadError: new Error("Network timeout"),
      });
      const manager = new AgentBinaryManager("opencode", binaryService);

      await expect(manager.downloadBinary()).rejects.toThrow("Failed to download opencode");
    });
  });

  describe("getBinaryType", () => {
    it("returns opencode for opencode agent", () => {
      const binaryService = createMockBinaryDownloadService();
      const manager = new AgentBinaryManager("opencode", binaryService);

      expect(manager.getBinaryType()).toBe("opencode");
    });

    it("returns claude for claude agent", () => {
      const binaryService = createMockBinaryDownloadService();
      const manager = new AgentBinaryManager("claude", binaryService);

      expect(manager.getBinaryType()).toBe("claude");
    });
  });
});
