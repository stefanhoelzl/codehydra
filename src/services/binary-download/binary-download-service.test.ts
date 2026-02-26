/**
 * Unit tests for BinaryDownloadService.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { DefaultBinaryDownloadService } from "./binary-download-service";
import { BinaryDownloadError } from "./errors";
import { createMockHttpClient } from "../platform/http-client.state-mock";
import {
  createFileSystemMock,
  createSpyFileSystemLayer,
  directory,
  createDirEntry,
} from "../platform/filesystem.state-mock";
import { createArchiveExtractorMock } from "./archive-extractor.state-mock";
import type { DownloadRequest } from "./types";

describe("DefaultBinaryDownloadService", () => {
  const mockHttpClient = createMockHttpClient();
  const mockFs = createFileSystemMock();

  let mockArchiveExtractor: ReturnType<typeof createArchiveExtractorMock>;

  beforeEach(() => {
    mockArchiveExtractor = createArchiveExtractorMock();
  });

  describe("isInstalled", () => {
    it("returns true when binary directory exists", async () => {
      const fsWithDir = createFileSystemMock({
        entries: {
          "/app-data/code-server/4.109.2": directory(),
          "/app-data/code-server/4.109.2/bin": directory(),
        },
      });
      const serviceWithFs = new DefaultBinaryDownloadService(
        mockHttpClient,
        fsWithDir,
        mockArchiveExtractor
      );

      const result = await serviceWithFs.isInstalled("/app-data/code-server/4.109.2");

      expect(result).toBe(true);
    });

    it("returns false when binary directory does not exist", async () => {
      const fsWithNoDir = createFileSystemMock();
      const serviceWithNoFs = new DefaultBinaryDownloadService(
        mockHttpClient,
        fsWithNoDir,
        mockArchiveExtractor
      );

      const result = await serviceWithNoFs.isInstalled("/app-data/code-server/4.109.2");

      expect(result).toBe(false);
    });
  });

  describe("download", () => {
    const codeServerRequest: DownloadRequest = {
      name: "code-server",
      url: "https://example.com/code-server-4.109.2-linux-amd64.tar.gz",
      destDir: "/app-data/code-server/4.109.2",
      executablePath: "bin/code-server",
    };

    it("throws BinaryDownloadError on HTTP 404", async () => {
      const httpClient = createMockHttpClient({
        defaultResponse: { status: 404 },
      });
      const serviceWith404 = new DefaultBinaryDownloadService(
        httpClient,
        mockFs,
        mockArchiveExtractor
      );

      await expect(serviceWith404.download(codeServerRequest)).rejects.toThrow(BinaryDownloadError);
      await expect(serviceWith404.download(codeServerRequest)).rejects.toMatchObject({
        errorCode: "NETWORK_ERROR",
        message: expect.stringContaining("404"),
      });
    });

    it("throws BinaryDownloadError on network error", async () => {
      const httpClient = createMockHttpClient({
        defaultResponse: { error: new TypeError("Failed to fetch") },
      });
      const serviceWithError = new DefaultBinaryDownloadService(
        httpClient,
        mockFs,
        mockArchiveExtractor
      );

      await expect(serviceWithError.download(codeServerRequest)).rejects.toThrow(
        BinaryDownloadError
      );
      await expect(serviceWithError.download(codeServerRequest)).rejects.toMatchObject({
        errorCode: "NETWORK_ERROR",
      });
    });

    it("flattens nested directory structure using rename", async () => {
      const successHttpClient = createMockHttpClient({
        defaultResponse: {
          body: "binary content",
          status: 200,
          headers: { "content-length": "14" },
        },
      });

      // Use spy filesystem to track calls - include temp directory for temp file writes
      const trackingFs = createSpyFileSystemLayer({
        entries: {
          [tmpdir()]: directory(),
        },
      });

      // Override readdir to return dynamic results based on call count
      let readdirCallCount = 0;
      trackingFs.readdir = vi.fn(async () => {
        readdirCallCount++;
        if (readdirCallCount === 1) {
          // First call: destDir has single nested directory
          return [createDirEntry("code-server-4.109.2-linux-amd64", { isDirectory: true })];
        } else {
          // Second call: nested directory contents
          return [
            createDirEntry("bin", { isDirectory: true }),
            createDirEntry("lib", { isDirectory: true }),
            createDirEntry("package.json", { isFile: true }),
          ];
        }
      });

      // Override rename and rm to be no-ops (we just want to track calls)
      trackingFs.rename = vi.fn(async () => {});
      trackingFs.rm = vi.fn(async () => {});

      const trackingService = new DefaultBinaryDownloadService(
        successHttpClient,
        trackingFs,
        mockArchiveExtractor
      );

      await trackingService.download(codeServerRequest);

      // Verify rename was called for each nested entry (atomic moves)
      expect(trackingFs.rename).toHaveBeenCalledTimes(3);
      // Note: Service passes string paths
      const renameCalls = trackingFs.rename.mock.calls;
      expect(String(renameCalls[0]?.[0])).toBe(
        join("/app-data", "code-server", "4.109.2", "code-server-4.109.2-linux-amd64", "bin")
      );
      expect(String(renameCalls[0]?.[1])).toBe(join("/app-data", "code-server", "4.109.2", "bin"));

      // Verify the now-empty nested directory was removed
      const rmCalls = trackingFs.rm.mock.calls;
      const nestedDirRmCall = rmCalls.find((call) =>
        String(call[0]).includes("code-server-4.109.2-linux-amd64")
      );
      expect(nestedDirRmCall).toBeDefined();
      expect(nestedDirRmCall?.[1]).toEqual({ recursive: true, force: true });
    });
  });
});

describe("createMockBinaryDownloadService", () => {
  it("creates a mock that can be configured", async () => {
    const { createMockBinaryDownloadService } =
      await import("./binary-download-service.test-utils");

    const mock = createMockBinaryDownloadService({
      installed: true,
    });

    expect(await mock.isInstalled("/some/dir")).toBe(true);
  });

  it("can simulate download error", async () => {
    const { createMockBinaryDownloadService } =
      await import("./binary-download-service.test-utils");

    const mock = createMockBinaryDownloadService({
      downloadError: { message: "Network error", code: "NETWORK_ERROR" },
    });

    await expect(
      mock.download({ name: "test", url: "http://test", destDir: "/test" })
    ).rejects.toThrow(BinaryDownloadError);
  });
});
