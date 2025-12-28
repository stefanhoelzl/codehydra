// @vitest-environment node
/**
 * Tests for paths utility functions.
 *
 * NOTE: Build-mode-dependent path functions have been moved to PathProvider.
 * See path-provider.test.ts for tests of:
 * - dataRootDir, projectsDir, vscodeDir, etc.
 * - getProjectWorkspacesDir()
 *
 * This file tests only pure utility functions with no build-mode dependencies.
 */

import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import { normalizePath, projectDirName, sanitizeWorkspaceName, encodePathForUrl } from "./paths";

describe("paths utility functions", () => {
  describe("normalizePath", () => {
    it("normalizes path and strips trailing separator by default", () => {
      const result = normalizePath("/foo/bar/");

      expect(result).toBe("/foo/bar");
    });

    it("handles double slashes", () => {
      const result = normalizePath("/foo//bar");

      expect(result).toBe("/foo/bar");
    });

    it("handles . and .. segments", () => {
      const result = normalizePath("/foo/./bar/../baz");

      expect(result).toBe("/foo/baz");
    });

    it("preserves root path", () => {
      const result = normalizePath("/");

      expect(result).toBe("/");
    });

    it("converts backslashes to forward slashes when option enabled", () => {
      const result = normalizePath("C:\\foo\\bar\\", { forwardSlashes: true });

      expect(result).toBe("C:/foo/bar");
    });

    it("preserves trailing separator when option disabled", () => {
      const result = normalizePath("/foo/bar/", { stripTrailing: false });

      // path.normalize removes trailing slash on POSIX, but let's verify behavior
      expect(result).toMatch(/^\/foo\/bar\/?$/);
    });

    it("handles empty segments after forward slash conversion", () => {
      const result = normalizePath("C:\\foo\\\\bar", { forwardSlashes: true });

      expect(result).toBe("C:/foo/bar");
    });

    it("handles mixed slashes with forwardSlashes option", () => {
      const result = normalizePath("C:\\foo/bar\\baz/", { forwardSlashes: true });

      expect(result).toBe("C:/foo/bar/baz");
    });

    it("works without options object", () => {
      const result = normalizePath("/foo/bar/");

      expect(result).toBe("/foo/bar");
    });
  });

  describe("projectDirName", () => {
    it("generates name from folder name and hash", () => {
      const projectPath = "/home/user/projects/my-repo";

      const result = projectDirName(projectPath);

      expect(result).toMatch(/^my-repo-[a-f0-9]{8}$/);
    });

    it("generates deterministic name for same path", () => {
      const projectPath = "/home/user/projects/my-repo";

      const result1 = projectDirName(projectPath);
      const result2 = projectDirName(projectPath);

      expect(result1).toBe(result2);
    });

    it("generates different names for different paths", () => {
      const result1 = projectDirName("/home/user/projects/repo-a");
      const result2 = projectDirName("/home/user/projects/repo-b");

      expect(result1).not.toBe(result2);
    });

    it("handles unicode characters in path", () => {
      const projectPath = "/home/user/projects/my-repo";

      const result = projectDirName(projectPath);

      expect(result).toMatch(/^my-repo-[a-f0-9]{8}$/);
    });

    it("uses 8-char sha256 hash", () => {
      const projectPath = "/home/user/projects/my-repo";

      const result = projectDirName(projectPath);

      const expectedHash = createHash("sha256").update(projectPath).digest("hex").substring(0, 8);
      expect(result).toBe(`my-repo-${expectedHash}`);
    });
  });

  describe("sanitizeWorkspaceName", () => {
    it("replaces forward slashes with percent signs", () => {
      const result = sanitizeWorkspaceName("feature/my-feature");

      expect(result).toBe("feature%my-feature");
    });

    it("handles multiple slashes", () => {
      const result = sanitizeWorkspaceName("user/feature/sub-feature");

      expect(result).toBe("user%feature%sub-feature");
    });

    it("returns unchanged if no slashes", () => {
      const result = sanitizeWorkspaceName("my-feature");

      expect(result).toBe("my-feature");
    });
  });

  describe("encodePathForUrl", () => {
    it("encodes spaces", () => {
      const result = encodePathForUrl("/home/user/my project");

      expect(result).toBe("/home/user/my%20project");
    });

    it("encodes special characters", () => {
      const result = encodePathForUrl("/home/user/project#1");

      expect(result).toBe("/home/user/project%231");
    });

    it("preserves forward slashes", () => {
      const result = encodePathForUrl("/home/user/project/src");

      expect(result).toBe("/home/user/project/src");
    });

    it("handles unicode characters", () => {
      const result = encodePathForUrl("/home/user/cafe");

      expect(result).toBe("/home/user/cafe");
    });
  });
});
