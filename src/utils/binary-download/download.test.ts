/**
 * Tests for binary download utility functions.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { downloadBinary, isBinaryInstalled } from "./download";
import { BinaryDownloadError } from "../../shared/errors/service-errors";
import { createMockHttpClient } from "../../boundaries/platform/http-client.state-mock";
import {
  createFileSystemMock,
  createSpyFileSystemBoundary,
  directory,
  createDirEntry,
} from "../../boundaries/platform/filesystem.state-mock";
import { createArchiveExtractorMock } from "../../boundaries/platform/archive-extractor.state-mock";
import type { DownloadRequest } from "./types";
import type { DownloadDeps } from "./download";

describe("isBinaryInstalled", () => {
  it("returns true when binary directory exists", async () => {
    const fsWithDir = createFileSystemMock({
      entries: {
        "/app-data/code-server/4.109.2": directory(),
        "/app-data/code-server/4.109.2/bin": directory(),
      },
    });

    const result = await isBinaryInstalled("/app-data/code-server/4.109.2", {
      fileSystemLayer: fsWithDir,
    });

    expect(result).toBe(true);
  });

  it("returns false when binary directory does not exist", async () => {
    const fsWithNoDir = createFileSystemMock();

    const result = await isBinaryInstalled("/app-data/code-server/4.109.2", {
      fileSystemLayer: fsWithNoDir,
    });

    expect(result).toBe(false);
  });
});

describe("downloadBinary", () => {
  const mockHttpClient = createMockHttpClient();
  const mockFs = createFileSystemMock();

  let mockArchiveExtractor: ReturnType<typeof createArchiveExtractorMock>;

  beforeEach(() => {
    mockArchiveExtractor = createArchiveExtractorMock();
  });

  function createDeps(overrides?: Partial<DownloadDeps>): DownloadDeps {
    return {
      httpClient: overrides?.httpClient ?? mockHttpClient,
      fileSystemLayer: overrides?.fileSystemLayer ?? mockFs,
      archiveExtractor: overrides?.archiveExtractor ?? mockArchiveExtractor,
      ...("logger" in (overrides ?? {}) ? { logger: overrides?.logger } : {}),
    };
  }

  const codeServerRequest: DownloadRequest = {
    name: "code-server",
    url: "https://example.com/code-server-4.109.2-linux-amd64.tar.gz",
    destDir: "/app-data/code-server/4.109.2",
    archiveExtension: ".tar.gz",
    executablePath: "bin/code-server",
    subPath: "code-server-4.109.2-linux-amd64",
  };

  it("throws BinaryDownloadError on HTTP 404", async () => {
    const httpClient = createMockHttpClient({
      defaultResponse: { status: 404 },
    });

    await expect(downloadBinary(codeServerRequest, createDeps({ httpClient }))).rejects.toThrow(
      BinaryDownloadError
    );
    await expect(
      downloadBinary(codeServerRequest, createDeps({ httpClient }))
    ).rejects.toMatchObject({
      errorCode: "NETWORK_ERROR",
      message: expect.stringContaining("404"),
    });
  });

  it("throws BinaryDownloadError on network error", async () => {
    const httpClient = createMockHttpClient({
      defaultResponse: { error: new TypeError("Failed to fetch") },
    });

    await expect(downloadBinary(codeServerRequest, createDeps({ httpClient }))).rejects.toThrow(
      BinaryDownloadError
    );
    await expect(
      downloadBinary(codeServerRequest, createDeps({ httpClient }))
    ).rejects.toMatchObject({
      errorCode: "NETWORK_ERROR",
    });
  });

  it("promotes subPath contents to destDir root using rename", async () => {
    const successHttpClient = createMockHttpClient({
      defaultResponse: {
        body: "binary content",
        status: 200,
        headers: { "content-length": "14" },
      },
    });

    // Use spy filesystem to track calls - include temp directory for temp file writes
    const trackingFs = createSpyFileSystemBoundary({
      entries: {
        [tmpdir()]: directory(),
      },
    });

    // Override readdir to return subPath directory contents
    trackingFs.readdir = vi.fn(async () => {
      return [
        createDirEntry("bin", { isDirectory: true }),
        createDirEntry("lib", { isDirectory: true }),
        createDirEntry("package.json", { isFile: true }),
      ];
    });

    // Override rename and rm to be no-ops (we just want to track calls)
    trackingFs.rename = vi.fn(async () => {});
    trackingFs.rm = vi.fn(async () => {});

    await downloadBinary(
      codeServerRequest,
      createDeps({ httpClient: successHttpClient, fileSystemLayer: trackingFs })
    );

    // Verify readdir was called once (for the subPath directory)
    expect(trackingFs.readdir).toHaveBeenCalledTimes(1);
    expect(String(trackingFs.readdir.mock.calls[0]?.[0])).toBe(
      join("/app-data", "code-server", "4.109.2", "code-server-4.109.2-linux-amd64")
    );

    // Verify rename was called for each nested entry (atomic moves)
    expect(trackingFs.rename).toHaveBeenCalledTimes(3);
    const renameCalls = trackingFs.rename.mock.calls;
    expect(String(renameCalls[0]?.[0])).toBe(
      join("/app-data", "code-server", "4.109.2", "code-server-4.109.2-linux-amd64", "bin")
    );
    expect(String(renameCalls[0]?.[1])).toBe(join("/app-data", "code-server", "4.109.2", "bin"));

    // Verify the now-empty nested directory was removed
    const rmCalls = trackingFs.rm.mock.calls;
    const nestedDirRmCall = rmCalls.find((call: unknown[]) =>
      String(call[0]).includes("code-server-4.109.2-linux-amd64")
    );
    expect(nestedDirRmCall).toBeDefined();
    expect(nestedDirRmCall?.[1]).toEqual({ recursive: true, force: true });
  });

  it("does not flatten when subPath is not set", async () => {
    const successHttpClient = createMockHttpClient({
      defaultResponse: {
        body: "binary content",
        status: 200,
        headers: { "content-length": "14" },
      },
    });

    const trackingFs = createSpyFileSystemBoundary({
      entries: {
        [tmpdir()]: directory(),
      },
    });

    trackingFs.readdir = vi.fn(async () => []);
    trackingFs.rename = vi.fn(async () => {});

    const requestWithoutSubPath: DownloadRequest = {
      name: "test-binary",
      url: "https://example.com/test.tar.gz",
      destDir: "/app-data/test/1.0.0",
      archiveExtension: ".tar.gz",
    };

    await downloadBinary(
      requestWithoutSubPath,
      createDeps({ httpClient: successHttpClient, fileSystemLayer: trackingFs })
    );

    // readdir should NOT have been called (no subPath = no promotion)
    expect(trackingFs.readdir).not.toHaveBeenCalled();
    expect(trackingFs.rename).not.toHaveBeenCalled();
  });

  it("throws BinaryDownloadError when subPath does not exist", async () => {
    const successHttpClient = createMockHttpClient({
      defaultResponse: {
        body: "binary content",
        status: 200,
        headers: { "content-length": "14" },
      },
    });

    // Use empty filesystem - subPath directory won't exist
    const emptyFs = createSpyFileSystemBoundary({
      entries: {
        [tmpdir()]: directory(),
      },
    });

    const requestWithBadSubPath: DownloadRequest = {
      name: "test-binary",
      url: "https://example.com/test.tar.gz",
      destDir: "/app-data/test/1.0.0",
      archiveExtension: ".tar.gz",
      subPath: "nonexistent-dir",
    };

    await expect(
      downloadBinary(
        requestWithBadSubPath,
        createDeps({ httpClient: successHttpClient, fileSystemLayer: emptyFs })
      )
    ).rejects.toThrow(BinaryDownloadError);
    await expect(
      downloadBinary(
        requestWithBadSubPath,
        createDeps({ httpClient: successHttpClient, fileSystemLayer: emptyFs })
      )
    ).rejects.toMatchObject({
      errorCode: "EXTRACTION_FAILED",
      message: expect.stringContaining("nonexistent-dir"),
    });
  });
});
