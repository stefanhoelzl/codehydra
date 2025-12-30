/**
 * Tests for extension directory name parsing utilities.
 */

import { describe, it, expect, vi } from "vitest";
import {
  parseExtensionDir,
  listInstalledExtensions,
  removeFromExtensionsJson,
} from "./extension-utils";
import { createMockFileSystemLayer, createDirEntry } from "../platform/filesystem.test-utils";

describe("parseExtensionDir", () => {
  describe("standard versions", () => {
    it("parses publisher.name-1.0.0", () => {
      const result = parseExtensionDir("codehydra.codehydra-0.0.1");

      expect(result).toEqual({
        id: "codehydra.codehydra",
        version: "0.0.1",
      });
    });

    it("parses sst-dev.opencode-1.2.3", () => {
      const result = parseExtensionDir("sst-dev.opencode-1.2.3");

      expect(result).toEqual({
        id: "sst-dev.opencode",
        version: "1.2.3",
      });
    });

    it("parses ms-vscode.theme-1.0.0", () => {
      const result = parseExtensionDir("ms-vscode.theme-1.0.0");

      expect(result).toEqual({
        id: "ms-vscode.theme",
        version: "1.0.0",
      });
    });
  });

  describe("prerelease versions", () => {
    it("parses version with beta suffix", () => {
      const result = parseExtensionDir("publisher.name-1.0.0-beta.1");

      expect(result).toEqual({
        id: "publisher.name",
        version: "1.0.0-beta.1",
      });
    });

    it("parses version with alpha suffix", () => {
      const result = parseExtensionDir("publisher.name-2.0.0-alpha");

      expect(result).toEqual({
        id: "publisher.name",
        version: "2.0.0-alpha",
      });
    });

    it("parses version with rc suffix", () => {
      const result = parseExtensionDir("publisher.name-3.0.0-rc.1");

      expect(result).toEqual({
        id: "publisher.name",
        version: "3.0.0-rc.1",
      });
    });
  });

  describe("build metadata", () => {
    it("parses version with build metadata", () => {
      const result = parseExtensionDir("publisher.name-1.0.0+build123");

      expect(result).toEqual({
        id: "publisher.name",
        version: "1.0.0+build123",
      });
    });
  });

  describe("invalid inputs", () => {
    it("returns null for hidden files (.DS_Store)", () => {
      const result = parseExtensionDir(".DS_Store");

      expect(result).toBeNull();
    });

    it("returns null for hidden directories (.git)", () => {
      const result = parseExtensionDir(".git");

      expect(result).toBeNull();
    });

    it("returns null for node_modules", () => {
      const result = parseExtensionDir("node_modules");

      expect(result).toBeNull();
    });

    it("returns null for name without version (no hyphen)", () => {
      const result = parseExtensionDir("publisher.name");

      expect(result).toBeNull();
    });

    it("returns null for name without dot in ID", () => {
      const result = parseExtensionDir("publishername-1.0.0");

      expect(result).toBeNull();
    });

    it("returns null for empty string", () => {
      const result = parseExtensionDir("");

      expect(result).toBeNull();
    });

    it("returns null for just version number", () => {
      const result = parseExtensionDir("1.0.0");

      expect(result).toBeNull();
    });
  });

  describe("edge cases", () => {
    it("handles publisher with hyphens", () => {
      const result = parseExtensionDir("ms-python.python-2024.1.0");

      expect(result).toEqual({
        id: "ms-python.python",
        version: "2024.1.0",
      });
    });

    it("handles uppercase letters in ID", () => {
      const result = parseExtensionDir("Publisher.ExtensionName-1.0.0");

      expect(result).toEqual({
        id: "Publisher.ExtensionName",
        version: "1.0.0",
      });
    });
  });
});

describe("listInstalledExtensions", () => {
  it("returns empty map for empty directory", async () => {
    const mockFs = createMockFileSystemLayer({
      readdir: { entries: [] },
    });

    const result = await listInstalledExtensions(mockFs, "/extensions");

    expect(result.size).toBe(0);
  });

  it("returns empty map for non-existent directory", async () => {
    const mockFs = createMockFileSystemLayer({
      readdir: {
        implementation: async () => {
          throw new Error("ENOENT");
        },
      },
    });

    const result = await listInstalledExtensions(mockFs, "/extensions");

    expect(result.size).toBe(0);
  });

  it("parses valid extension directories", async () => {
    const mockFs = createMockFileSystemLayer({
      readdir: {
        entries: [
          createDirEntry("codehydra.codehydra-0.0.1", { isDirectory: true }),
          createDirEntry("sst-dev.opencode-1.2.3", { isDirectory: true }),
        ],
      },
    });

    const result = await listInstalledExtensions(mockFs, "/extensions");

    expect(result.size).toBe(2);
    expect(result.get("codehydra.codehydra")).toBe("0.0.1");
    expect(result.get("sst-dev.opencode")).toBe("1.2.3");
  });

  it("ignores hidden files and directories", async () => {
    const mockFs = createMockFileSystemLayer({
      readdir: {
        entries: [
          createDirEntry(".DS_Store", { isFile: true }),
          createDirEntry(".git", { isDirectory: true }),
          createDirEntry("codehydra.codehydra-0.0.1", { isDirectory: true }),
        ],
      },
    });

    const result = await listInstalledExtensions(mockFs, "/extensions");

    expect(result.size).toBe(1);
    expect(result.get("codehydra.codehydra")).toBe("0.0.1");
  });

  it("ignores non-directory entries", async () => {
    const mockFs = createMockFileSystemLayer({
      readdir: {
        entries: [
          createDirEntry("codehydra.codehydra-0.0.1", { isFile: true }), // File, not directory
          createDirEntry("sst-dev.opencode-1.2.3", { isDirectory: true }),
        ],
      },
    });

    const result = await listInstalledExtensions(mockFs, "/extensions");

    expect(result.size).toBe(1);
    expect(result.get("sst-dev.opencode")).toBe("1.2.3");
  });

  it("ignores directories that don't match extension pattern", async () => {
    const mockFs = createMockFileSystemLayer({
      readdir: {
        entries: [
          createDirEntry("node_modules", { isDirectory: true }),
          createDirEntry("random-folder", { isDirectory: true }),
          createDirEntry("codehydra.codehydra-0.0.1", { isDirectory: true }),
        ],
      },
    });

    const result = await listInstalledExtensions(mockFs, "/extensions");

    expect(result.size).toBe(1);
    expect(result.get("codehydra.codehydra")).toBe("0.0.1");
  });
});

