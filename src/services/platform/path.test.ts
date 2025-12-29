/**
 * @fileoverview Tests for the Path class.
 *
 * Organized into three describe blocks:
 * - Cross-platform tests (run on all platforms)
 * - Windows-specific tests (skipIf not Windows)
 * - Unix-specific tests (skipIf Windows)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Path, setPlatformForTesting, resetPlatform } from "./path";

describe("Path", () => {
  afterEach(() => {
    resetPlatform();
  });

  // ==========================================================================
  // Cross-Platform Tests
  // ==========================================================================

  describe("normalization (cross-platform)", () => {
    it("removes trailing slashes", () => {
      const p = new Path("/foo/bar/");
      expect(p.toString()).toBe("/foo/bar");
    });

    it("resolves .. segments", () => {
      const p = new Path("/foo/bar/../baz");
      expect(p.toString()).toBe("/foo/baz");
    });

    it("resolves . segments", () => {
      const p = new Path("/foo/./bar");
      expect(p.toString()).toBe("/foo/bar");
    });

    it("collapses multiple slashes", () => {
      const p = new Path("/foo//bar");
      expect(p.toString()).toBe("/foo/bar");
    });

    it("handles root path only", () => {
      const p = new Path("/");
      expect(p.toString()).toBe("/");
    });
  });

  describe("validation (cross-platform)", () => {
    it("throws on relative path ./foo", () => {
      expect(() => new Path("./foo")).toThrow("Path must be absolute");
    });

    it("throws on relative path ../foo", () => {
      expect(() => new Path("../foo")).toThrow("Path must be absolute");
    });

    it("throws on bare relative path foo/bar", () => {
      expect(() => new Path("foo/bar")).toThrow("Path must be absolute");
    });

    it("throws on empty path", () => {
      expect(() => new Path("")).toThrow("Path cannot be empty");
    });

    it("throws on null path", () => {
      expect(() => new Path(null as unknown as string)).toThrow("Path cannot be null or undefined");
    });

    it("throws on undefined path", () => {
      expect(() => new Path(undefined as unknown as string)).toThrow(
        "Path cannot be null or undefined"
      );
    });

    it("throws on empty part", () => {
      expect(() => new Path("/foo", "")).toThrow("Path parts cannot be empty strings");
    });

    it("throws on null part", () => {
      expect(() => new Path("/foo", null as unknown as string)).toThrow(
        "Path parts cannot be null or undefined"
      );
    });
  });

  describe("constructor join (cross-platform)", () => {
    it("joins single part", () => {
      const p = new Path("/foo", "bar");
      expect(p.toString()).toBe("/foo/bar");
    });

    it("joins multiple parts", () => {
      const p = new Path("/foo", "bar", "baz");
      expect(p.toString()).toBe("/foo/bar/baz");
    });

    it("extends existing Path", () => {
      const p1 = new Path("/foo");
      const p2 = new Path(p1, "bar");
      expect(p2.toString()).toBe("/foo/bar");
    });

    it("handles relative parts in join", () => {
      const p = new Path("/foo", "./bar");
      expect(p.toString()).toBe("/foo/bar");
    });

    it("handles parent parts in join", () => {
      const p = new Path("/foo/bar", "../baz");
      expect(p.toString()).toBe("/foo/baz");
    });
  });

  describe("accessors (cross-platform)", () => {
    it("returns basename for file", () => {
      const p = new Path("/foo/bar.ts");
      expect(p.basename).toBe("bar.ts");
    });

    it("returns basename for directory", () => {
      const p = new Path("/foo/bar");
      expect(p.basename).toBe("bar");
    });

    it("returns dirname as Path", () => {
      const p = new Path("/foo/bar");
      expect(p.dirname).toBeInstanceOf(Path);
      expect(p.dirname.toString()).toBe("/foo");
    });

    it("returns extension including dot", () => {
      const p = new Path("/foo/bar.ts");
      expect(p.extension).toBe(".ts");
    });

    it("returns empty extension for no extension", () => {
      const p = new Path("/foo/bar");
      expect(p.extension).toBe("");
    });

    it("returns segments as array", () => {
      const p = new Path("/foo/bar/baz");
      expect(p.segments).toEqual(["foo", "bar", "baz"]);
    });
  });

  describe("equals (cross-platform)", () => {
    it("returns true for equal Path objects", () => {
      const p1 = new Path("/foo/bar");
      const p2 = new Path("/foo/bar");
      expect(p1.equals(p2)).toBe(true);
    });

    it("returns false for different Path objects", () => {
      const p1 = new Path("/foo");
      const p2 = new Path("/bar");
      expect(p1.equals(p2)).toBe(false);
    });

    it("returns true for equal string", () => {
      const p = new Path("/foo/bar");
      expect(p.equals("/foo/bar")).toBe(true);
    });

    it("returns false for invalid string (relative)", () => {
      const p = new Path("/foo/bar");
      expect(p.equals("relative")).toBe(false);
    });

    it("returns false for invalid string (empty)", () => {
      const p = new Path("/foo/bar");
      expect(p.equals("")).toBe(false);
    });
  });

  describe("startsWith (cross-platform)", () => {
    it("returns true for matching prefix", () => {
      const p = new Path("/foo/bar/baz");
      expect(p.startsWith("/foo")).toBe(true);
    });

    it("returns true for exact match", () => {
      const p = new Path("/foo");
      expect(p.startsWith("/foo")).toBe(true);
    });

    it("returns false for non-matching prefix", () => {
      const p = new Path("/foo/bar");
      expect(p.startsWith("/baz")).toBe(false);
    });

    it("returns false for partial segment match", () => {
      const p = new Path("/foo-bar");
      expect(p.startsWith("/foo")).toBe(false);
    });

    it("returns false for invalid prefix", () => {
      const p = new Path("/foo/bar");
      expect(p.startsWith("relative")).toBe(false);
    });
  });

  describe("isChildOf (cross-platform)", () => {
    it("returns true for child path", () => {
      const p = new Path("/foo/bar");
      expect(p.isChildOf("/foo")).toBe(true);
    });

    it("returns false for same path", () => {
      const p = new Path("/foo");
      expect(p.isChildOf("/foo")).toBe(false);
    });

    it("returns false for sibling path", () => {
      const p = new Path("/foo-bar");
      expect(p.isChildOf("/foo")).toBe(false);
    });

    it("returns false for parent path", () => {
      const p = new Path("/foo");
      expect(p.isChildOf("/foo/bar")).toBe(false);
    });

    it("returns false for invalid parent", () => {
      const p = new Path("/foo/bar");
      expect(p.isChildOf("relative")).toBe(false);
    });
  });

  describe("relativeTo (cross-platform)", () => {
    it("returns relative path", () => {
      const p = new Path("/foo/bar/baz");
      expect(p.relativeTo("/foo")).toBe("bar/baz");
    });

    it("returns empty string for same path", () => {
      const p = new Path("/foo/bar");
      expect(p.relativeTo("/foo/bar")).toBe("");
    });

    it("handles parent traversal", () => {
      const p = new Path("/foo/bar");
      expect(p.relativeTo("/foo/baz")).toBe("../bar");
    });
  });

  describe("serialization (cross-platform)", () => {
    it("toJSON returns normalized string", () => {
      const p = new Path("/foo/bar");
      expect(JSON.stringify(p)).toBe('"/foo/bar"');
    });

    it("valueOf returns normalized string", () => {
      const p = new Path("/foo/bar");
      expect(String(p)).toBe("/foo/bar");
    });

    it("Symbol.toStringTag returns 'Path'", () => {
      const p = new Path("/foo/bar");
      expect(Object.prototype.toString.call(p)).toBe("[object Path]");
    });
  });

  describe("static methods (cross-platform)", () => {
    it("Path.cwd() returns current working directory", () => {
      const cwd = Path.cwd();
      expect(cwd).toBeInstanceOf(Path);
      expect(cwd.toString()).toContain("/");
    });

    it("Path.cwd() with relative path creates absolute path", () => {
      const p = new Path(Path.cwd(), "relative");
      expect(p).toBeInstanceOf(Path);
      expect(p.toString()).toContain("/relative");
    });
  });

  // ==========================================================================
  // Windows-Specific Tests
  // ==========================================================================

  describe.skipIf(process.platform !== "win32")("normalization (Windows)", () => {
    it("converts backslashes to forward slashes", () => {
      const p = new Path("C:\\foo\\bar");
      expect(p.toString()).toBe("c:/foo/bar");
    });

    it("handles forward slashes", () => {
      const p = new Path("C:/foo/bar");
      expect(p.toString()).toBe("c:/foo/bar");
    });

    it("handles mixed separators", () => {
      const p = new Path("C:\\foo/bar");
      expect(p.toString()).toBe("c:/foo/bar");
    });

    it("lowercases drive letter", () => {
      const p = new Path("C:/foo/bar");
      expect(p.toString()).toBe("c:/foo/bar");
    });

    it("lowercases path (case-insensitive)", () => {
      const p = new Path("C:\\FOO\\Bar");
      expect(p.toString()).toBe("c:/foo/bar");
    });

    it("handles root path", () => {
      const p = new Path("C:/");
      expect(p.toString()).toBe("c:/");
    });

    it("handles UNC path", () => {
      const p = new Path("\\\\server\\share\\folder");
      expect(p.toString()).toBe("//server/share/folder");
    });

    it("toNative converts to backslashes", () => {
      const p = new Path("C:/foo/bar");
      expect(p.toNative()).toBe("c:\\foo\\bar");
    });

    it("equals normalizes Windows paths", () => {
      const p = new Path("C:/foo/bar");
      expect(p.equals("C:\\FOO\\Bar")).toBe(true);
    });
  });

  // ==========================================================================
  // Unix-Specific Tests
  // ==========================================================================

  describe.skipIf(process.platform === "win32")("normalization (Unix)", () => {
    it("preserves case", () => {
      const p = new Path("/FOO/Bar");
      expect(p.toString()).toBe("/FOO/Bar");
    });

    it("toNative returns same as toString", () => {
      const p = new Path("/foo/bar");
      expect(p.toNative()).toBe("/foo/bar");
    });
  });

  // ==========================================================================
  // Platform Simulation Tests (using setPlatformForTesting)
  // ==========================================================================

  describe("platform simulation", () => {
    describe("simulated Windows", () => {
      beforeEach(() => {
        setPlatformForTesting(true);
      });

      it("normalizes to lowercase", () => {
        const p = new Path("C:/FOO/Bar");
        expect(p.toString()).toBe("c:/foo/bar");
      });

      it("accepts Windows-style absolute paths", () => {
        const p = new Path("D:\\Projects\\MyApp");
        expect(p.toString()).toBe("d:/projects/myapp");
      });
    });

    describe("simulated Unix", () => {
      beforeEach(() => {
        setPlatformForTesting(false);
      });

      it("preserves case", () => {
        const p = new Path("/FOO/Bar");
        expect(p.toString()).toBe("/FOO/Bar");
      });

      it("rejects Windows-style paths as relative", () => {
        // On Unix, "C:/foo" is relative (no leading /)
        expect(() => new Path("C:/foo")).toThrow("Path must be absolute");
      });
    });
  });
});
