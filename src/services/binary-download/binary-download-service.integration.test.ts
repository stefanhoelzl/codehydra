// @vitest-environment node
/**
 * Integration tests for BinaryDownloadService.
 * Tests multi-component flows: BinaryDownloadService + ArchiveExtractor + FileSystemLayer.
 * Uses real FileSystemLayer but mocked HttpClient.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { DefaultBinaryDownloadService } from "./binary-download-service";
import { DefaultArchiveExtractor } from "./archive-extractor";
import { DefaultFileSystemLayer } from "../platform/filesystem";
import { createMockPathProvider } from "../platform/path-provider.test-utils";
import { createMockPlatformInfo } from "../platform/platform-info.test-utils";
import { createMockHttpClient } from "../platform/http-client.state-mock";
import { createTestTarGzWithRoot, cleanupTestArchive } from "./test-utils";
import { CODE_SERVER_VERSION, OPENCODE_VERSION } from "./versions";
import { createMockLogger } from "../logging/logging.test-utils";

describe("BinaryDownloadService (integration)", () => {
  let tempDir: string;

  beforeEach(async () => {
    // Create a fresh temp directory for each test
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "binary-download-int-test-"));
  });

  afterEach(async () => {
    // Clean up temp directory
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("download and extract flow", () => {
    it("downloads, extracts, and flattens nested directory structure", async () => {
      // Create a test archive with nested directory (mimics GitHub release structure)
      const archivePath = await createTestTarGzWithRoot(
        {
          "bin/code-server": "#!/bin/sh\necho code-server",
          "lib/vscode/README.md": "# VS Code",
        },
        `code-server-${CODE_SERVER_VERSION}-linux-amd64`
      );

      try {
        // Read archive content for mock response
        const archiveContent = await fs.readFile(archivePath);

        // Create mock HttpClient that returns the archive
        const mockHttpClient = createMockHttpClient({
          defaultResponse: {
            body: archiveContent,
            status: 200,
            headers: { "content-length": String(archiveContent.length) },
          },
        });

        // Create real FileSystemLayer and ArchiveExtractor
        const fileSystemLayer = new DefaultFileSystemLayer(createMockLogger());
        const archiveExtractor = new DefaultArchiveExtractor();

        // Create PathProvider pointing to temp directory
        const pathProvider = createMockPathProvider({
          codeServerDir: `${tempDir}/code-server/${CODE_SERVER_VERSION}`,
          opencodeDir: `${tempDir}/opencode/${OPENCODE_VERSION}`,
          dataRootDir: tempDir,
        });

        // Create PlatformInfo for Linux
        const platformInfo = createMockPlatformInfo({
          platform: "linux",
          arch: "x64",
        });

        // Create service
        const service = new DefaultBinaryDownloadService(
          mockHttpClient,
          fileSystemLayer,
          archiveExtractor,
          pathProvider,
          platformInfo
        );

        // Download code-server
        await service.download("code-server");

        // Verify binary was extracted and flattened
        const binaryPath = service.getBinaryPath("code-server");
        const binaryContent = await fs.readFile(binaryPath, "utf-8");
        expect(binaryContent).toBe("#!/bin/sh\necho code-server");

        // Verify the directory structure was flattened (no nested release dir)
        const destDir = path.join(tempDir, "code-server", CODE_SERVER_VERSION);
        const entries = await fs.readdir(destDir);
        expect(entries).toContain("bin");
        expect(entries).toContain("lib");
        expect(entries).not.toContain(`code-server-${CODE_SERVER_VERSION}-linux-amd64`);
      } finally {
        await cleanupTestArchive(archivePath);
      }
    });

    // Skip on Windows - Unix permissions don't apply
    it.skipIf(process.platform === "win32")(
      "sets executable permissions on the binary (Unix)",
      async () => {
        // Create a test archive
        const archivePath = await createTestTarGzWithRoot(
          {
            opencode: "#!/bin/sh\necho opencode",
          },
          `opencode-${OPENCODE_VERSION}-linux-x64`
        );

        try {
          const archiveContent = await fs.readFile(archivePath);
          const mockHttpClient = createMockHttpClient({
            defaultResponse: {
              body: archiveContent,
              status: 200,
              headers: { "content-length": String(archiveContent.length) },
            },
          });

          const fileSystemLayer = new DefaultFileSystemLayer(createMockLogger());
          const archiveExtractor = new DefaultArchiveExtractor();
          const pathProvider = createMockPathProvider({
            codeServerDir: `${tempDir}/code-server/${CODE_SERVER_VERSION}`,
            opencodeDir: `${tempDir}/opencode/${OPENCODE_VERSION}`,
            dataRootDir: tempDir,
          });
          const platformInfo = createMockPlatformInfo({
            platform: "linux",
            arch: "x64",
          });

          const service = new DefaultBinaryDownloadService(
            mockHttpClient,
            fileSystemLayer,
            archiveExtractor,
            pathProvider,
            platformInfo
          );

          await service.download("opencode");

          // Verify binary has executable permissions
          const binaryPath = service.getBinaryPath("opencode");
          const stats = await fs.stat(binaryPath);
          // Check executable bit (owner executable = 0o100)
          expect(stats.mode & 0o100).toBeTruthy();
        } finally {
          await cleanupTestArchive(archivePath);
        }
      }
    );

    it("isInstalled returns true after download", async () => {
      const archivePath = await createTestTarGzWithRoot(
        {
          opencode: "#!/bin/sh\necho opencode",
        },
        `opencode-${OPENCODE_VERSION}-linux-x64`
      );

      try {
        const archiveContent = await fs.readFile(archivePath);
        const mockHttpClient = createMockHttpClient({
          defaultResponse: {
            body: archiveContent,
            status: 200,
            headers: { "content-length": String(archiveContent.length) },
          },
        });

        const fileSystemLayer = new DefaultFileSystemLayer(createMockLogger());
        const archiveExtractor = new DefaultArchiveExtractor();
        const pathProvider = createMockPathProvider({
          codeServerDir: `${tempDir}/code-server/${CODE_SERVER_VERSION}`,
          opencodeDir: `${tempDir}/opencode/${OPENCODE_VERSION}`,
          dataRootDir: tempDir,
        });
        const platformInfo = createMockPlatformInfo({
          platform: "linux",
          arch: "x64",
        });

        const service = new DefaultBinaryDownloadService(
          mockHttpClient,
          fileSystemLayer,
          archiveExtractor,
          pathProvider,
          platformInfo
        );

        // Before download
        expect(await service.isInstalled("opencode")).toBe(false);

        // After download
        await service.download("opencode");
        expect(await service.isInstalled("opencode")).toBe(true);
      } finally {
        await cleanupTestArchive(archivePath);
      }
    });
  });

  describe("progress callback", () => {
    it("reports download progress", async () => {
      // Create a test archive
      const archivePath = await createTestTarGzWithRoot(
        {
          opencode: "#!/bin/sh\necho opencode",
        },
        `opencode-${OPENCODE_VERSION}-linux-x64`
      );

      try {
        const archiveContent = await fs.readFile(archivePath);
        const mockHttpClient = createMockHttpClient({
          defaultResponse: {
            body: archiveContent,
            status: 200,
            headers: { "content-length": String(archiveContent.length) },
          },
        });

        const fileSystemLayer = new DefaultFileSystemLayer(createMockLogger());
        const archiveExtractor = new DefaultArchiveExtractor();
        const pathProvider = createMockPathProvider({
          codeServerDir: `${tempDir}/code-server/${CODE_SERVER_VERSION}`,
          opencodeDir: `${tempDir}/opencode/${OPENCODE_VERSION}`,
          dataRootDir: tempDir,
        });
        const platformInfo = createMockPlatformInfo({
          platform: "linux",
          arch: "x64",
        });

        const service = new DefaultBinaryDownloadService(
          mockHttpClient,
          fileSystemLayer,
          archiveExtractor,
          pathProvider,
          platformInfo
        );

        const progressUpdates: { bytesDownloaded: number; totalBytes: number | null }[] = [];
        await service.download("opencode", (progress) => {
          progressUpdates.push(progress);
        });

        // Verify progress was reported
        expect(progressUpdates.length).toBeGreaterThan(0);

        // Last progress should have final bytes
        const lastProgress = progressUpdates[progressUpdates.length - 1];
        expect(lastProgress?.bytesDownloaded).toBe(archiveContent.length);
        expect(lastProgress?.totalBytes).toBe(archiveContent.length);
      } finally {
        await cleanupTestArchive(archivePath);
      }
    });
  });
});
