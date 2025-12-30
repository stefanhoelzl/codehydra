/**
 * Tests for VS Code setup types and validation functions.
 */

import { describe, it, expect } from "vitest";
import { validateExtensionsManifest } from "./types";

describe("validateExtensionsManifest", () => {
  it("accepts valid manifest with array format", () => {
    const manifest = [
      {
        id: "codehydra.sidekick",
        version: "0.0.3",
        vsix: "codehydra-sidekick-0.0.3.vsix",
      },
      {
        id: "sst-dev.opencode",
        version: "0.0.13",
        vsix: "sst-dev-opencode-0.0.13.vsix",
      },
    ];

    const result = validateExtensionsManifest(manifest);

    expect(result.isValid).toBe(true);
    if (result.isValid) {
      expect(result.manifest).toHaveLength(2);
      expect(result.manifest[0]).toEqual({
        id: "codehydra.sidekick",
        version: "0.0.3",
        vsix: "codehydra-sidekick-0.0.3.vsix",
      });
      expect(result.manifest[1]).toEqual({
        id: "sst-dev.opencode",
        version: "0.0.13",
        vsix: "sst-dev-opencode-0.0.13.vsix",
      });
    }
  });

  it("accepts empty array", () => {
    const result = validateExtensionsManifest([]);

    expect(result.isValid).toBe(true);
    if (result.isValid) {
      expect(result.manifest).toHaveLength(0);
    }
  });

  it("rejects non-array value", () => {
    const result = validateExtensionsManifest({ marketplace: [], bundled: [] });

    expect(result.isValid).toBe(false);
    if (!result.isValid) {
      expect(result.error).toBe("manifest.json must be an array of extension objects");
    }
  });

  it("rejects null value", () => {
    const result = validateExtensionsManifest(null);

    expect(result.isValid).toBe(false);
    if (!result.isValid) {
      expect(result.error).toBe("manifest.json must be an array of extension objects");
    }
  });

  it("rejects string value", () => {
    const result = validateExtensionsManifest("not an array");

    expect(result.isValid).toBe(false);
    if (!result.isValid) {
      expect(result.error).toBe("manifest.json must be an array of extension objects");
    }
  });

  it("detects string items with helpful error", () => {
    const manifest = ["codehydra.sidekick-0.0.3.vsix"];

    const result = validateExtensionsManifest(manifest);

    expect(result.isValid).toBe(false);
    if (!result.isValid) {
      expect(result.error).toContain("manifest.json[0] is a string");
      expect(result.error).toContain("{ id, version, vsix }");
      expect(result.error).toContain("Please update manifest.json");
    }
  });

  it("rejects item missing id", () => {
    const result = validateExtensionsManifest([{ version: "0.0.1", vsix: "test.vsix" }]);

    expect(result.isValid).toBe(false);
    if (!result.isValid) {
      expect(result.error).toBe("manifest.json[0].id must be a non-empty string");
    }
  });

  it("rejects item missing version", () => {
    const result = validateExtensionsManifest([{ id: "test.ext", vsix: "test.vsix" }]);

    expect(result.isValid).toBe(false);
    if (!result.isValid) {
      expect(result.error).toBe("manifest.json[0].version must be a non-empty string");
    }
  });

  it("rejects item missing vsix", () => {
    const result = validateExtensionsManifest([{ id: "test.ext", version: "0.0.1" }]);

    expect(result.isValid).toBe(false);
    if (!result.isValid) {
      expect(result.error).toBe("manifest.json[0].vsix must be a non-empty string");
    }
  });

  it("rejects item with empty id", () => {
    const result = validateExtensionsManifest([{ id: "", version: "0.0.1", vsix: "test.vsix" }]);

    expect(result.isValid).toBe(false);
    if (!result.isValid) {
      expect(result.error).toBe("manifest.json[0].id must be a non-empty string");
    }
  });

  it("reports correct index for error in middle of array", () => {
    const result = validateExtensionsManifest([
      { id: "test.ext1", version: "0.0.1", vsix: "test1.vsix" },
      { id: "test.ext2", version: "0.0.2" }, // missing vsix
    ]);

    expect(result.isValid).toBe(false);
    if (!result.isValid) {
      expect(result.error).toBe("manifest.json[1].vsix must be a non-empty string");
    }
  });
});
