/**
 * Unit tests for BinaryDownloadService.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { DefaultBinaryDownloadService } from "./binary-download-service";
import { BinaryDownloadError } from "./errors";
import { CODE_SERVER_VERSION, OPENCODE_VERSION } from "./versions";
import { createMockHttpClient } from "../platform/http-client.state-mock";
import {
  createFileSystemMock,
  createSpyFileSystemLayer,
  directory,
  createDirEntry,
} from "../platform/filesystem.state-mock";
import { createArchiveExtractorMock } from "./archive-extractor.state-mock";
import { createMockPathProvider } from "../platform/path-provider.test-utils";
import { createMockPlatformInfo } from "../platform/platform-info.test-utils";

describe("DefaultBinaryDownloadService", () => {
  const mockHttpClient = createMockHttpClient();
  const mockFs = createFileSystemMock();
  const mockPathProvider = createMockPathProvider({
    bundlesRootDir: "/app-data",
    dataRootDir: "/app-data",
    binDir: "/app-data/bin",
  });
  const mockPlatformInfo = createMockPlatformInfo({
    platform: "linux",
    arch: "x64",
  });

  let mockArchiveExtractor: ReturnType<typeof createArchiveExtractorMock>;
  let service: DefaultBinaryDownloadService;

  beforeEach(() => {
    mockArchiveExtractor = createArchiveExtractorMock();
    service = new DefaultBinaryDownloadService(
      mockHttpClient,
      mockFs,
      mockArchiveExtractor,
      mockPathProvider,
      mockPlatformInfo
    );
  });

  describe("getBinaryPath", () => {
    it("returns correct path for code-server on Linux", () => {
      const path = service.getBinaryPath("code-server");
      expect(path).toBe(
        join("/app-data", "code-server", CODE_SERVER_VERSION, "bin", "code-server")
      );
    });

    it("returns correct path for opencode on Linux", () => {
      const path = service.getBinaryPath("opencode");
      expect(path).toBe(join("/app-data", "opencode", OPENCODE_VERSION, "opencode"));
    });

    it("returns correct path for code-server on Windows", () => {
      const winPlatformInfo = createMockPlatformInfo({
        platform: "win32",
        arch: "x64",
      });
      const winService = new DefaultBinaryDownloadService(
        mockHttpClient,
        mockFs,
        mockArchiveExtractor,
        mockPathProvider,
        winPlatformInfo
      );

      const path = winService.getBinaryPath("code-server");
      expect(path).toBe(
        join("/app-data", "code-server", CODE_SERVER_VERSION, "bin", "code-server.cmd")
      );
    });

    it("returns correct path for opencode on Windows", () => {
      const winPlatformInfo = createMockPlatformInfo({
        platform: "win32",
        arch: "x64",
      });
      const winService = new DefaultBinaryDownloadService(
        mockHttpClient,
        mockFs,
        mockArchiveExtractor,
        mockPathProvider,
        winPlatformInfo
      );

      const path = winService.getBinaryPath("opencode");
      expect(path).toBe(join("/app-data", "opencode", OPENCODE_VERSION, "opencode.exe"));
    });
  });

  describe("isInstalled", () => {
    it("returns true when binary directory exists", async () => {
      // Create service with fs that has the version directory with a child
      const fsWithDir = createFileSystemMock({
        entries: {
          [`/app-data/code-server/${CODE_SERVER_VERSION}`]: directory(),
          [`/app-data/code-server/${CODE_SERVER_VERSION}/bin`]: directory(),
        },
      });
      const serviceWithFs = new DefaultBinaryDownloadService(
        mockHttpClient,
        fsWithDir,
        mockArchiveExtractor,
        mockPathProvider,
        mockPlatformInfo
      );

      const result = await serviceWithFs.isInstalled("code-server");

      expect(result).toBe(true);
    });

    it("returns false when binary directory does not exist", async () => {
      // Create service with empty fs - ENOENT happens naturally
      const fsWithNoDir = createFileSystemMock();
      const serviceWithNoFs = new DefaultBinaryDownloadService(
        mockHttpClient,
        fsWithNoDir,
        mockArchiveExtractor,
        mockPathProvider,
        mockPlatformInfo
      );

      const result = await serviceWithNoFs.isInstalled("code-server");

      expect(result).toBe(false);
    });
  });

  describe("download", () => {
    it("throws BinaryDownloadError on HTTP 404", async () => {
      const httpClient = createMockHttpClient({
        defaultResponse: { status: 404 },
      });
      const serviceWith404 = new DefaultBinaryDownloadService(
        httpClient,
        mockFs,
        mockArchiveExtractor,
        mockPathProvider,
        mockPlatformInfo
      );

      await expect(serviceWith404.download("code-server")).rejects.toThrow(BinaryDownloadError);
      await expect(serviceWith404.download("code-server")).rejects.toMatchObject({
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
        mockArchiveExtractor,
        mockPathProvider,
        mockPlatformInfo
      );

      await expect(serviceWithError.download("code-server")).rejects.toThrow(BinaryDownloadError);
      await expect(serviceWithError.download("code-server")).rejects.toMatchObject({
        errorCode: "NETWORK_ERROR",
      });
    });

    it("throws BinaryDownloadError on unsupported platform", async () => {
      const freebsdPlatformInfo = createMockPlatformInfo({
        platform: "freebsd" as NodeJS.Platform,
        arch: "x64",
      });
      const freebsdService = new DefaultBinaryDownloadService(
        mockHttpClient,
        mockFs,
        mockArchiveExtractor,
        mockPathProvider,
        freebsdPlatformInfo
      );

      await expect(freebsdService.download("code-server")).rejects.toThrow(BinaryDownloadError);
      await expect(freebsdService.download("code-server")).rejects.toMatchObject({
        errorCode: "UNSUPPORTED_PLATFORM",
      });
    });

    it("selects correct platform asset for darwin", () => {
      const macPlatformInfo = createMockPlatformInfo({
        platform: "darwin",
        arch: "arm64",
      });
      const macService = new DefaultBinaryDownloadService(
        mockHttpClient,
        mockFs,
        mockArchiveExtractor,
        mockPathProvider,
        macPlatformInfo
      );

      // The binary path should be for darwin
      const path = macService.getBinaryPath("code-server");
      expect(path).toContain(join("bin", "code-server"));
      expect(path).not.toContain(".cmd");
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
          return [createDirEntry("code-server-4.106.3-linux-amd64", { isDirectory: true })];
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
        mockArchiveExtractor,
        mockPathProvider,
        mockPlatformInfo
      );

      await trackingService.download("code-server");

      // Verify rename was called for each nested entry (atomic moves)
      expect(trackingFs.rename).toHaveBeenCalledTimes(3);
      // Note: Service passes Path objects, so we check string representation
      const renameCalls = trackingFs.rename.mock.calls;
      expect(String(renameCalls[0]?.[0])).toBe(
        join(
          "/app-data",
          "code-server",
          CODE_SERVER_VERSION,
          "code-server-4.106.3-linux-amd64",
          "bin"
        )
      );
      expect(String(renameCalls[0]?.[1])).toBe(
        join("/app-data", "code-server", CODE_SERVER_VERSION, "bin")
      );

      // Verify the now-empty nested directory was removed
      const rmCalls = trackingFs.rm.mock.calls;
      const nestedDirRmCall = rmCalls.find((call) =>
        String(call[0]).includes("code-server-4.106.3-linux-amd64")
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

    expect(await mock.isInstalled("code-server")).toBe(true);
    expect(await mock.isInstalled("opencode")).toBe(true);
  });

  it("allows per-binary configuration", async () => {
    const { createMockBinaryDownloadService } =
      await import("./binary-download-service.test-utils");

    const mock = createMockBinaryDownloadService({
      installedBinaries: {
        "code-server": true,
        opencode: false,
        claude: false,
      },
    });

    expect(await mock.isInstalled("code-server")).toBe(true);
    expect(await mock.isInstalled("opencode")).toBe(false);
  });

  it("can simulate download error", async () => {
    const { createMockBinaryDownloadService } =
      await import("./binary-download-service.test-utils");

    const mock = createMockBinaryDownloadService({
      downloadError: { message: "Network error", code: "NETWORK_ERROR" },
    });

    await expect(mock.download("code-server")).rejects.toThrow(BinaryDownloadError);
  });
});
