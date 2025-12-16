// @vitest-environment node
/**
 * Unit tests for bin-scripts utility module.
 */

import { describe, it, expect } from "vitest";
import { generateScript, generateScripts } from "./bin-scripts";
import { createMockPlatformInfo } from "../platform/platform-info.test-utils";
import type { BinTargetPaths } from "./types";

describe("generateScript", () => {
  describe("Unix (Linux/macOS)", () => {
    it("starts with shebang", () => {
      const script = generateScript("code", "/path/to/code-cli.sh", false);

      expect(script.content).toMatch(/^#!/);
      expect(script.content.startsWith("#!/bin/sh\n")).toBe(true);
    });

    it("uses exec command", () => {
      const script = generateScript("code", "/path/to/code-cli.sh", false);

      expect(script.content).toContain("exec ");
    });

    it("passes arguments with $@", () => {
      const script = generateScript("code", "/path/to/code-cli.sh", false);

      expect(script.content).toContain('"$@"');
    });

    it("wraps path in single quotes", () => {
      const script = generateScript("code", "/path/to/binary", false);

      expect(script.content).toContain("'/path/to/binary'");
    });

    it("escapes single quotes in path", () => {
      const script = generateScript("code", "/path/to/user's/binary", false);

      // Single quotes in path should be escaped: ' -> '\''
      expect(script.content).toContain("'\\''");
    });

    it("has needsExecutable = true", () => {
      const script = generateScript("code", "/path/to/binary", false);

      expect(script.needsExecutable).toBe(true);
    });

    it("filename has no extension", () => {
      const script = generateScript("code", "/path/to/binary", false);

      expect(script.filename).toBe("code");
    });
  });

  describe("Windows", () => {
    it("starts with @echo off", () => {
      const script = generateScript("code", "C:/path/to/code.exe", true);

      expect(script.content.startsWith("@echo off")).toBe(true);
    });

    it("uses .cmd extension", () => {
      const script = generateScript("code", "C:/path/to/code.exe", true);

      expect(script.filename).toBe("code.cmd");
    });

    it("wraps path in double quotes", () => {
      const script = generateScript("code", "C:/path/to/code.exe", true);

      expect(script.content).toContain('"C:\\path\\to\\code.exe"');
    });

    it("converts forward slashes to backslashes", () => {
      const script = generateScript("code", "C:/Program Files/Code/code.exe", true);

      expect(script.content).toContain("C:\\Program Files\\Code\\code.exe");
    });

    it("passes arguments with %*", () => {
      const script = generateScript("code", "C:/path/to/code.exe", true);

      expect(script.content).toContain("%*");
    });

    it("has needsExecutable = false", () => {
      const script = generateScript("code", "C:/path/to/code.exe", true);

      expect(script.needsExecutable).toBe(false);
    });
  });

  describe("paths with spaces", () => {
    it("handles Unix paths with spaces", () => {
      const script = generateScript("code", "/path/with spaces/to/binary", false);

      expect(script.content).toContain("'/path/with spaces/to/binary'");
    });

    it("handles Windows paths with spaces", () => {
      const script = generateScript("code", "C:/Program Files/Code/code.exe", true);

      expect(script.content).toContain('"C:\\Program Files\\Code\\code.exe"');
    });
  });
});

describe("generateScripts", () => {
  const createTargetPaths = (
    opencodePath: string | null = "/usr/bin/opencode"
  ): BinTargetPaths => ({
    codeRemoteCli: "/app/code-server/lib/vscode/bin/remote-cli/code-linux.sh",
    opencodeBinary: opencodePath,
  });

  describe("platform detection", () => {
    it("uses Unix template on Linux", () => {
      const platformInfo = createMockPlatformInfo({ platform: "linux" });
      const scripts = generateScripts(platformInfo, createTargetPaths());

      // All scripts should be Unix-style (no .cmd extension)
      expect(scripts.every((s) => !s.filename.endsWith(".cmd"))).toBe(true);
      expect(scripts.every((s) => s.needsExecutable)).toBe(true);
      expect(scripts.every((s) => s.content.startsWith("#!/bin/sh"))).toBe(true);
    });

    it("uses Unix template on macOS", () => {
      const platformInfo = createMockPlatformInfo({ platform: "darwin" });
      const scripts = generateScripts(platformInfo, createTargetPaths());

      expect(scripts.every((s) => !s.filename.endsWith(".cmd"))).toBe(true);
      expect(scripts.every((s) => s.needsExecutable)).toBe(true);
    });

    it("uses Windows template on Windows", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });
      const scripts = generateScripts(platformInfo, createTargetPaths());

      expect(scripts.every((s) => s.filename.endsWith(".cmd"))).toBe(true);
      expect(scripts.every((s) => !s.needsExecutable)).toBe(true);
      expect(scripts.every((s) => s.content.startsWith("@echo off"))).toBe(true);
    });
  });

  describe("script generation", () => {
    it("generates consistent set per platform (Linux)", () => {
      const platformInfo = createMockPlatformInfo({ platform: "linux" });
      const scripts = generateScripts(platformInfo, createTargetPaths());

      const filenames = scripts.map((s) => s.filename);
      expect(filenames).toContain("code");
      expect(filenames).toContain("opencode");
      expect(scripts).toHaveLength(2);
    });

    it("generates consistent set per platform (Windows)", () => {
      const platformInfo = createMockPlatformInfo({ platform: "win32" });
      const scripts = generateScripts(platformInfo, createTargetPaths());

      const filenames = scripts.map((s) => s.filename);
      expect(filenames).toContain("code.cmd");
      expect(filenames).toContain("opencode.cmd");
      expect(scripts).toHaveLength(2);
    });

    it("skips opencode when null", () => {
      const platformInfo = createMockPlatformInfo({ platform: "linux" });
      const scripts = generateScripts(platformInfo, createTargetPaths(null));

      const filenames = scripts.map((s) => s.filename);
      expect(filenames).toContain("code");
      expect(filenames).not.toContain("opencode");
      expect(scripts).toHaveLength(1);
    });

    it("includes correct target paths in scripts", () => {
      const platformInfo = createMockPlatformInfo({ platform: "linux" });
      const targetPaths = createTargetPaths();
      const scripts = generateScripts(platformInfo, targetPaths);

      const codeScript = scripts.find((s) => s.filename === "code");
      const opencodeScript = scripts.find((s) => s.filename === "opencode");

      expect(codeScript?.content).toContain(targetPaths.codeRemoteCli);
      expect(opencodeScript?.content).toContain(targetPaths.opencodeBinary);
    });
  });
});
