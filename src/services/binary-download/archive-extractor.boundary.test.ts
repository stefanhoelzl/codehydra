/**
 * Boundary tests for ArchiveExtractor implementations.
 * Tests extraction with real archive files.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import { TarExtractor, ZipExtractor, DefaultArchiveExtractor } from "./archive-extractor";
import { ArchiveError } from "./errors";

describe("TarExtractor (boundary)", () => {
  let tempDir: string;
  let archivePath: string;
  let destDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tar-test-"));
    archivePath = path.join(tempDir, "test.tar.gz");
    destDir = path.join(tempDir, "extracted");
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("extracts a real tar.gz archive", async () => {
    // Create a simple tar.gz archive using system tar
    const sourceDir = path.join(tempDir, "source");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "test.txt"), "Hello, World!");
    await fs.mkdir(path.join(sourceDir, "subdir"));
    await fs.writeFile(path.join(sourceDir, "subdir", "nested.txt"), "Nested content");

    // Create archive (--force-local prevents tar from interpreting colons as remote hosts)
    execSync(`tar --force-local -czf "${archivePath}" -C "${sourceDir}" .`);

    // Extract using TarExtractor
    const extractor = new TarExtractor();
    await extractor.extract(archivePath, destDir);

    // Verify contents
    const testContent = await fs.readFile(path.join(destDir, "test.txt"), "utf-8");
    expect(testContent).toBe("Hello, World!");

    const nestedContent = await fs.readFile(path.join(destDir, "subdir", "nested.txt"), "utf-8");
    expect(nestedContent).toBe("Nested content");
  });

  it("preserves file permissions", async () => {
    // Skip on Windows where permissions work differently
    if (process.platform === "win32") {
      return;
    }

    const sourceDir = path.join(tempDir, "source");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "script.sh"), "#!/bin/sh\necho hello");
    await fs.chmod(path.join(sourceDir, "script.sh"), 0o755);

    // Create archive (--force-local prevents tar from interpreting colons as remote hosts)
    execSync(`tar --force-local -czf "${archivePath}" -C "${sourceDir}" .`);

    // Extract
    const extractor = new TarExtractor();
    await extractor.extract(archivePath, destDir);

    // Check permissions
    const stats = await fs.stat(path.join(destDir, "script.sh"));
    // At least executable bit should be set
    expect(stats.mode & 0o111).not.toBe(0);
  });

  it("throws INVALID_ARCHIVE for corrupt archive", async () => {
    // Write garbage to the archive file
    await fs.writeFile(archivePath, "not a valid tar.gz file");

    const extractor = new TarExtractor();

    await expect(extractor.extract(archivePath, destDir)).rejects.toThrow(ArchiveError);
    await expect(extractor.extract(archivePath, destDir)).rejects.toMatchObject({
      errorCode: "INVALID_ARCHIVE",
    });
  });
});

describe("ZipExtractor (boundary)", () => {
  let tempDir: string;
  let archivePath: string;
  let destDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "zip-test-"));
    archivePath = path.join(tempDir, "test.zip");
    destDir = path.join(tempDir, "extracted");
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("extracts a real zip archive", async () => {
    // Create a simple zip archive using system zip (if available)
    const sourceDir = path.join(tempDir, "source");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "test.txt"), "Hello from zip!");
    await fs.mkdir(path.join(sourceDir, "subdir"));
    await fs.writeFile(path.join(sourceDir, "subdir", "nested.txt"), "Nested zip content");

    try {
      // Try using zip command
      execSync(`cd "${sourceDir}" && zip -r "${archivePath}" .`, { stdio: "pipe" });
    } catch {
      // zip not available, skip test
      console.log("zip command not available, skipping ZipExtractor boundary test");
      return;
    }

    // Extract using ZipExtractor
    const extractor = new ZipExtractor();
    await extractor.extract(archivePath, destDir);

    // Verify contents
    const testContent = await fs.readFile(path.join(destDir, "test.txt"), "utf-8");
    expect(testContent).toBe("Hello from zip!");

    const nestedContent = await fs.readFile(path.join(destDir, "subdir", "nested.txt"), "utf-8");
    expect(nestedContent).toBe("Nested zip content");
  });

  it("throws ArchiveError for corrupt zip file", async () => {
    // Write garbage to the archive file
    await fs.writeFile(archivePath, "not a valid zip file");

    const extractor = new ZipExtractor();

    // Generic garbage file may trigger EXTRACTION_FAILED (file doesn't look like a zip at all)
    // or INVALID_ARCHIVE (for files that look like zips but are structurally corrupt)
    let caughtError: ArchiveError | undefined;
    try {
      await extractor.extract(archivePath, destDir);
    } catch (e) {
      caughtError = e as ArchiveError;
    }

    expect(caughtError).toBeInstanceOf(ArchiveError);
    expect(["INVALID_ARCHIVE", "EXTRACTION_FAILED"]).toContain(caughtError!.errorCode);
  });
});

describe("DefaultArchiveExtractor (boundary)", () => {
  let tempDir: string;
  let destDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "default-extractor-test-"));
    destDir = path.join(tempDir, "extracted");
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("extracts tar.gz based on extension", async () => {
    const sourceDir = path.join(tempDir, "source");
    const archivePath = path.join(tempDir, "archive.tar.gz");

    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "file.txt"), "tar.gz content");

    execSync(`tar --force-local -czf "${archivePath}" -C "${sourceDir}" .`);

    const extractor = new DefaultArchiveExtractor();
    await extractor.extract(archivePath, destDir);

    const content = await fs.readFile(path.join(destDir, "file.txt"), "utf-8");
    expect(content).toBe("tar.gz content");
  });

  it("extracts tgz based on extension", async () => {
    const sourceDir = path.join(tempDir, "source");
    const archivePath = path.join(tempDir, "archive.tgz");

    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "file.txt"), "tgz content");

    execSync(`tar --force-local -czf "${archivePath}" -C "${sourceDir}" .`);

    const extractor = new DefaultArchiveExtractor();
    await extractor.extract(archivePath, destDir);

    const content = await fs.readFile(path.join(destDir, "file.txt"), "utf-8");
    expect(content).toBe("tgz content");
  });

  it("extracts zip based on extension", async () => {
    const sourceDir = path.join(tempDir, "source");
    const archivePath = path.join(tempDir, "archive.zip");

    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "file.txt"), "zip content");

    try {
      execSync(`cd "${sourceDir}" && zip -r "${archivePath}" .`, { stdio: "pipe" });
    } catch {
      console.log("zip command not available, skipping zip boundary test");
      return;
    }

    const extractor = new DefaultArchiveExtractor();
    await extractor.extract(archivePath, destDir);

    const content = await fs.readFile(path.join(destDir, "file.txt"), "utf-8");
    expect(content).toBe("zip content");
  });

  it("throws for unsupported extensions", async () => {
    const archivePath = path.join(tempDir, "archive.7z");
    await fs.writeFile(archivePath, "fake 7z content");

    const extractor = new DefaultArchiveExtractor();

    await expect(extractor.extract(archivePath, destDir)).rejects.toThrow(ArchiveError);
    await expect(extractor.extract(archivePath, destDir)).rejects.toMatchObject({
      errorCode: "INVALID_ARCHIVE",
      message: expect.stringContaining("Unsupported archive format"),
    });
  });
});
