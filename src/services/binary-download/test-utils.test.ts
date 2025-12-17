/**
 * Tests for binary download test utilities.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as tar from "tar";
import {
  createTestTarGz,
  createTestTarGzWithRoot,
  createTestZip,
  createTestZipWithRoot,
  createMockDownloadResponse,
  createMockGitHubReleaseResponse,
  cleanupTestArchive,
} from "./test-utils";
import { ZipExtractor } from "./archive-extractor";

describe("createTestTarGz", () => {
  let archivePath: string | undefined;

  afterEach(async () => {
    if (archivePath) {
      await cleanupTestArchive(archivePath);
      archivePath = undefined;
    }
  });

  it("creates a valid tar.gz archive", async () => {
    archivePath = await createTestTarGz({
      "test.txt": "Hello, World!",
    });

    // Verify archive exists
    const stats = await fs.stat(archivePath);
    expect(stats.isFile()).toBe(true);

    // Verify archive is valid tar.gz
    const entries: string[] = [];
    await tar.list({
      file: archivePath,
      onentry: (entry) => entries.push(entry.path),
    });

    // tar includes paths like './' and './test.txt'
    expect(entries.some((e) => e.endsWith("test.txt"))).toBe(true);
  });

  it("creates nested directory structure", async () => {
    archivePath = await createTestTarGz({
      "bin/my-binary": "#!/bin/sh\necho hello",
      "lib/config.json": '{"version": "1.0.0"}',
    });

    const entries: string[] = [];
    await tar.list({
      file: archivePath,
      onentry: (entry) => entries.push(entry.path),
    });

    expect(entries.some((e) => e.includes("bin/my-binary"))).toBe(true);
    expect(entries.some((e) => e.includes("lib/config.json"))).toBe(true);
  });
});

describe("createTestTarGzWithRoot", () => {
  let archivePath: string | undefined;

  afterEach(async () => {
    if (archivePath) {
      await cleanupTestArchive(archivePath);
      archivePath = undefined;
    }
  });

  it("creates archive with nested root directory", async () => {
    archivePath = await createTestTarGzWithRoot(
      {
        "bin/my-binary": "#!/bin/sh\necho hello",
      },
      "my-binary-1.0.0"
    );

    const entries: string[] = [];
    await tar.list({
      file: archivePath,
      onentry: (entry) => entries.push(entry.path),
    });

    expect(entries.some((e) => e.includes("my-binary-1.0.0/bin/my-binary"))).toBe(true);
  });
});

describe("createTestZip", () => {
  let archivePath: string | undefined;
  let tempExtractDir: string | undefined;

  afterEach(async () => {
    if (archivePath) {
      await cleanupTestArchive(archivePath);
      archivePath = undefined;
    }
    if (tempExtractDir) {
      await fs.rm(tempExtractDir, { recursive: true, force: true });
      tempExtractDir = undefined;
    }
  });

  it("creates a valid zip archive", async () => {
    archivePath = await createTestZip({
      "test.txt": "Hello from zip!",
    });

    // Verify archive exists
    const stats = await fs.stat(archivePath);
    expect(stats.isFile()).toBe(true);

    // Verify archive is valid by extracting it
    tempExtractDir = await fs.mkdtemp(path.join(os.tmpdir(), "zip-test-"));
    const extractor = new ZipExtractor();
    await extractor.extract(archivePath, tempExtractDir);

    const content = await fs.readFile(path.join(tempExtractDir, "test.txt"), "utf-8");
    expect(content).toBe("Hello from zip!");
  });

  it("creates nested directory structure", async () => {
    archivePath = await createTestZip({
      "bin/my-binary.exe": "@echo off\necho hello",
      "lib/config.json": '{"version": "1.0.0"}',
    });

    // Extract and verify
    tempExtractDir = await fs.mkdtemp(path.join(os.tmpdir(), "zip-test-"));
    const extractor = new ZipExtractor();
    await extractor.extract(archivePath, tempExtractDir);

    const binaryContent = await fs.readFile(
      path.join(tempExtractDir, "bin", "my-binary.exe"),
      "utf-8"
    );
    expect(binaryContent).toBe("@echo off\necho hello");

    const configContent = await fs.readFile(
      path.join(tempExtractDir, "lib", "config.json"),
      "utf-8"
    );
    expect(configContent).toBe('{"version": "1.0.0"}');
  });
});

describe("createTestZipWithRoot", () => {
  let archivePath: string | undefined;
  let tempExtractDir: string | undefined;

  afterEach(async () => {
    if (archivePath) {
      await cleanupTestArchive(archivePath);
      archivePath = undefined;
    }
    if (tempExtractDir) {
      await fs.rm(tempExtractDir, { recursive: true, force: true });
      tempExtractDir = undefined;
    }
  });

  it("creates archive with nested root directory", async () => {
    archivePath = await createTestZipWithRoot(
      {
        "bin/my-binary.exe": "@echo off\necho hello",
      },
      "my-binary-1.0.0-win32-x64"
    );

    // Extract and verify root directory structure
    tempExtractDir = await fs.mkdtemp(path.join(os.tmpdir(), "zip-test-"));
    const extractor = new ZipExtractor();
    await extractor.extract(archivePath, tempExtractDir);

    const content = await fs.readFile(
      path.join(tempExtractDir, "my-binary-1.0.0-win32-x64", "bin", "my-binary.exe"),
      "utf-8"
    );
    expect(content).toBe("@echo off\necho hello");
  });
});

describe("createMockDownloadResponse", () => {
  it("creates a Response with body", async () => {
    const response = createMockDownloadResponse("test content");

    expect(response.ok).toBe(true);
    expect(response.status).toBe(200);

    const text = await response.text();
    expect(text).toBe("test content");
  });

  it("creates a Response with Content-Length header", () => {
    const response = createMockDownloadResponse("test content", 12);

    expect(response.headers.get("Content-Length")).toBe("12");
  });

  it("creates a Response with Buffer body", async () => {
    const buffer = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // ZIP magic bytes
    const response = createMockDownloadResponse(buffer);

    const arrayBuffer = await response.arrayBuffer();
    expect(new Uint8Array(arrayBuffer)).toEqual(new Uint8Array(buffer));
  });
});

describe("createMockGitHubReleaseResponse", () => {
  it("creates valid JSON response", () => {
    const json = createMockGitHubReleaseResponse("v4.106.3", [
      {
        name: "code-server-4.106.3-linux-amd64.tar.gz",
        browser_download_url:
          "https://github.com/coder/code-server/releases/download/v4.106.3/code-server-4.106.3-linux-amd64.tar.gz",
        size: 100000000,
        content_type: "application/gzip",
      },
    ]);

    const parsed = JSON.parse(json);

    expect(parsed.tag_name).toBe("v4.106.3");
    expect(parsed.assets).toHaveLength(1);
    expect(parsed.assets[0].name).toBe("code-server-4.106.3-linux-amd64.tar.gz");
  });
});

describe("cleanupTestArchive", () => {
  it("removes archive and parent directory", async () => {
    const archivePath = await createTestTarGz({ "test.txt": "content" });
    const parentDir = path.dirname(archivePath);

    // Verify they exist
    await expect(fs.stat(archivePath)).resolves.toBeDefined();
    await expect(fs.stat(parentDir)).resolves.toBeDefined();

    // Clean up
    await cleanupTestArchive(archivePath);

    // Verify removed
    await expect(fs.stat(parentDir)).rejects.toThrow();
  });
});