describe("removeFromExtensionsJson", () => {
  const sampleExtensionsJson = JSON.stringify([
    {
      identifier: { id: "codehydra.sidekick" },
      version: "0.0.3",
      relativeLocation: "codehydra.sidekick-0.0.3",
    },
    {
      identifier: { id: "sst-dev.opencode" },
      version: "0.0.13",
      relativeLocation: "sst-dev.opencode-0.0.13-universal",
      metadata: { updated: true },
    },
  ]);

  it("removes specified extension from extensions.json", async () => {
    let writtenContent = "";
    const mockFs = createMockFileSystemLayer({
      readFile: { content: sampleExtensionsJson },
      writeFile: {
        implementation: async (_path, content) => {
          writtenContent = content;
        },
      },
    });

    await removeFromExtensionsJson(mockFs, "/extensions", ["sst-dev.opencode"]);

    const result = JSON.parse(writtenContent);
    expect(result).toHaveLength(1);
    expect(result[0].identifier.id).toBe("codehydra.sidekick");
  });

  it("removes multiple extensions", async () => {
    let writtenContent = "";
    const mockFs = createMockFileSystemLayer({
      readFile: { content: sampleExtensionsJson },
      writeFile: {
        implementation: async (_path, content) => {
          writtenContent = content;
        },
      },
    });

    await removeFromExtensionsJson(mockFs, "/extensions", [
      "sst-dev.opencode",
      "codehydra.sidekick",
    ]);

    const result = JSON.parse(writtenContent);
    expect(result).toHaveLength(0);
  });

  it("does nothing when extensions.json does not exist", async () => {
    const writeFile = vi.fn();
    const mockFs = createMockFileSystemLayer({
      readFile: {
        implementation: async () => {
          throw new Error("ENOENT");
        },
      },
      writeFile: { implementation: writeFile },
    });

    await removeFromExtensionsJson(mockFs, "/extensions", ["sst-dev.opencode"]);

    expect(writeFile).not.toHaveBeenCalled();
  });

  it("does nothing when extension ID not found", async () => {
    const writeFile = vi.fn();
    const mockFs = createMockFileSystemLayer({
      readFile: { content: sampleExtensionsJson },
      writeFile: { implementation: writeFile },
    });

    await removeFromExtensionsJson(mockFs, "/extensions", ["nonexistent.extension"]);

    expect(writeFile).not.toHaveBeenCalled();
  });

  it("does nothing for empty extension IDs list", async () => {
    const writeFile = vi.fn();
    const mockFs = createMockFileSystemLayer({
      readFile: { content: sampleExtensionsJson },
      writeFile: { implementation: writeFile },
    });

    await removeFromExtensionsJson(mockFs, "/extensions", []);

    expect(writeFile).not.toHaveBeenCalled();
  });

  it("handles case-insensitive extension IDs", async () => {
    let writtenContent = "";
    const mockFs = createMockFileSystemLayer({
      readFile: { content: sampleExtensionsJson },
      writeFile: {
        implementation: async (_path, content) => {
          writtenContent = content;
        },
      },
    });

    await removeFromExtensionsJson(mockFs, "/extensions", ["SST-DEV.OPENCODE"]);

    const result = JSON.parse(writtenContent);
    expect(result).toHaveLength(1);
    expect(result[0].identifier.id).toBe("codehydra.sidekick");
  });

  it("handles invalid JSON gracefully", async () => {
    const writeFile = vi.fn();
    const mockFs = createMockFileSystemLayer({
      readFile: { content: "not valid json" },
      writeFile: { implementation: writeFile },
    });

    await removeFromExtensionsJson(mockFs, "/extensions", ["sst-dev.opencode"]);

    expect(writeFile).not.toHaveBeenCalled();
  });

  it("handles non-array JSON gracefully", async () => {
    const writeFile = vi.fn();
    const mockFs = createMockFileSystemLayer({
      readFile: { content: '{"not": "an array"}' },
      writeFile: { implementation: writeFile },
    });

    await removeFromExtensionsJson(mockFs, "/extensions", ["sst-dev.opencode"]);

    expect(writeFile).not.toHaveBeenCalled();
  });
});
