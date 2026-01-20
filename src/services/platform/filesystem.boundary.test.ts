// @vitest-environment node
/**
 * Boundary tests for DefaultFileSystemLayer.
 * Tests filesystem operations against real filesystem with temp directories.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { symlink, writeFile as nodeWriteFile, mkdir as nodeMkdir } from "node:fs/promises";
import { DefaultFileSystemLayer } from "./filesystem";
import { SILENT_LOGGER } from "../logging";
import { FileSystemError } from "../errors";
import { createTempDir } from "../test-utils";

describe("DefaultFileSystemLayer", () => {
  let fs: DefaultFileSystemLayer;
  let tempDir: { path: string; cleanup: () => Promise<void> };

  beforeEach(async () => {
    fs = new DefaultFileSystemLayer(SILENT_LOGGER);
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await tempDir.cleanup();
  });

  describe("readFile", () => {
    it("reads file content", async () => {
      const filePath = join(tempDir.path, "test.txt");
      await nodeWriteFile(filePath, "Hello, World!", "utf-8");

      const content = await fs.readFile(filePath);

      expect(content).toBe("Hello, World!");
    });

    it("reads UTF-8 content correctly", async () => {
      const filePath = join(tempDir.path, "unicode.txt");
      const unicodeContent = "Hello 世界 🌍";
      await nodeWriteFile(filePath, unicodeContent, "utf-8");

      const content = await fs.readFile(filePath);

      expect(content).toBe(unicodeContent);
    });

    it("throws ENOENT for non-existent file", async () => {
      const filePath = join(tempDir.path, "non-existent.txt");

      await expect(fs.readFile(filePath)).rejects.toThrow(FileSystemError);

      try {
        await fs.readFile(filePath);
      } catch (error) {
        expect(error).toBeInstanceOf(FileSystemError);
        expect((error as FileSystemError).fsCode).toBe("ENOENT");
        expect((error as FileSystemError).path).toBe(filePath);
      }
    });

    it("throws EISDIR when reading a directory", async () => {
      const dirPath = join(tempDir.path, "test-dir");
      await nodeMkdir(dirPath);

      await expect(fs.readFile(dirPath)).rejects.toThrow(FileSystemError);

      try {
        await fs.readFile(dirPath);
      } catch (error) {
        expect(error).toBeInstanceOf(FileSystemError);
        expect((error as FileSystemError).fsCode).toBe("EISDIR");
        expect((error as FileSystemError).path).toBe(dirPath);
      }
    });
  });

  describe("writeFile", () => {
    it("writes file content", async () => {
      const filePath = join(tempDir.path, "test.txt");

      await fs.writeFile(filePath, "Hello, World!");

      const content = await fs.readFile(filePath);
      expect(content).toBe("Hello, World!");
    });

    it("overwrites existing file", async () => {
      const filePath = join(tempDir.path, "test.txt");
      await nodeWriteFile(filePath, "Original content", "utf-8");

      await fs.writeFile(filePath, "New content");

      const content = await fs.readFile(filePath);
      expect(content).toBe("New content");
    });

    it("writes UTF-8 content correctly", async () => {
      const filePath = join(tempDir.path, "unicode.txt");
      const unicodeContent = "Hello 世界 🌍";

      await fs.writeFile(filePath, unicodeContent);

      const content = await fs.readFile(filePath);
      expect(content).toBe(unicodeContent);
    });

    it("throws ENOENT when parent directory does not exist", async () => {
      const filePath = join(tempDir.path, "non-existent-dir", "test.txt");

      await expect(fs.writeFile(filePath, "content")).rejects.toThrow(FileSystemError);

      try {
        await fs.writeFile(filePath, "content");
      } catch (error) {
        expect(error).toBeInstanceOf(FileSystemError);
        expect((error as FileSystemError).fsCode).toBe("ENOENT");
        expect((error as FileSystemError).path).toBe(filePath);
      }
    });

    it("throws EISDIR when path is a directory", async () => {
      const dirPath = join(tempDir.path, "test-dir");
      await nodeMkdir(dirPath);

      await expect(fs.writeFile(dirPath, "content")).rejects.toThrow(FileSystemError);

      try {
        await fs.writeFile(dirPath, "content");
      } catch (error) {
        expect(error).toBeInstanceOf(FileSystemError);
        expect((error as FileSystemError).fsCode).toBe("EISDIR");
        expect((error as FileSystemError).path).toBe(dirPath);
      }
    });
  });

  describe("mkdir", () => {
    it("creates directory", async () => {
      const dirPath = join(tempDir.path, "new-dir");

      await fs.mkdir(dirPath);

      const entries = await fs.readdir(tempDir.path);
      expect(entries.map((e) => e.name)).toContain("new-dir");
    });

    it("creates nested directories by default", async () => {
      const dirPath = join(tempDir.path, "a", "b", "c");

      await fs.mkdir(dirPath);

      const entries = await fs.readdir(join(tempDir.path, "a", "b"));
      expect(entries.map((e) => e.name)).toContain("c");
    });

    it("is no-op when directory already exists", async () => {
      const dirPath = join(tempDir.path, "existing-dir");
      await nodeMkdir(dirPath);

      // Should not throw
      await expect(fs.mkdir(dirPath)).resolves.toBeUndefined();
    });

    it("throws EEXIST when file exists at path", async () => {
      const filePath = join(tempDir.path, "file-not-dir");
      await nodeWriteFile(filePath, "content", "utf-8");

      await expect(fs.mkdir(filePath)).rejects.toThrow(FileSystemError);

      try {
        await fs.mkdir(filePath);
      } catch (error) {
        expect(error).toBeInstanceOf(FileSystemError);
        expect((error as FileSystemError).fsCode).toBe("EEXIST");
        expect((error as FileSystemError).path).toBe(filePath);
      }
    });

    it("throws ENOENT when recursive is false and parent does not exist", async () => {
      const dirPath = join(tempDir.path, "non-existent", "new-dir");

      await expect(fs.mkdir(dirPath, { recursive: false })).rejects.toThrow(FileSystemError);

      try {
        await fs.mkdir(dirPath, { recursive: false });
      } catch (error) {
        expect(error).toBeInstanceOf(FileSystemError);
        expect((error as FileSystemError).fsCode).toBe("ENOENT");
        expect((error as FileSystemError).path).toBe(dirPath);
      }
    });
  });

  describe("readdir", () => {
    it("lists directory contents", async () => {
      const filePath = join(tempDir.path, "file.txt");
      const dirPath = join(tempDir.path, "subdir");
      await nodeWriteFile(filePath, "content", "utf-8");
      await nodeMkdir(dirPath);

      const entries = await fs.readdir(tempDir.path);

      const names = entries.map((e) => e.name);
      expect(names).toContain("file.txt");
      expect(names).toContain("subdir");
    });

    it("returns correct type information for files", async () => {
      const filePath = join(tempDir.path, "file.txt");
      await nodeWriteFile(filePath, "content", "utf-8");

      const entries = await fs.readdir(tempDir.path);
      const fileEntry = entries.find((e) => e.name === "file.txt");

      expect(fileEntry).toBeDefined();
      expect(fileEntry?.isFile).toBe(true);
      expect(fileEntry?.isDirectory).toBe(false);
      expect(fileEntry?.isSymbolicLink).toBe(false);
    });

    it("returns correct type information for directories", async () => {
      const dirPath = join(tempDir.path, "subdir");
      await nodeMkdir(dirPath);

      const entries = await fs.readdir(tempDir.path);
      const dirEntry = entries.find((e) => e.name === "subdir");

      expect(dirEntry).toBeDefined();
      expect(dirEntry?.isFile).toBe(false);
      expect(dirEntry?.isDirectory).toBe(true);
      expect(dirEntry?.isSymbolicLink).toBe(false);
    });

    it.skipIf(process.platform === "win32")(
      "returns correct type information for symlinks",
      async () => {
        const filePath = join(tempDir.path, "file.txt");
        const symlinkPath = join(tempDir.path, "link");
        await nodeWriteFile(filePath, "content", "utf-8");
        await symlink(filePath, symlinkPath);

        const entries = await fs.readdir(tempDir.path);
        const linkEntry = entries.find((e) => e.name === "link");

        expect(linkEntry).toBeDefined();
        expect(linkEntry?.isSymbolicLink).toBe(true);
      }
    );

    it("returns empty array for empty directory", async () => {
      const dirPath = join(tempDir.path, "empty");
      await nodeMkdir(dirPath);

      const entries = await fs.readdir(dirPath);

      expect(entries).toEqual([]);
    });

    it("throws ENOENT for non-existent directory", async () => {
      const dirPath = join(tempDir.path, "non-existent");

      await expect(fs.readdir(dirPath)).rejects.toThrow(FileSystemError);

      try {
        await fs.readdir(dirPath);
      } catch (error) {
        expect(error).toBeInstanceOf(FileSystemError);
        expect((error as FileSystemError).fsCode).toBe("ENOENT");
        expect((error as FileSystemError).path).toBe(dirPath);
      }
    });

    it("throws ENOTDIR when path is a file", async () => {
      const filePath = join(tempDir.path, "file.txt");
      await nodeWriteFile(filePath, "content", "utf-8");

      await expect(fs.readdir(filePath)).rejects.toThrow(FileSystemError);

      try {
        await fs.readdir(filePath);
      } catch (error) {
        expect(error).toBeInstanceOf(FileSystemError);
        expect((error as FileSystemError).fsCode).toBe("ENOTDIR");
        expect((error as FileSystemError).path).toBe(filePath);
      }
    });
  });

  describe("unlink", () => {
    it("deletes file", async () => {
      const filePath = join(tempDir.path, "file.txt");
      await nodeWriteFile(filePath, "content", "utf-8");

      await fs.unlink(filePath);

      await expect(fs.readFile(filePath)).rejects.toThrow();
    });

    it("throws ENOENT for non-existent file", async () => {
      const filePath = join(tempDir.path, "non-existent.txt");

      await expect(fs.unlink(filePath)).rejects.toThrow(FileSystemError);

      try {
        await fs.unlink(filePath);
      } catch (error) {
        expect(error).toBeInstanceOf(FileSystemError);
        expect((error as FileSystemError).fsCode).toBe("ENOENT");
        expect((error as FileSystemError).path).toBe(filePath);
      }
    });

    it.skipIf(process.platform === "win32")("throws EISDIR when path is a directory", async () => {
      const dirPath = join(tempDir.path, "subdir");
      await nodeMkdir(dirPath);

      await expect(fs.unlink(dirPath)).rejects.toThrow(FileSystemError);

      try {
        await fs.unlink(dirPath);
      } catch (error) {
        expect(error).toBeInstanceOf(FileSystemError);
        expect((error as FileSystemError).fsCode).toBe("EISDIR");
        expect((error as FileSystemError).path).toBe(dirPath);
      }
    });
  });

  describe("rm", () => {
    it("deletes file", async () => {
      const filePath = join(tempDir.path, "file.txt");
      await nodeWriteFile(filePath, "content", "utf-8");

      await fs.rm(filePath);

      await expect(fs.readFile(filePath)).rejects.toThrow();
    });

    it("removes empty directory without recursive flag", async () => {
      const dirPath = join(tempDir.path, "empty-dir");
      await nodeMkdir(dirPath);

      await fs.rm(dirPath);

      await expect(fs.readdir(dirPath)).rejects.toThrow();
    });

    it("throws ENOTEMPTY for non-empty directory without recursive flag", async () => {
      const dirPath = join(tempDir.path, "non-empty-dir");
      await nodeMkdir(dirPath);
      await nodeWriteFile(join(dirPath, "file.txt"), "content", "utf-8");

      await expect(fs.rm(dirPath)).rejects.toThrow(FileSystemError);

      try {
        await fs.rm(dirPath);
      } catch (error) {
        expect(error).toBeInstanceOf(FileSystemError);
        expect((error as FileSystemError).fsCode).toBe("ENOTEMPTY");
        expect((error as FileSystemError).path).toBe(dirPath);
      }
    });

    it("deletes empty directory with recursive option", async () => {
      const dirPath = join(tempDir.path, "empty-dir");
      await nodeMkdir(dirPath);

      await fs.rm(dirPath, { recursive: true });

      await expect(fs.readdir(dirPath)).rejects.toThrow();
    });

    it("deletes directory tree with recursive option", async () => {
      const dirPath = join(tempDir.path, "parent");
      const subDirPath = join(dirPath, "child");
      const filePath = join(subDirPath, "file.txt");
      await nodeMkdir(subDirPath, { recursive: true });
      await nodeWriteFile(filePath, "content", "utf-8");

      await fs.rm(dirPath, { recursive: true });

      await expect(fs.readdir(dirPath)).rejects.toThrow();
    });

    it("throws ENOENT for non-existent path", async () => {
      const path = join(tempDir.path, "non-existent");

      await expect(fs.rm(path)).rejects.toThrow(FileSystemError);

      try {
        await fs.rm(path);
      } catch (error) {
        expect(error).toBeInstanceOf(FileSystemError);
        expect((error as FileSystemError).fsCode).toBe("ENOENT");
        expect((error as FileSystemError).path).toBe(path);
      }
    });

    it("does not throw with force option for non-existent path", async () => {
      const path = join(tempDir.path, "non-existent");

      await expect(fs.rm(path, { force: true })).resolves.toBeUndefined();
    });

    it("force option ignores ENOENT but still removes existing", async () => {
      const filePath = join(tempDir.path, "file.txt");
      await nodeWriteFile(filePath, "content", "utf-8");

      await fs.rm(filePath, { force: true });

      await expect(fs.readFile(filePath)).rejects.toThrow();
    });

    it("recursive and force together", async () => {
      const dirPath = join(tempDir.path, "parent");
      const filePath = join(dirPath, "file.txt");
      await nodeMkdir(dirPath);
      await nodeWriteFile(filePath, "content", "utf-8");

      await fs.rm(dirPath, { recursive: true, force: true });

      await expect(fs.readdir(dirPath)).rejects.toThrow();
    });
  });

  describe("copyTree", () => {
    it("copies text file with content verification", async () => {
      const srcPath = join(tempDir.path, "src.txt");
      const destPath = join(tempDir.path, "dest.txt");
      const content = "Hello, World! Line 1\nLine 2\nLine 3 with UTF-8: 日本語";
      await nodeWriteFile(srcPath, content, "utf-8");

      await fs.copyTree(srcPath, destPath);

      const destContent = await fs.readFile(destPath);
      expect(destContent).toBe(content);
    });

    it("copies binary file with null bytes byte-for-byte", async () => {
      const srcPath = join(tempDir.path, "binary.bin");
      const destPath = join(tempDir.path, "binary-copy.bin");
      // Create binary content with null bytes
      const binaryContent = Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00, 0xfe, 0x00, 0x00, 0x89]);
      await nodeWriteFile(srcPath, binaryContent);

      await fs.copyTree(srcPath, destPath);

      // Verify byte-for-byte
      const { readFile: nodeReadFile } = await import("node:fs/promises");
      const destBuffer = await nodeReadFile(destPath);
      expect(Buffer.compare(destBuffer, binaryContent)).toBe(0);
    });

    it("copies small PNG binary file correctly", async () => {
      const srcPath = join(tempDir.path, "image.png");
      const destPath = join(tempDir.path, "image-copy.png");
      // Minimal valid PNG (1x1 transparent pixel)
      const pngHeader = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
        0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00,
        0x02, 0x00, 0x00, 0x05, 0x00, 0x01, 0xe9, 0xfa, 0xdc, 0xd8, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
      ]);
      await nodeWriteFile(srcPath, pngHeader);

      await fs.copyTree(srcPath, destPath);

      const { readFile: nodeReadFile } = await import("node:fs/promises");
      const destBuffer = await nodeReadFile(destPath);
      expect(Buffer.compare(destBuffer, pngHeader)).toBe(0);
    });

    it("copies nested directory structure (3+ levels deep)", async () => {
      const srcDir = join(tempDir.path, "src");
      const destDir = join(tempDir.path, "dest");

      // Create 4-level deep structure
      await nodeMkdir(join(srcDir, "level1", "level2", "level3"), { recursive: true });
      await nodeWriteFile(join(srcDir, "root.txt"), "root", "utf-8");
      await nodeWriteFile(join(srcDir, "level1", "l1.txt"), "level1", "utf-8");
      await nodeWriteFile(join(srcDir, "level1", "level2", "l2.txt"), "level2", "utf-8");
      await nodeWriteFile(join(srcDir, "level1", "level2", "level3", "l3.txt"), "level3", "utf-8");

      await fs.copyTree(srcDir, destDir);

      // Verify all files copied
      expect(await fs.readFile(join(destDir, "root.txt"))).toBe("root");
      expect(await fs.readFile(join(destDir, "level1", "l1.txt"))).toBe("level1");
      expect(await fs.readFile(join(destDir, "level1", "level2", "l2.txt"))).toBe("level2");
      expect(await fs.readFile(join(destDir, "level1", "level2", "level3", "l3.txt"))).toBe(
        "level3"
      );
    });

    it.skipIf(process.platform === "win32")(
      "preserves file permissions (basic chmod check)",
      async () => {
        const srcPath = join(tempDir.path, "executable.sh");
        const destPath = join(tempDir.path, "executable-copy.sh");
        await nodeWriteFile(srcPath, "#!/bin/bash\necho hello", "utf-8");

        // Make file executable
        const { chmod, stat } = await import("node:fs/promises");
        await chmod(srcPath, 0o755);

        await fs.copyTree(srcPath, destPath);

        const destStat = await stat(destPath);
        // Check executable bit is preserved (at least for owner)
        const ownerExecuteBit = 0o100;
        expect(destStat.mode & ownerExecuteBit).toBe(ownerExecuteBit);
      }
    );

    it.skipIf(process.platform === "win32")(
      "copies symlinks as symlinks (native fs.cp behavior)",
      async () => {
        const srcDir = join(tempDir.path, "src");
        const destDir = join(tempDir.path, "dest");
        await nodeMkdir(srcDir);

        // Create a regular file and a symlink to it
        const filePath = join(srcDir, "file.txt");
        const linkPath = join(srcDir, "link.txt");
        await nodeWriteFile(filePath, "content", "utf-8");
        await symlink(filePath, linkPath);

        await fs.copyTree(srcDir, destDir);

        // Verify file was copied
        expect(await fs.readFile(join(destDir, "file.txt"))).toBe("content");

        // Verify symlink exists at destination (as a symlink)
        const { lstat } = await import("node:fs/promises");
        const destLinkStat = await lstat(join(destDir, "link.txt"));
        expect(destLinkStat.isSymbolicLink()).toBe(true);
      }
    );

    it("throws ENOENT when source does not exist", async () => {
      const srcPath = join(tempDir.path, "non-existent");
      const destPath = join(tempDir.path, "dest");

      await expect(fs.copyTree(srcPath, destPath)).rejects.toThrow(FileSystemError);

      try {
        await fs.copyTree(srcPath, destPath);
      } catch (error) {
        expect(error).toBeInstanceOf(FileSystemError);
        expect((error as FileSystemError).fsCode).toBe("ENOENT");
      }
    });

    it("overwrites existing destination files", async () => {
      const srcPath = join(tempDir.path, "src.txt");
      const destPath = join(tempDir.path, "dest.txt");
      await nodeWriteFile(srcPath, "new content", "utf-8");
      await nodeWriteFile(destPath, "old content", "utf-8");

      await fs.copyTree(srcPath, destPath);

      expect(await fs.readFile(destPath)).toBe("new content");
    });

    it("creates parent directories for destination", async () => {
      const srcPath = join(tempDir.path, "src.txt");
      const destPath = join(tempDir.path, "new", "nested", "deep", "dest.txt");
      await nodeWriteFile(srcPath, "content", "utf-8");

      await fs.copyTree(srcPath, destPath);

      expect(await fs.readFile(destPath)).toBe("content");
    });

    it.skipIf(process.platform === "win32")(
      "copies symlink at root level as symlink (native fs.cp behavior)",
      async () => {
        const targetPath = join(tempDir.path, "target.txt");
        const linkPath = join(tempDir.path, "link");
        const destPath = join(tempDir.path, "dest");
        await nodeWriteFile(targetPath, "content", "utf-8");
        await symlink(targetPath, linkPath);

        await fs.copyTree(linkPath, destPath);

        // Verify symlink was copied as symlink
        const { lstat } = await import("node:fs/promises");
        const destStat = await lstat(destPath);
        expect(destStat.isSymbolicLink()).toBe(true);
      }
    );
  });

  describe("makeExecutable", () => {
    it("sets file permissions to 0o755 on Unix", async () => {
      // Skip on Windows - permissions work differently
      if (process.platform === "win32") {
        return;
      }

      const filePath = join(tempDir.path, "script.sh");
      await nodeWriteFile(filePath, "#!/bin/sh\necho hello", "utf-8");

      await fs.makeExecutable(filePath);

      // Verify permissions include execute bits for all (owner, group, other)
      const { stat } = await import("node:fs/promises");
      const stats = await stat(filePath);
      expect(stats.mode & 0o755).toBe(0o755);
    });

    it("is no-op on Windows (does not throw)", async () => {
      // This test verifies the function doesn't fail on Windows
      // On Unix, it will actually set permissions
      const filePath = join(tempDir.path, "script.sh");
      await nodeWriteFile(filePath, "#!/bin/sh\necho hello", "utf-8");

      // Should not throw regardless of platform
      await expect(fs.makeExecutable(filePath)).resolves.toBeUndefined();
    });

    it("throws ENOENT for non-existent file", async () => {
      // Skip on Windows - makeExecutable is a no-op
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

  describe("mkdtemp", () => {
    it("creates unique temporary directory with prefix", async () => {
      const result = await fs.mkdtemp("initial-prompt-");

      // Verify directory was created
      const entries = await fs.readdir(result);
      expect(entries).toEqual([]);

      // Verify path contains prefix
      expect(result.toString()).toContain("initial-prompt-");

      // Cleanup
      await fs.rm(result, { recursive: true, force: true });
    });

    it("creates directories with unique paths", async () => {
      const result1 = await fs.mkdtemp("test-");
      const result2 = await fs.mkdtemp("test-");

      // Verify paths are different
      expect(result1.toString()).not.toBe(result2.toString());

      // Cleanup
      await fs.rm(result1, { recursive: true, force: true });
      await fs.rm(result2, { recursive: true, force: true });
    });
  });
});
