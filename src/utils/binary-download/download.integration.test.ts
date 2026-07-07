// @vitest-environment node
/**
 * Integration tests for binary download utility.
 * Tests multi-component flows: downloadBinary + ArchiveExtractor + FileSystemBoundary.
 * Uses real FileSystemBoundary but mocked HttpClient.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { downloadBinary, isBinaryInstalled } from "./download";
import { DefaultArchiveExtractor } from "../../boundaries/platform/archive-extractor";
import { DefaultFileSystemBoundary } from "../../boundaries/platform/filesystem";
import { createMockHttpClient } from "../../boundaries/platform/http-client.state-mock";
import { createTestTarGzWithRoot, cleanupTestArchive } from "./test-utils";
import { createMockLogger } from "../../boundaries/platform/logging.test-utils";
import type { DownloadRequest } from "./types";
import type { DownloadDeps } from "./download";

describe("downloadBinary (integration)", () => {
  let tempDir: string;

  beforeEach(async () => {
    // Create a fresh temp directory for each test
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "binary-download-int-test-"));
  });

  afterEach(async () => {
    // Clean up temp directory
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function createDeps(httpClient: ReturnType<typeof createMockHttpClient>): DownloadDeps {
    return {
      httpClient,
      fileSystemLayer: new DefaultFileSystemBoundary(createMockLogger()),
      archiveExtractor: new DefaultArchiveExtractor(),
    };
  }

  describe("download and extract flow", () => {
    it("downloads, extracts, and flattens nested directory structure", async () => {
      // Create a test archive with nested directory (mimics GitHub release structure)
      const archivePath = await createTestTarGzWithRoot(
        {
          "bin/code-server": "#!/bin/sh\necho code-server",
          "lib/vscode/README.md": "# VS Code",
        },
        "code-server-4.109.2-linux-amd64"
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

        const destDir = path.join(tempDir, "code-server", "4.109.2");

        const request: DownloadRequest = {
          name: "code-server",
          url: "https://example.com/code-server-4.109.2-linux-amd64.tar.gz",
          destDir,
          archiveExtension: ".tar.gz",
          executablePath: "bin/code-server",
          subPath: "code-server-4.109.2-linux-amd64",
        };

        // Download code-server
        await downloadBinary(request, createDeps(mockHttpClient));

        // Verify binary was extracted and subPath promoted
        const binaryPath = path.join(destDir, "bin", "code-server");
        const binaryContent = await fs.readFile(binaryPath, "utf-8");
        expect(binaryContent).toBe("#!/bin/sh\necho code-server");

        // Verify the subPath was promoted (no nested release dir)
        const entries = await fs.readdir(destDir);
        expect(entries).toContain("bin");
        expect(entries).toContain("lib");
        expect(entries).not.toContain("code-server-4.109.2-linux-amd64");
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
          "opencode-0.1.47-linux-x64"
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

          const destDir = path.join(tempDir, "opencode", "0.1.47");

          const request: DownloadRequest = {
            name: "opencode",
            url: "https://example.com/opencode-0.1.47-linux-x64.tar.gz",
            destDir,
            archiveExtension: ".tar.gz",
            executablePath: "opencode",
            subPath: "opencode-0.1.47-linux-x64",
          };

          await downloadBinary(request, createDeps(mockHttpClient));

          // Verify binary has executable permissions
          const binaryPath = path.join(destDir, "opencode");
          const stats = await fs.stat(binaryPath);
          // Check executable bit (owner executable = 0o100)
          expect(stats.mode & 0o100).toBeTruthy();
        } finally {
          await cleanupTestArchive(archivePath);
        }
      }
    );

    it("isBinaryInstalled returns true after download", async () => {
      const archivePath = await createTestTarGzWithRoot(
        {
          opencode: "#!/bin/sh\necho opencode",
        },
        "opencode-0.1.47-linux-x64"
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

        const fileSystemLayer = new DefaultFileSystemBoundary(createMockLogger());
        const destDir = path.join(tempDir, "opencode", "0.1.47");

        const deps: DownloadDeps = {
          httpClient: mockHttpClient,
          fileSystemLayer,
          archiveExtractor: new DefaultArchiveExtractor(),
        };

        const request: DownloadRequest = {
          name: "opencode",
          url: "https://example.com/opencode-0.1.47-linux-x64.tar.gz",
          destDir,
          archiveExtension: ".tar.gz",
          executablePath: "opencode",
          subPath: "opencode-0.1.47-linux-x64",
        };

        // Before download
        expect(await isBinaryInstalled(destDir, deps)).toBe(false);

        // After download
        await downloadBinary(request, deps);
        expect(await isBinaryInstalled(destDir, deps)).toBe(true);
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
        "opencode-0.1.47-linux-x64"
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

        const destDir = path.join(tempDir, "opencode", "0.1.47");

        const request: DownloadRequest = {
          name: "opencode",
          url: "https://example.com/opencode-0.1.47-linux-x64.tar.gz",
          destDir,
          archiveExtension: ".tar.gz",
          executablePath: "opencode",
          subPath: "opencode-0.1.47-linux-x64",
        };

        const progressUpdates: {
          phase: "downloading" | "extracting";
          bytesDownloaded: number;
          totalBytes: number | null;
        }[] = [];
        await downloadBinary(request, createDeps(mockHttpClient), (progress) => {
          progressUpdates.push(progress);
        });

        // Verify progress was reported
        expect(progressUpdates.length).toBeGreaterThan(0);

        // Filter to downloading phase updates
        const downloadUpdates = progressUpdates.filter((p) => p.phase === "downloading");
        expect(downloadUpdates.length).toBeGreaterThan(0);

        // Last downloading progress should have final bytes
        const lastDownloadProgress = downloadUpdates[downloadUpdates.length - 1];
        expect(lastDownloadProgress?.bytesDownloaded).toBe(archiveContent.length);
        expect(lastDownloadProgress?.totalBytes).toBe(archiveContent.length);

        // Should report the extracting phase, ending at 100% (compressed bytes
        // consumed == archive size).
        const extractUpdates = progressUpdates.filter((p) => p.phase === "extracting");
        expect(extractUpdates.length).toBeGreaterThan(0);
        const measuredExtract = extractUpdates.filter((p) => p.totalBytes !== null);
        expect(measuredExtract.length).toBeGreaterThan(0);
        const lastExtract = measuredExtract[measuredExtract.length - 1];
        expect(lastExtract?.bytesDownloaded).toBe(lastExtract?.totalBytes);
      } finally {
        await cleanupTestArchive(archivePath);
      }
    });
  });
});
