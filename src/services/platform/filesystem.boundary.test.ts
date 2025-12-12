// @vitest-environment node
/**
 * Boundary tests for DefaultFileSystemLayer.
 * Tests filesystem operations against real filesystem with temp directories.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { symlink, writeFile as nodeWriteFile, mkdir as nodeMkdir } from "node:fs/promises";
import { DefaultFileSystemLayer } from "./filesystem";
import { FileSystemError } from "../errors";
import { createTempDir } from "../test-utils";

describe("DefaultFileSystemLayer", () => {
  let fs: DefaultFileSystemLayer;
  let tempDir: { path: string; cleanup: () => Promise<void> };

  beforeEach(async () => {
    fs = new DefaultFileSystemLayer();
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

    it("returns correct type information for symlinks", async () => {
      const filePath = join(tempDir.path, "file.txt");
      const symlinkPath = join(tempDir.path, "link");
      await nodeWriteFile(filePath, "content", "utf-8");
      await symlink(filePath, symlinkPath);

      const entries = await fs.readdir(tempDir.path);
      const linkEntry = entries.find((e) => e.name === "link");

      expect(linkEntry).toBeDefined();
      expect(linkEntry?.isSymbolicLink).toBe(true);
    });

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

    it("throws EISDIR when path is a directory", async () => {
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

    it("throws EISDIR for directory without recursive option", async () => {
      // Node.js rm() requires recursive: true for any directory
      const dirPath = join(tempDir.path, "empty-dir");
      await nodeMkdir(dirPath);

      await expect(fs.rm(dirPath)).rejects.toThrow(FileSystemError);

      try {
        await fs.rm(dirPath);
      } catch (error) {
        expect(error).toBeInstanceOf(FileSystemError);
        expect((error as FileSystemError).fsCode).toBe("EISDIR");
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
});
