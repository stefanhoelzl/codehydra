/**
 * Tests for extension utilities.
 *
 * Pure function tests for parseExtensionDir.
 * Boundary tests for listInstalledExtensions and removeFromExtensionsJson
 * against a real filesystem.
 */

import { join } from "node:path";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  parseExtensionDir,
  listInstalledExtensions,
  removeFromExtensionsJson,
} from "./extension-utils";
import { DefaultFileSystemLayer } from "../platform/filesystem";
import { createMockLogger } from "../logging/logging.test-utils";

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

describe("extension-utils boundary", () => {
  let testDir: string;
  let fs: DefaultFileSystemLayer;

  beforeEach(async () => {
    testDir = join(tmpdir(), `extension-utils-test-${Date.now()}-${Math.random().toString(36)}`);
    await mkdir(testDir, { recursive: true });
    fs = new DefaultFileSystemLayer(createMockLogger());
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("listInstalledExtensions", () => {
    it("lists extensions from real directory", async () => {
      // Create extension directories
      await mkdir(join(testDir, "codehydra.codehydra-0.0.1"));
      await mkdir(join(testDir, "sst-dev.opencode-1.2.3"));

      const result = await listInstalledExtensions(fs, testDir);

      expect(result.size).toBe(2);
      expect(result.get("codehydra.codehydra")).toBe("0.0.1");
      expect(result.get("sst-dev.opencode")).toBe("1.2.3");
    });

    it("returns empty map for empty directory", async () => {
      const result = await listInstalledExtensions(fs, testDir);

      expect(result.size).toBe(0);
    });

    it("returns empty map for non-existent directory", async () => {
      const result = await listInstalledExtensions(fs, join(testDir, "does-not-exist"));

      expect(result.size).toBe(0);
    });

    it("ignores files (only processes directories)", async () => {
      // Create a file with extension-like name
      await writeFile(join(testDir, "codehydra.codehydra-0.0.1"), "not a directory");
      // Create an actual extension directory
      await mkdir(join(testDir, "sst-dev.opencode-1.2.3"));

      const result = await listInstalledExtensions(fs, testDir);

      expect(result.size).toBe(1);
      expect(result.get("sst-dev.opencode")).toBe("1.2.3");
    });

    it("handles mixed valid and invalid entries", async () => {
      // Valid extension directories
      await mkdir(join(testDir, "codehydra.codehydra-0.0.1"));

      // Invalid entries
      await mkdir(join(testDir, ".git")); // Hidden directory
      await mkdir(join(testDir, "node_modules")); // Non-extension directory
      await mkdir(join(testDir, "random-folder")); // No dot in name

      const result = await listInstalledExtensions(fs, testDir);

      expect(result.size).toBe(1);
      expect(result.get("codehydra.codehydra")).toBe("0.0.1");
    });

    it("handles prerelease versions", async () => {
      await mkdir(join(testDir, "publisher.ext-1.0.0-beta.1"));
      await mkdir(join(testDir, "another.ext-2.0.0-alpha"));

      const result = await listInstalledExtensions(fs, testDir);

      expect(result.size).toBe(2);
      expect(result.get("publisher.ext")).toBe("1.0.0-beta.1");
      expect(result.get("another.ext")).toBe("2.0.0-alpha");
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
      await writeFile(join(testDir, "extensions.json"), sampleExtensionsJson);

      await removeFromExtensionsJson(fs, testDir, ["sst-dev.opencode"]);

      const content = await readFile(join(testDir, "extensions.json"), "utf-8");
      const result = JSON.parse(content);
      expect(result).toHaveLength(1);
      expect(result[0].identifier.id).toBe("codehydra.sidekick");
    });

    it("removes multiple extensions", async () => {
      await writeFile(join(testDir, "extensions.json"), sampleExtensionsJson);

      await removeFromExtensionsJson(fs, testDir, ["sst-dev.opencode", "codehydra.sidekick"]);

      const content = await readFile(join(testDir, "extensions.json"), "utf-8");
      const result = JSON.parse(content);
      expect(result).toHaveLength(0);
    });

    it("does nothing when extensions.json does not exist", async () => {
      await removeFromExtensionsJson(fs, testDir, ["sst-dev.opencode"]);

      await expect(readFile(join(testDir, "extensions.json"), "utf-8")).rejects.toThrow();
    });

    it("does nothing when extension ID not found", async () => {
      await writeFile(join(testDir, "extensions.json"), sampleExtensionsJson);

      await removeFromExtensionsJson(fs, testDir, ["nonexistent.extension"]);

      const content = await readFile(join(testDir, "extensions.json"), "utf-8");
      expect(content).toBe(sampleExtensionsJson);
    });

    it("does nothing for empty extension IDs list", async () => {
      await writeFile(join(testDir, "extensions.json"), sampleExtensionsJson);

      await removeFromExtensionsJson(fs, testDir, []);

      const content = await readFile(join(testDir, "extensions.json"), "utf-8");
      expect(content).toBe(sampleExtensionsJson);
    });

    it("handles case-insensitive extension IDs", async () => {
      await writeFile(join(testDir, "extensions.json"), sampleExtensionsJson);

      await removeFromExtensionsJson(fs, testDir, ["SST-DEV.OPENCODE"]);

      const content = await readFile(join(testDir, "extensions.json"), "utf-8");
      const result = JSON.parse(content);
      expect(result).toHaveLength(1);
      expect(result[0].identifier.id).toBe("codehydra.sidekick");
    });

    it("handles invalid JSON gracefully", async () => {
      const invalidJson = "not valid json";
      await writeFile(join(testDir, "extensions.json"), invalidJson);

      await removeFromExtensionsJson(fs, testDir, ["sst-dev.opencode"]);

      const content = await readFile(join(testDir, "extensions.json"), "utf-8");
      expect(content).toBe(invalidJson);
    });

    it("handles non-array JSON gracefully", async () => {
      const nonArrayJson = '{"not": "an array"}';
      await writeFile(join(testDir, "extensions.json"), nonArrayJson);

      await removeFromExtensionsJson(fs, testDir, ["sst-dev.opencode"]);

      const content = await readFile(join(testDir, "extensions.json"), "utf-8");
      expect(content).toBe(nonArrayJson);
    });
  });
});
