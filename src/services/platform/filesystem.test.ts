// @vitest-environment node
/**
 * Unit tests for FileSystemLayer copyTree method.
 *
 * These tests validate the copyTree contract. Most tests run against
 * real filesystem with temp directories since copyTree needs actual I/O.
 * For pure interface tests, see the CopyTreeResult shape tests.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import {
  writeFile as nodeWriteFile,
  mkdir as nodeMkdir,
  readFile as nodeReadFile,
  symlink,
} from "node:fs/promises";
import { DefaultFileSystemLayer, type CopyTreeResult } from "./filesystem";
import { createSilentLogger } from "../logging";
import { FileSystemError } from "../errors";
import { createTempDir } from "../test-utils";

describe("DefaultFileSystemLayer.copyTree", () => {
  let fs: DefaultFileSystemLayer;
  let tempDir: { path: string; cleanup: () => Promise<void> };

  beforeEach(async () => {
    fs = new DefaultFileSystemLayer(createSilentLogger());
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await tempDir.cleanup();
  });

  describe("single file copy", () => {
    it("copies single file preserving content", async () => {
      const srcPath = join(tempDir.path, "src.txt");
      const destPath = join(tempDir.path, "dest.txt");
      const content = "Hello, World!";
      await nodeWriteFile(srcPath, content, "utf-8");

      const result = await fs.copyTree(srcPath, destPath);

      expect(result.copiedCount).toBe(1);
      expect(result.skippedSymlinks).toHaveLength(0);

      const destContent = await nodeReadFile(destPath, "utf-8");
      expect(destContent).toBe(content);
    });
  });

  describe("directory copy", () => {
    it("copies directory recursively", async () => {
      const srcDir = join(tempDir.path, "src");
      const destDir = join(tempDir.path, "dest");
      await nodeMkdir(srcDir);
      await nodeWriteFile(join(srcDir, "file1.txt"), "content1", "utf-8");
      await nodeMkdir(join(srcDir, "subdir"));
      await nodeWriteFile(join(srcDir, "subdir", "file2.txt"), "content2", "utf-8");

      const result = await fs.copyTree(srcDir, destDir);

      expect(result.copiedCount).toBe(2); // Two files copied
      expect(result.skippedSymlinks).toHaveLength(0);

      // Verify structure
      const file1 = await nodeReadFile(join(destDir, "file1.txt"), "utf-8");
      const file2 = await nodeReadFile(join(destDir, "subdir", "file2.txt"), "utf-8");
      expect(file1).toBe("content1");
      expect(file2).toBe("content2");
    });
  });

  describe("parent directory creation", () => {
    it("creates destination parent directories if they do not exist", async () => {
      const srcPath = join(tempDir.path, "src.txt");
      const destPath = join(tempDir.path, "nested", "deep", "dest.txt");
      await nodeWriteFile(srcPath, "content", "utf-8");

      const result = await fs.copyTree(srcPath, destPath);

      expect(result.copiedCount).toBe(1);

      const destContent = await nodeReadFile(destPath, "utf-8");
      expect(destContent).toBe("content");
    });
  });

  describe("error handling", () => {
    it("throws ENOENT if source does not exist", async () => {
      const srcPath = join(tempDir.path, "non-existent.txt");
      const destPath = join(tempDir.path, "dest.txt");

      await expect(fs.copyTree(srcPath, destPath)).rejects.toThrow(FileSystemError);

      try {
        await fs.copyTree(srcPath, destPath);
      } catch (error) {
        expect(error).toBeInstanceOf(FileSystemError);
        expect((error as FileSystemError).fsCode).toBe("ENOENT");
      }
    });
  });

  describe("symlink handling", () => {
    it("returns skipped symlinks in CopyTreeResult", async () => {
      const srcDir = join(tempDir.path, "src");
      const destDir = join(tempDir.path, "dest");
      await nodeMkdir(srcDir);
      await nodeWriteFile(join(srcDir, "file.txt"), "content", "utf-8");
      await symlink(join(srcDir, "file.txt"), join(srcDir, "link.txt"));

      const result = await fs.copyTree(srcDir, destDir);

      expect(result.copiedCount).toBe(1); // Only the file
      expect(result.skippedSymlinks).toHaveLength(1);
      expect(result.skippedSymlinks[0]).toContain("link.txt");
    });
  });

  describe("overwrite behavior", () => {
    it("overwrites existing destination files", async () => {
      const srcPath = join(tempDir.path, "src.txt");
      const destPath = join(tempDir.path, "dest.txt");
      await nodeWriteFile(srcPath, "new content", "utf-8");
      await nodeWriteFile(destPath, "old content", "utf-8");

      const result = await fs.copyTree(srcPath, destPath);

      expect(result.copiedCount).toBe(1);

      const destContent = await nodeReadFile(destPath, "utf-8");
      expect(destContent).toBe("new content");
    });
  });

  describe("CopyTreeResult interface", () => {
    it("has correct shape", () => {
      // Compile-time interface check
      const result: CopyTreeResult = {
        copiedCount: 5,
        skippedSymlinks: ["/path/to/link1", "/path/to/link2"],
      };

      expect(result.copiedCount).toBe(5);
      expect(result.skippedSymlinks).toHaveLength(2);
    });
  });
});

describe("DefaultFileSystemLayer.makeExecutable", () => {
  let fs: DefaultFileSystemLayer;
  let tempDir: { path: string; cleanup: () => Promise<void> };

  beforeEach(async () => {
    fs = new DefaultFileSystemLayer();
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await tempDir.cleanup();
  });

  // Note: Platform-specific behavior (Windows no-op) is tested in boundary tests
  // since we can't easily mock process.platform in unit tests.

  it("sets file permissions to 0o755 on Unix", async () => {
    // Skip on Windows - permissions work differently
    if (process.platform === "win32") {
      return;
    }

    const filePath = join(tempDir.path, "script.sh");
    await nodeWriteFile(filePath, "#!/bin/sh\necho hello", "utf-8");

    await fs.makeExecutable(filePath);

    // Verify permissions
    const { stat } = await import("node:fs/promises");
    const stats = await stat(filePath);
    // Check that execute bits are set (owner, group, other)
    expect(stats.mode & 0o111).toBe(0o111);
  });

  it("throws ENOENT for non-existent file", async () => {
    // Skip on Windows - permissions work differently
    if (process.platform === "win32") {
      return;
    }

    const filePath = join(tempDir.path, "non-existent.sh");

    await expect(fs.makeExecutable(filePath)).rejects.toThrow(FileSystemError);

    try {
      await fs.makeExecutable(filePath);
    } catch (error) {
      expect(error).toBeInstanceOf(FileSystemError);
      expect((error as FileSystemError).fsCode).toBe("ENOENT");
    }
  });
});
