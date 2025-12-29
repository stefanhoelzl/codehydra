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
 *
 * NOTE: Path normalization tests are in path.test.ts (Path class).
 */

import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import { projectDirName, sanitizeWorkspaceName, encodePathForUrl } from "./paths";

describe("paths utility functions", () => {
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
