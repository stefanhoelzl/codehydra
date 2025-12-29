/**
 * Tests for ID generation utilities.
 */
import { describe, it, expect } from "vitest";
import { generateProjectId } from "./id-utils";
import { isProjectId } from "../../shared/api/types";

describe("generateProjectId", () => {
  describe("deterministic generation", () => {
    it("should generate same ID for same path", () => {
      const path = "/home/user/projects/my-app";
      const id1 = generateProjectId(path);
      const id2 = generateProjectId(path);
      expect(id1).toBe(id2);
    });

    it("should generate different IDs for different paths", () => {
      const id1 = generateProjectId("/home/user/projects/app1");
      const id2 = generateProjectId("/home/user/projects/app2");
      expect(id1).not.toBe(id2);
    });

    it("should return valid ProjectId type", () => {
      const id = generateProjectId("/home/user/projects/my-app");
      expect(isProjectId(id)).toBe(true);
    });
  });

  describe("format", () => {
    it("should use basename and 8-char hash", () => {
      const id = generateProjectId("/home/user/projects/my-app");
      // Format: <name>-<8-hex-chars>
      expect(id).toMatch(/^my-app-[a-f0-9]{8}$/);
    });

    it("should replace special characters with dashes", () => {
      const id = generateProjectId("/home/user/My Cool App");
      // "My Cool App" -> "my-cool-app" (lowercase on Windows, mixed case on Unix)
      expect(id).toMatch(/^my-cool-app-[a-f0-9]{8}$/i);
    });

    it("should handle spaces correctly", () => {
      const id = generateProjectId("/home/user/Projects/My App");
      expect(id).toMatch(/^my-app-[a-f0-9]{8}$/i);
    });

    it("should be case-insensitive for name matching", () => {
      const id = generateProjectId("/home/user/MyApp");
      expect(id).toMatch(/^myapp-[a-f0-9]{8}$/i);
    });
  });

  describe("path normalization", () => {
    it("should normalize trailing slashes", () => {
      const id1 = generateProjectId("/home/user/projects/my-app");
      const id2 = generateProjectId("/home/user/projects/my-app/");
      expect(id1).toBe(id2);
    });

    it("should normalize double slashes", () => {
      const id1 = generateProjectId("/home/user/projects/my-app");
      const id2 = generateProjectId("/home/user//projects/my-app");
      expect(id1).toBe(id2);
    });

    it("should handle dot segments", () => {
      const id1 = generateProjectId("/home/user/projects/my-app");
      const id2 = generateProjectId("/home/user/projects/./my-app");
      expect(id1).toBe(id2);
    });
  });

  describe("edge cases", () => {
    it("should handle single character basename", () => {
      const id = generateProjectId("/x");
      expect(id).toMatch(/^x-[a-f0-9]{8}$/);
      expect(isProjectId(id)).toBe(true);
    });

    it("should handle root path", () => {
      const id = generateProjectId("/");
      // Root basename is empty, should use "root" as fallback
      expect(id).toMatch(/^root-[a-f0-9]{8}$/);
      expect(isProjectId(id)).toBe(true);
    });

    it("should handle very long path names", () => {
      const longName = "a".repeat(200);
      const id = generateProjectId(`/home/user/${longName}`);
      // Should still generate valid ID (name may be truncated)
      expect(isProjectId(id)).toBe(true);
    });

    it("should handle unicode characters", () => {
      const id = generateProjectId("/home/user/projekt-uberlegung");
      // Replace non-alphanumeric with dashes
      expect(isProjectId(id)).toBe(true);
    });

    it("should handle dots in path", () => {
      const id = generateProjectId("/home/user/my.cool.app");
      expect(id).toMatch(/^my-cool-app-[a-f0-9]{8}$/);
      expect(isProjectId(id)).toBe(true);
    });

    it("should handle underscores in path", () => {
      const id = generateProjectId("/home/user/my_cool_app");
      expect(id).toMatch(/^my-cool-app-[a-f0-9]{8}$/);
      expect(isProjectId(id)).toBe(true);
    });

    it("should handle numbers in path", () => {
      const id = generateProjectId("/home/user/app123");
      expect(id).toMatch(/^app123-[a-f0-9]{8}$/);
      expect(isProjectId(id)).toBe(true);
    });

    it("should collapse consecutive dashes", () => {
      const id = generateProjectId("/home/user/my---app");
      // Should collapse "---" to single "-"
      expect(id).toMatch(/^my-app-[a-f0-9]{8}$/);
      expect(isProjectId(id)).toBe(true);
    });

    it("should handle leading special characters", () => {
      const id = generateProjectId("/home/user/.hidden-project");
      // Remove leading dots/dashes
      expect(id).toMatch(/^hidden-project-[a-f0-9]{8}$/);
      expect(isProjectId(id)).toBe(true);
    });
  });

  describe("case sensitivity", () => {
    it("should handle case according to platform", () => {
      const id1 = generateProjectId("/home/user/MyApp");
      const id2 = generateProjectId("/home/user/myapp");
      if (process.platform === "win32") {
        // Windows: case-insensitive, both produce same ID
        expect(id1).toBe(id2);
      } else {
        // Unix: case-sensitive, different IDs
        expect(id1).not.toBe(id2);
      }
    });
  });
});
