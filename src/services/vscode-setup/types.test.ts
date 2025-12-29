/**
 * Tests for VS Code setup types and validation functions.
 */

import { describe, it, expect } from "vitest";
import { validateExtensionsConfig } from "./types";

describe("validateExtensionsConfig", () => {
  it("accepts valid config with new bundled format", () => {
    const config = {
      marketplace: ["sst-dev.opencode"],
      bundled: [
        {
          id: "codehydra.codehydra",
          version: "0.0.1",
          vsix: "codehydra.vscode-0.0.1.vsix",
        },
      ],
    };

    const result = validateExtensionsConfig(config);

    expect(result.isValid).toBe(true);
    if (result.isValid) {
      expect(result.config.marketplace).toEqual(["sst-dev.opencode"]);
      expect(result.config.bundled).toHaveLength(1);
      expect(result.config.bundled[0]).toEqual({
        id: "codehydra.codehydra",
        version: "0.0.1",
        vsix: "codehydra.vscode-0.0.1.vsix",
      });
    }
  });

  it("accepts config with empty arrays", () => {
    const config = {
      marketplace: [],
      bundled: [],
    };

    const result = validateExtensionsConfig(config);

    expect(result.isValid).toBe(true);
  });

  it("detects legacy bundled format with helpful error", () => {
    const legacyConfig = {
      marketplace: ["sst-dev.opencode"],
      bundled: ["codehydra.vscode-0.0.1.vsix"], // Old format: string instead of object
    };

    const result = validateExtensionsConfig(legacyConfig);

    expect(result.isValid).toBe(false);
    if (!result.isValid) {
      expect(result.error).toContain("bundled[0] is a string");
      expect(result.error).toContain("{ id, version, vsix }");
      expect(result.error).toContain("Please update manifest.json");
    }
  });

  it("rejects null value", () => {
    const result = validateExtensionsConfig(null);

    expect(result.isValid).toBe(false);
    if (!result.isValid) {
      expect(result.error).toBe("manifest.json must be an object");
    }
  });

  it("rejects non-object value", () => {
    const result = validateExtensionsConfig("not an object");

    expect(result.isValid).toBe(false);
    if (!result.isValid) {
      expect(result.error).toBe("manifest.json must be an object");
    }
  });

  it("rejects missing marketplace field", () => {
    const result = validateExtensionsConfig({
      bundled: [],
    });

    expect(result.isValid).toBe(false);
    if (!result.isValid) {
      expect(result.error).toBe("manifest.json must have a 'marketplace' array");
    }
  });

  it("rejects missing bundled field", () => {
    const result = validateExtensionsConfig({
      marketplace: [],
    });

    expect(result.isValid).toBe(false);
    if (!result.isValid) {
      expect(result.error).toBe("manifest.json must have a 'bundled' array");
    }
  });

  it("rejects non-string marketplace items", () => {
    const result = validateExtensionsConfig({
      marketplace: [123],
      bundled: [],
    });

    expect(result.isValid).toBe(false);
    if (!result.isValid) {
      expect(result.error).toBe("marketplace items must be strings");
    }
  });

  it("rejects bundled item missing id", () => {
    const result = validateExtensionsConfig({
      marketplace: [],
      bundled: [{ version: "0.0.1", vsix: "test.vsix" }],
    });

    expect(result.isValid).toBe(false);
    if (!result.isValid) {
      expect(result.error).toBe("bundled[0].id must be a non-empty string");
    }
  });

  it("rejects bundled item missing version", () => {
    const result = validateExtensionsConfig({
      marketplace: [],
      bundled: [{ id: "test.ext", vsix: "test.vsix" }],
    });

    expect(result.isValid).toBe(false);
    if (!result.isValid) {
      expect(result.error).toBe("bundled[0].version must be a non-empty string");
    }
  });

  it("rejects bundled item missing vsix", () => {
    const result = validateExtensionsConfig({
      marketplace: [],
      bundled: [{ id: "test.ext", version: "0.0.1" }],
    });

    expect(result.isValid).toBe(false);
    if (!result.isValid) {
      expect(result.error).toBe("bundled[0].vsix must be a non-empty string");
    }
  });

  it("rejects bundled item with empty id", () => {
    const result = validateExtensionsConfig({
      marketplace: [],
      bundled: [{ id: "", version: "0.0.1", vsix: "test.vsix" }],
    });

    expect(result.isValid).toBe(false);
    if (!result.isValid) {
      expect(result.error).toBe("bundled[0].id must be a non-empty string");
    }
  });
});
