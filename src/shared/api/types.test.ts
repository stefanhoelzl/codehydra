/**
 * Tests for API type definitions.
 * Includes compile-time type safety checks and runtime type guard validation.
 */
import { describe, it, expect } from "vitest";
import {
  type ProjectId,
  type WorkspaceName,
  validateWorkspaceName,
  isValidMetadataKey,
  METADATA_KEY_REGEX,
  extractTags,
  TAGS_METADATA_KEY_PREFIX,
  type WorkspaceTag,
} from "./types";

describe("Branded Types - Compile-time Safety", () => {
  describe("ProjectId", () => {
    it("should not accept raw strings", () => {
      // @ts-expect-error - raw string should not be assignable to ProjectId
      const _id: ProjectId = "some-string";
      // This prevents accidental assignment of unvalidated strings
      expect(_id).toBeDefined(); // Runtime check to use variable
    });

    it("should accept properly cast values", () => {
      const validId = "my-app-12345678" as ProjectId;
      const id: ProjectId = validId;
      expect(id).toBe("my-app-12345678");
    });
  });

  describe("WorkspaceName", () => {
    it("should not accept raw strings", () => {
      // @ts-expect-error - raw string should not be assignable to WorkspaceName
      const _name: WorkspaceName = "feature-branch";
      expect(_name).toBeDefined();
    });

    it("should accept properly cast values", () => {
      const validName = "feature-branch" as WorkspaceName;
      const name: WorkspaceName = validName;
      expect(name).toBe("feature-branch");
    });
  });
});

describe("validateWorkspaceName - Validation with error messages", () => {
  it("returns null for valid names", () => {
    expect(validateWorkspaceName("feature-branch")).toBeNull();
    expect(validateWorkspaceName("release.1.0")).toBeNull();
    expect(validateWorkspaceName("feature/login")).toBeNull();
    expect(validateWorkspaceName("a")).toBeNull();
  });

  it("returns error for empty string", () => {
    expect(validateWorkspaceName("")).toBe("Name is required");
  });

  it("returns error for names exceeding max length", () => {
    const tooLong = "a".repeat(101);
    expect(validateWorkspaceName(tooLong)).toBe("Name must be 100 characters or less");
  });

  it("returns error for double dots", () => {
    expect(validateWorkspaceName("a..b")).toBe('Name cannot contain ".."');
    expect(validateWorkspaceName("..foo")).toBe('Name cannot contain ".."');
  });

  it("returns error for backslash", () => {
    expect(validateWorkspaceName("feature\\branch")).toBe('Name cannot contain "\\"');
  });

  it("returns error for invalid characters", () => {
    expect(validateWorkspaceName("feature@branch")).toBe(
      "Name can only contain letters, numbers, dash, underscore, dot, forward slash"
    );
  });

  it("returns error for names starting with non-alphanumeric", () => {
    expect(validateWorkspaceName("-feature")).toBe(
      "Name can only contain letters, numbers, dash, underscore, dot, forward slash"
    );
    expect(validateWorkspaceName(".feature")).toBe(
      "Name can only contain letters, numbers, dash, underscore, dot, forward slash"
    );
    expect(validateWorkspaceName("/feature")).toBe(
      "Name can only contain letters, numbers, dash, underscore, dot, forward slash"
    );
  });
});

describe("METADATA_KEY_REGEX", () => {
  it("should be exported for external validation", () => {
    expect(METADATA_KEY_REGEX).toBeDefined();
    expect(METADATA_KEY_REGEX).toBeInstanceOf(RegExp);
  });
});

