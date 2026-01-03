/**
 * Boundary tests for BinaryDownloadService.
 *
 * Tests actual downloads from GitHub releases (HEAD requests) and
 * archive extraction with real files.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { DefaultBinaryDownloadService } from "./binary-download-service";
import { DefaultArchiveExtractor } from "./archive-extractor";
import { BINARY_CONFIGS, CODE_SERVER_VERSION } from "./versions";
import { DefaultNetworkLayer } from "../platform/network";
import { DefaultFileSystemLayer } from "../platform/filesystem";
import { SILENT_LOGGER } from "../logging";
import { createMockPathProvider } from "../platform/path-provider.test-utils";
import { createMockPlatformInfo } from "../platform/platform-info.test-utils";
import { createTestTarGzWithRoot, cleanupTestArchive } from "./test-utils";
import type { SupportedArch, SupportedPlatform } from "./types";

// Skip tests that require network in CI environments with restricted network access
const skipNetworkTests = process.env.CI === "true" && process.env.NETWORK_TESTS !== "true";

describe("BinaryDownloadService (boundary)", () => {
  describe("URL validation", () => {
    // Test that GitHub release URLs are valid using HEAD requests
    const networkLayer = new DefaultNetworkLayer(SILENT_LOGGER);

    const platformCombinations: Array<{ platform: SupportedPlatform; arch: SupportedArch }> = [
      { platform: "darwin", arch: "x64" },
      { platform: "darwin", arch: "arm64" },
      { platform: "linux", arch: "x64" },
      { platform: "linux", arch: "arm64" },
      { platform: "win32", arch: "x64" },
    ];

    describe("code-server release URLs", () => {
      for (const { platform, arch } of platformCombinations) {
        it.skipIf(skipNetworkTests)(
          `URL is valid for ${platform}-${arch}`,
          async () => {
            const url = BINARY_CONFIGS["code-server"].getUrl(platform, arch);

            // Use HEAD request to check URL validity (follows redirects)
            const response = await networkLayer.fetch(url, { timeout: 10000 });

            // GitHub returns 200 for release assets (redirects are followed automatically)
            expect(
              response.ok || response.status === 302,
              `Expected 200 or 302 for ${url}, got ${response.status}`
            ).toBe(true);
          },
          30000
        );
      }
    });

    describe("opencode release URLs", () => {
      for (const { platform, arch } of platformCombinations) {
        it.skipIf(skipNetworkTests)(
          `URL is valid for ${platform}-${arch}`,
          async () => {
            const url = BINARY_CONFIGS["opencode"].getUrl(platform, arch);

            const response = await networkLayer.fetch(url, { timeout: 10000 });

            expect(
              response.ok || response.status === 302,
              `Expected 200 or 302 for ${url}, got ${response.status}`
            ).toBe(true);
          },
          30000
        );
      }
    });
  });

  describe("download and extract flow", () => {
    let tempDir: string;
    let archivePath: string | undefined;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "binary-download-test-"));
    });

    afterEach(async () => {
      if (archivePath) {
        await cleanupTestArchive(archivePath);
        archivePath = undefined;
      }
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    it("extracts and flattens nested archive structure", async () => {
      // Create a test archive with nested root directory (like GitHub releases)
      archivePath = await createTestTarGzWithRoot(
        {
          "bin/test-binary": "#!/bin/sh\necho hello",
          "lib/config.json": '{"version": "1.0.0"}',
        },
        "test-binary-1.0.0-linux-amd64"
      );

      // Read archive as buffer
      const archiveContent = await fs.readFile(archivePath);

      // Create a mock HTTP client that returns our test archive
      const mockHttpClient = {
        async fetch() {
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(archiveContent));
              controller.close();
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { "Content-Length": archiveContent.length.toString() },
          });
        },
      };

      const mockPathProvider = createMockPathProvider({
        dataRootDir: tempDir,
        binDir: path.join(tempDir, "bin"),
      });

      const mockPlatformInfo = createMockPlatformInfo({
        platform: "linux",
        arch: "x64",
      });

      const service = new DefaultBinaryDownloadService(
        mockHttpClient,
        new DefaultFileSystemLayer(SILENT_LOGGER),
        new DefaultArchiveExtractor(),
        mockPathProvider,
        mockPlatformInfo
      );

      // Download (uses our mock HTTP client)
      await service.download("code-server");

      // Verify the binary was extracted and flattened (nested dir moved up)
      const binaryDir = path.join(tempDir, "code-server", CODE_SERVER_VERSION);
      const binPath = path.join(binaryDir, "bin", "test-binary");

      const content = await fs.readFile(binPath, "utf-8");
      expect(content).toBe("#!/bin/sh\necho hello");

      // Verify config.json is also present
      const configPath = path.join(binaryDir, "lib", "config.json");
      const configContent = await fs.readFile(configPath, "utf-8");
      expect(configContent).toBe('{"version": "1.0.0"}');
    });

    it("reports download progress", async () => {
      archivePath = await createTestTarGzWithRoot({ "test.txt": "content" }, "test-1.0.0");

      const archiveContent = await fs.readFile(archivePath);

      // Create mock that streams in chunks
      const mockHttpClient = {
        async fetch() {
          const chunks = [archiveContent.slice(0, 50), archiveContent.slice(50)];
          let chunkIndex = 0;

          const stream = new ReadableStream({
            pull(controller) {
              if (chunkIndex < chunks.length) {
                controller.enqueue(new Uint8Array(chunks[chunkIndex]!));
                chunkIndex++;
              } else {
                controller.close();
              }
            },
          });

          return new Response(stream, {
            status: 200,
            headers: { "Content-Length": archiveContent.length.toString() },
          });
        },
      };

      const mockPathProvider = createMockPathProvider({
        dataRootDir: tempDir,
        binDir: path.join(tempDir, "bin"),
      });

      const service = new DefaultBinaryDownloadService(
        mockHttpClient,
        new DefaultFileSystemLayer(SILENT_LOGGER),
        new DefaultArchiveExtractor(),
        mockPathProvider,
        createMockPlatformInfo({ platform: "linux", arch: "x64" })
      );

      const progressUpdates: Array<{ bytesDownloaded: number; totalBytes: number | null }> = [];

      await service.download("code-server", (progress) => {
        progressUpdates.push({ ...progress });
      });

      // Should have received progress updates
      expect(progressUpdates.length).toBeGreaterThan(0);

      // Final update should have downloaded all bytes
      const lastUpdate = progressUpdates[progressUpdates.length - 1];
      expect(lastUpdate?.bytesDownloaded).toBe(archiveContent.length);
      expect(lastUpdate?.totalBytes).toBe(archiveContent.length);
    });
  });
});
