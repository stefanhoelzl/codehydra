/**
 * Boundary tests for ArchiveExtractor implementations.
 * Tests extraction with real archive files.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as fss from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomBytes } from "node:crypto";
import * as tar from "tar";
import yazl from "yazl";
import { TarExtractor, ZipExtractor, DefaultArchiveExtractor } from "./archive-extractor";
import { ArchiveError } from "../../shared/errors/service-errors";
import { Path } from "../../utils/path/path";

/**
 * Creates a zip archive from a source directory using yazl.
 * Recursively adds all files and directories.
 */
async function createTestZip(sourceDir: string, archivePath: string): Promise<void> {
  const zipfile = new yazl.ZipFile();

  async function addDirectory(dirPath: string, zipPath: string): Promise<void> {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      const entryZipPath = zipPath ? `${zipPath}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        await addDirectory(fullPath, entryZipPath);
      } else {
        zipfile.addFile(fullPath, entryZipPath);
      }
    }
  }

  await addDirectory(sourceDir, "");
  zipfile.end();

  await new Promise<void>((resolve, reject) => {
    const writeStream = fss.createWriteStream(archivePath);
    zipfile.outputStream.pipe(writeStream);
    writeStream.on("close", resolve);
    writeStream.on("error", reject);
  });
}

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

    // Create archive using tar package (cross-platform, no shell dependency)
    await tar.create({ gzip: true, file: archivePath, cwd: sourceDir }, ["."]);

    // Extract using TarExtractor
    const extractor = new TarExtractor();
    await extractor.extract(archivePath, new Path(destDir));

    // Verify contents
    const testContent = await fs.readFile(path.join(destDir, "test.txt"), "utf-8");
    expect(testContent).toBe("Hello, World!");

    const nestedContent = await fs.readFile(path.join(destDir, "subdir", "nested.txt"), "utf-8");
    expect(nestedContent).toBe("Nested content");
  });

  it("reports extraction progress ending at 100% of the archive size", async () => {
    const sourceDir = path.join(tempDir, "source");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "test.txt"), "Hello, World!");
    await tar.create({ gzip: true, file: archivePath, cwd: sourceDir }, ["."]);

    const archiveSize = (await fs.stat(archivePath)).size;
    const updates: { processed: number; total: number }[] = [];

    const extractor = new TarExtractor();
    await extractor.extract(archivePath, new Path(destDir), (processed, total) => {
      updates.push({ processed, total });
    });

    expect(updates.length).toBeGreaterThan(0);
    // Total is the archive's compressed byte size, monotonic and terminating at 100%.
    expect(updates.every((u) => u.total === archiveSize)).toBe(true);
    expect(updates[updates.length - 1]?.processed).toBe(archiveSize);
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

    // Create archive using tar package (cross-platform, no shell dependency)
    await tar.create({ gzip: true, file: archivePath, cwd: sourceDir }, ["."]);

    // Extract
    const extractor = new TarExtractor();
    await extractor.extract(archivePath, new Path(destDir));

    // Check permissions
    const stats = await fs.stat(path.join(destDir, "script.sh"));
    // At least executable bit should be set
    expect(stats.mode & 0o111).not.toBe(0);
  });

  it("throws INVALID_ARCHIVE for corrupt archive", async () => {
    // Write garbage to the archive file
    await fs.writeFile(archivePath, "not a valid tar.gz file");

    const extractor = new TarExtractor();

    await expect(extractor.extract(archivePath, new Path(destDir))).rejects.toThrow(ArchiveError);
    await expect(extractor.extract(archivePath, new Path(destDir))).rejects.toMatchObject({
      errorCode: "INVALID_ARCHIVE",
    });
  });

  it("throws INVALID_ARCHIVE for corrupt gzip payload", async () => {
    // Valid gzip header followed by garbage deflate data triggers a zlib error
    const corruptGzip = Buffer.from([
      0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0xff, 0xff, 0xff, 0xff, 0xff,
    ]);
    await fs.writeFile(archivePath, corruptGzip);

    const extractor = new TarExtractor();

    await expect(extractor.extract(archivePath, new Path(destDir))).rejects.toThrow(ArchiveError);
    await expect(extractor.extract(archivePath, new Path(destDir))).rejects.toMatchObject({
      errorCode: "INVALID_ARCHIVE",
    });
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "throws PERMISSION_DENIED for unwritable destination",
    async () => {
      // Create a valid tar.gz archive
      const sourceDir = path.join(tempDir, "source");
      await fs.mkdir(sourceDir, { recursive: true });
      await fs.writeFile(path.join(sourceDir, "file.txt"), "content");
      await tar.create({ gzip: true, file: archivePath, cwd: sourceDir }, ["."]);

      // Create a read-only parent so mkdir for the dest fails with EACCES
      const lockedParent = path.join(tempDir, "locked");
      await fs.mkdir(lockedParent);
      await fs.chmod(lockedParent, 0o555);
      const lockedDest = path.join(lockedParent, "extracted");

      const extractor = new TarExtractor();
      try {
        await expect(extractor.extract(archivePath, new Path(lockedDest))).rejects.toThrow(
          ArchiveError
        );
        await expect(extractor.extract(archivePath, new Path(lockedDest))).rejects.toMatchObject({
          errorCode: "PERMISSION_DENIED",
        });
      } finally {
        await fs.chmod(lockedParent, 0o755);
      }
    }
  );

  it("throws EXTRACTION_FAILED for nonexistent archive path", async () => {
    const extractor = new TarExtractor();
    const missingPath = path.join(tempDir, "nonexistent.tar.gz");

    await expect(extractor.extract(missingPath, new Path(destDir))).rejects.toThrow(ArchiveError);
    await expect(extractor.extract(missingPath, new Path(destDir))).rejects.toMatchObject({
      errorCode: "EXTRACTION_FAILED",
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
    // Create a simple zip archive using yazl
    const sourceDir = path.join(tempDir, "source");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "test.txt"), "Hello from zip!");
    await fs.mkdir(path.join(sourceDir, "subdir"));
    await fs.writeFile(path.join(sourceDir, "subdir", "nested.txt"), "Nested zip content");

    await createTestZip(sourceDir, archivePath);

    // Extract using ZipExtractor
    const extractor = new ZipExtractor();
    await extractor.extract(archivePath, new Path(destDir));

    // Verify contents
    const testContent = await fs.readFile(path.join(destDir, "test.txt"), "utf-8");
    expect(testContent).toBe("Hello from zip!");

    const nestedContent = await fs.readFile(path.join(destDir, "subdir", "nested.txt"), "utf-8");
    expect(nestedContent).toBe("Nested zip content");
  });

  it("reports extraction progress by entry count", async () => {
    const sourceDir = path.join(tempDir, "source");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "a.txt"), "one");
    await fs.writeFile(path.join(sourceDir, "b.txt"), "two");
    await fs.writeFile(path.join(sourceDir, "c.txt"), "three");
    await createTestZip(sourceDir, archivePath);

    const updates: { processed: number; total: number }[] = [];
    const extractor = new ZipExtractor();
    await extractor.extract(archivePath, new Path(destDir), (processed, total) => {
      updates.push({ processed, total });
    });

    // One update per entry (3 files), each reporting the same total, ending at total.
    expect(updates.length).toBe(3);
    expect(updates.every((u) => u.total === 3)).toBe(true);
    expect(updates.map((u) => u.processed)).toEqual([1, 2, 3]);
  });

  it("throws ArchiveError for corrupt zip file", async () => {
    // Write garbage to the archive file
    await fs.writeFile(archivePath, "not a valid zip file");

    const extractor = new ZipExtractor();

    // Generic garbage file may trigger EXTRACTION_FAILED (file doesn't look like a zip at all)
    // or INVALID_ARCHIVE (for files that look like zips but are structurally corrupt)
    let caughtError: ArchiveError | undefined;
    try {
      await extractor.extract(archivePath, new Path(destDir));
    } catch (e) {
      caughtError = e as ArchiveError;
    }

    expect(caughtError).toBeInstanceOf(ArchiveError);
    expect(["INVALID_ARCHIVE", "EXTRACTION_FAILED"]).toContain(caughtError!.errorCode);
  });

  it("throws EXTRACTION_FAILED for nonexistent archive path", async () => {
    const extractor = new ZipExtractor();
    const missingPath = path.join(tempDir, "nonexistent.zip");

    await expect(extractor.extract(missingPath, new Path(destDir))).rejects.toThrow(ArchiveError);
    await expect(extractor.extract(missingPath, new Path(destDir))).rejects.toMatchObject({
      errorCode: "EXTRACTION_FAILED",
    });
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

    await tar.create({ gzip: true, file: archivePath, cwd: sourceDir }, ["."]);

    const extractor = new DefaultArchiveExtractor();
    await extractor.extract(archivePath, new Path(destDir));

    const content = await fs.readFile(path.join(destDir, "file.txt"), "utf-8");
    expect(content).toBe("tar.gz content");
  });

  it("extracts tgz based on extension", async () => {
    const sourceDir = path.join(tempDir, "source");
    const archivePath = path.join(tempDir, "archive.tgz");

    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "file.txt"), "tgz content");

    await tar.create({ gzip: true, file: archivePath, cwd: sourceDir }, ["."]);

    const extractor = new DefaultArchiveExtractor();
    await extractor.extract(archivePath, new Path(destDir));

    const content = await fs.readFile(path.join(destDir, "file.txt"), "utf-8");
    expect(content).toBe("tgz content");
  });

  it("extracts zip based on extension", async () => {
    const sourceDir = path.join(tempDir, "source");
    const archivePath = path.join(tempDir, "archive.zip");

    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "file.txt"), "zip content");

    await createTestZip(sourceDir, archivePath);

    const extractor = new DefaultArchiveExtractor();
    await extractor.extract(archivePath, new Path(destDir));

    const content = await fs.readFile(path.join(destDir, "file.txt"), "utf-8");
    expect(content).toBe("zip content");
  });

  it("throws for unsupported extensions", async () => {
    const archivePath = path.join(tempDir, "archive.7z");
    await fs.writeFile(archivePath, "fake 7z content");

    const extractor = new DefaultArchiveExtractor();

    await expect(extractor.extract(archivePath, new Path(destDir))).rejects.toThrow(ArchiveError);
    await expect(extractor.extract(archivePath, new Path(destDir))).rejects.toMatchObject({
      errorCode: "INVALID_ARCHIVE",
      message: expect.stringContaining("Unsupported archive format"),
    });
  });
});

describe("ZipExtractor compression methods", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "zip-method-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  /**
   * Deflated entries are inflated by us, not streamed through zlib by yauzl: inside an
   * Electron main process, yauzl's reader piped into zlib stalls near the end of a large
   * entry and never completes, which froze first-run setup on Windows and macOS. Both
   * stored and deflated entries must still round-trip byte for byte.
   *
   * This test cannot reproduce that: the deadlock only exists inside Electron, and vitest
   * runs in Node. It guards the round-trip, not the bug.
   */
  it("extracts stored and deflated entries alike", async () => {
    const sourceDir = path.join(tempDir, "source");
    await fs.mkdir(sourceDir, { recursive: true });

    // Incompressible: yazl stores it. Highly repetitive: yazl deflates it.
    const stored = randomBytes(8192);
    const deflated = Buffer.from("codehydra".repeat(5000));
    await fs.writeFile(path.join(sourceDir, "stored.bin"), stored);
    await fs.writeFile(path.join(sourceDir, "deflated.txt"), deflated);

    const archivePath = path.join(tempDir, "mixed.zip");
    await createTestZip(sourceDir, archivePath);

    const destDir = path.join(tempDir, "extracted");
    await new ZipExtractor().extract(archivePath, new Path(destDir));

    const gotStored = await fs.readFile(path.join(destDir, "stored.bin"));
    const gotDeflated = await fs.readFile(path.join(destDir, "deflated.txt"));
    expect(gotStored.equals(stored)).toBe(true);
    expect(gotDeflated.equals(deflated)).toBe(true);
  });
});
