/**
 * Unit tests for BinaryDownloadService.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { DefaultBinaryDownloadService } from "./binary-download-service";
import { BinaryDownloadError } from "./errors";
import { CODE_SERVER_VERSION, OPENCODE_VERSION } from "./versions";
import { createMockHttpClient } from "../platform/network.test-utils";
import { createMockFileSystemLayer, createDirEntry } from "../platform/filesystem.test-utils";
import { createMockArchiveExtractor } from "./archive-extractor.test-utils";
import { createMockPathProvider } from "../platform/path-provider.test-utils";
import { createMockPlatformInfo } from "../platform/platform-info.test-utils";
import { FileSystemError } from "../errors";

describe("DefaultBinaryDownloadService", () => {
  const mockHttpClient = createMockHttpClient();
  const mockFs = createMockFileSystemLayer();
  const mockArchiveExtractor = createMockArchiveExtractor();
  const mockPathProvider = createMockPathProvider({
    dataRootDir: "/app-data",
    binDir: "/app-data/bin",
  });
  const mockPlatformInfo = createMockPlatformInfo({
    platform: "linux",
    arch: "x64",
  });

  let service: DefaultBinaryDownloadService;

  beforeEach(() => {
    vi.clearAllMocks();
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
      expect(path).toBe(`/app-data/code-server/${CODE_SERVER_VERSION}/bin/code-server`);
    });

    it("returns correct path for opencode on Linux", () => {
      const path = service.getBinaryPath("opencode");
      expect(path).toBe(`/app-data/opencode/${OPENCODE_VERSION}/opencode`);
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
      expect(path).toBe(`/app-data/code-server/${CODE_SERVER_VERSION}/bin/code-server.cmd`);
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
      expect(path).toBe(`/app-data/opencode/${OPENCODE_VERSION}/opencode.exe`);
    });
  });

  describe("isInstalled", () => {
    it("returns true when binary directory exists", async () => {
      // Create service with fs that returns directory entries
      const fsWithDir = createMockFileSystemLayer({
        readdir: {
          entries: [createDirEntry("bin", { isDirectory: true })],
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
      // Create service with fs that throws ENOENT
      const fsWithNoDir = createMockFileSystemLayer({
        readdir: {
          error: new FileSystemError("ENOENT", "/app-data/code-server", "Directory not found"),
        },
      });
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
        response: new Response(null, { status: 404 }),
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
        error: new TypeError("Failed to fetch"),
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
      expect(path).toContain("bin/code-server");
      expect(path).not.toContain(".cmd");
    });
  });

  describe("createWrapperScripts", () => {
    it("creates wrapper scripts in binDir", async () => {
      // Track calls with custom implementation
      const mkdirCalls: Array<{ path: string; options: unknown }> = [];
      const writeFileCalls: Array<{ path: string; content: string }> = [];

      const trackingFs = createMockFileSystemLayer({
        mkdir: {
          implementation: async (path, options) => {
            mkdirCalls.push({ path, options });
          },
        },
        writeFile: {
          implementation: async (path, content) => {
            writeFileCalls.push({ path, content });
          },
        },
      });

      const trackingService = new DefaultBinaryDownloadService(
        mockHttpClient,
        trackingFs,
        mockArchiveExtractor,
        mockPathProvider,
        mockPlatformInfo
      );

      await trackingService.createWrapperScripts();

      expect(mkdirCalls).toHaveLength(1);
      expect(mkdirCalls[0]?.path).toBe("/app-data/bin");
      expect(mkdirCalls[0]?.options).toEqual({ recursive: true });
      expect(writeFileCalls).toHaveLength(2);
    });

    it("creates Unix shell scripts on Linux", async () => {
      const writeFileCalls: Array<{ path: string; content: string }> = [];

      const trackingFs = createMockFileSystemLayer({
        writeFile: {
          implementation: async (path, content) => {
            writeFileCalls.push({ path, content });
          },
        },
      });

      const trackingService = new DefaultBinaryDownloadService(
        mockHttpClient,
        trackingFs,
        mockArchiveExtractor,
        mockPathProvider,
        mockPlatformInfo
      );

      await trackingService.createWrapperScripts();

      // Check code-server wrapper
      const codeServerCall = writeFileCalls.find((c) => c.path.includes("code-server"));
      expect(codeServerCall).toBeDefined();
      expect(codeServerCall?.content).toContain("#!/bin/sh");
      expect(codeServerCall?.content).toContain("exec");

      // Check opencode wrapper
      const opencodeCall = writeFileCalls.find((c) => c.path.includes("opencode"));
      expect(opencodeCall).toBeDefined();
      expect(opencodeCall?.content).toContain("#!/bin/sh");
    });

    it("creates batch scripts on Windows", async () => {
      const writeFileCalls: Array<{ path: string; content: string }> = [];

      const trackingFs = createMockFileSystemLayer({
        writeFile: {
          implementation: async (path, content) => {
            writeFileCalls.push({ path, content });
          },
        },
      });

      const winPlatformInfo = createMockPlatformInfo({
        platform: "win32",
        arch: "x64",
      });
      const winService = new DefaultBinaryDownloadService(
        mockHttpClient,
        trackingFs,
        mockArchiveExtractor,
        mockPathProvider,
        winPlatformInfo
      );

      await winService.createWrapperScripts();

      // Check code-server wrapper
      const codeServerCall = writeFileCalls.find((c) => c.path.includes("code-server.cmd"));
      expect(codeServerCall).toBeDefined();
      expect(codeServerCall?.content).toContain("@echo off");

      // Check opencode wrapper
      const opencodeCall = writeFileCalls.find((c) => c.path.includes("opencode.cmd"));
      expect(opencodeCall).toBeDefined();
      expect(opencodeCall?.content).toContain("@echo off");
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