describe("isValidMetadataKey - Metadata Key Validation", () => {
  describe("valid keys", () => {
    it("should accept simple lowercase keys", () => {
      expect(isValidMetadataKey("base")).toBe(true);
      expect(isValidMetadataKey("note")).toBe(true);
    });

    it("should accept keys with hyphens", () => {
      expect(isValidMetadataKey("model-name")).toBe(true);
      expect(isValidMetadataKey("last-model-used")).toBe(true);
    });

    it("should accept uppercase keys", () => {
      expect(isValidMetadataKey("AI")).toBe(true);
      expect(isValidMetadataKey("AI-model")).toBe(true);
    });

    it("should accept keys with numbers (not at start)", () => {
      expect(isValidMetadataKey("model2")).toBe(true);
      expect(isValidMetadataKey("version1-beta")).toBe(true);
    });

    it("should accept single character key", () => {
      expect(isValidMetadataKey("a")).toBe(true);
      expect(isValidMetadataKey("Z")).toBe(true);
    });

    it("should accept dot-separated keys", () => {
      expect(isValidMetadataKey("tags.bugfix")).toBe(true);
      expect(isValidMetadataKey("tags.my-tag")).toBe(true);
      expect(isValidMetadataKey("a.b.c")).toBe(true);
      expect(isValidMetadataKey("tags.v2.release")).toBe(true);
    });
  });

  describe("invalid keys", () => {
    it("should reject keys with underscores", () => {
      expect(isValidMetadataKey("my_key")).toBe(false);
      expect(isValidMetadataKey("_private")).toBe(false);
      expect(isValidMetadataKey("key_name")).toBe(false);
    });

    it("should reject keys starting with digits", () => {
      expect(isValidMetadataKey("123note")).toBe(false);
      expect(isValidMetadataKey("1key")).toBe(false);
    });

    it("should reject empty key", () => {
      expect(isValidMetadataKey("")).toBe(false);
    });

    it("should reject keys with trailing hyphen", () => {
      expect(isValidMetadataKey("note-")).toBe(false);
      expect(isValidMetadataKey("model-name-")).toBe(false);
    });

    it("should reject trailing hyphen in any segment", () => {
      expect(isValidMetadataKey("tags.note-")).toBe(false);
      expect(isValidMetadataKey("note-.tags")).toBe(false);
    });

    it("should reject keys over 64 characters", () => {
      const longKey = "a".repeat(65);
      expect(isValidMetadataKey(longKey)).toBe(false);
    });

    it("should accept keys at exactly 64 characters", () => {
      const maxKey = "a".repeat(64);
      expect(isValidMetadataKey(maxKey)).toBe(true);
    });

    it("should reject keys with special characters (except dots)", () => {
      expect(isValidMetadataKey("key/name")).toBe(false);
      expect(isValidMetadataKey("key@name")).toBe(false);
      expect(isValidMetadataKey("key name")).toBe(false);
    });

    it("should reject keys starting with hyphen", () => {
      expect(isValidMetadataKey("-key")).toBe(false);
    });

    it("should reject leading, trailing, and consecutive dots", () => {
      expect(isValidMetadataKey(".foo")).toBe(false);
      expect(isValidMetadataKey("foo.")).toBe(false);
      expect(isValidMetadataKey("foo..bar")).toBe(false);
    });

    it("should reject segments starting with digits", () => {
      expect(isValidMetadataKey("tags.1fix")).toBe(false);
    });
  });
});

describe("TAGS_METADATA_KEY_PREFIX", () => {
  it("should be 'tags.'", () => {
    expect(TAGS_METADATA_KEY_PREFIX).toBe("tags.");
  });
});

describe("extractTags", () => {
  it("should return empty array for empty metadata", () => {
    expect(extractTags({})).toEqual([]);
  });

  it("should return empty array for metadata without tag entries", () => {
    expect(extractTags({ base: "main", note: "hello" })).toEqual([]);
  });

  it("should extract tag with color", () => {
    const metadata = { "tags.bugfix": '{"color":"#ff0000"}' };
    const tags = extractTags(metadata);
    expect(tags).toEqual([{ name: "bugfix", color: "#ff0000" }]);
  });

  it("should extract tag without color (empty object)", () => {
    const metadata = { "tags.wip": "{}" };
    const tags = extractTags(metadata);
    expect(tags).toEqual([{ name: "wip" }]);
  });

  it("should handle invalid JSON gracefully", () => {
    const metadata = { "tags.broken": "not-json" };
    const tags = extractTags(metadata);
    expect(tags).toEqual([{ name: "broken" }]);
  });

  it("should ignore non-string color values", () => {
    const metadata = { "tags.bad-color": '{"color":123}' };
    const tags = extractTags(metadata);
    expect(tags).toEqual([{ name: "bad-color" }]);
  });

  it("should extract multiple tags", () => {
    const metadata = {
      base: "main",
      "tags.bugfix": '{"color":"#ff0000"}',
      "tags.wip": "{}",
      note: "some note",
    };
    const tags = extractTags(metadata);
    expect(tags).toHaveLength(2);
    const names = tags.map((t: WorkspaceTag) => t.name).sort();
    expect(names).toEqual(["bugfix", "wip"]);
  });

  it("should skip 'tags.' key with empty name after prefix", () => {
    const metadata = { "tags.": "{}" };
    expect(extractTags(metadata)).toEqual([]);
  });
});
