/**
 * Tests for API type definitions.
 * Includes compile-time type safety checks and runtime type guard validation.
 */
import { describe, it, expect } from "vitest";
import {
  type ProjectId,
  type WorkspaceName,
  isProjectId,
  isWorkspaceName,
  validateWorkspaceName,
  isValidMetadataKey,
  METADATA_KEY_REGEX,
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

describe("isProjectId - Type Guard", () => {
  describe("valid project IDs", () => {
    it("should accept standard format: name-hash8", () => {
      expect(isProjectId("my-app-12345678")).toBe(true);
    });

    it("should accept uppercase letters in name", () => {
      expect(isProjectId("MyApp-abcdef12")).toBe(true);
    });

    it("should accept numbers in name", () => {
      expect(isProjectId("app123-deadbeef")).toBe(true);
    });

    it("should accept single character name", () => {
      expect(isProjectId("a-12345678")).toBe(true);
    });

    it("should accept long name", () => {
      expect(isProjectId("very-long-project-name-12345678")).toBe(true);
    });

    it("should accept multiple dashes in name", () => {
      expect(isProjectId("my-cool-app-fedcba98")).toBe(true);
    });
  });

  describe("invalid project IDs", () => {
    it("should reject empty string", () => {
      expect(isProjectId("")).toBe(false);
    });

    it("should reject string without hash suffix", () => {
      expect(isProjectId("my-app")).toBe(false);
    });

    it("should reject hash with wrong length (too short)", () => {
      expect(isProjectId("my-app-1234567")).toBe(false);
    });

    it("should reject hash with wrong length (too long)", () => {
      expect(isProjectId("my-app-123456789")).toBe(false);
    });

    it("should reject non-hex characters in hash", () => {
      expect(isProjectId("my-app-1234567g")).toBe(false);
    });

    it("should reject special characters in name", () => {
      expect(isProjectId("my_app-12345678")).toBe(false);
      expect(isProjectId("my.app-12345678")).toBe(false);
      expect(isProjectId("my/app-12345678")).toBe(false);
    });

    it("should reject name starting with dash", () => {
      expect(isProjectId("-my-app-12345678")).toBe(false);
    });

    it("should reject spaces", () => {
      expect(isProjectId("my app-12345678")).toBe(false);
    });
  });

  describe("type narrowing", () => {
    it("should narrow type when guard returns true", () => {
      const value = "my-app-12345678";
      if (isProjectId(value)) {
        // TypeScript should now see this as ProjectId
        const id: ProjectId = value;
        expect(id).toBe(value);
      }
    });
  });
});

describe("isWorkspaceName - Type Guard", () => {
  describe("valid workspace names", () => {
    it("should accept simple alphanumeric name", () => {
      expect(isWorkspaceName("feature1")).toBe(true);
    });

    it("should accept name with dashes", () => {
      expect(isWorkspaceName("feature-branch")).toBe(true);
    });

    it("should accept name with underscores", () => {
      expect(isWorkspaceName("feature_branch")).toBe(true);
    });

    it("should accept name with dots", () => {
      expect(isWorkspaceName("release.1.0")).toBe(true);
    });

    it("should accept name with forward slashes (for branch names)", () => {
      expect(isWorkspaceName("feature/login")).toBe(true);
    });

    it("should accept single character", () => {
      expect(isWorkspaceName("a")).toBe(true);
    });

    it("should accept name starting with number", () => {
      expect(isWorkspaceName("1-hotfix")).toBe(true);
    });

    it("should accept 100 character name (max length)", () => {
      const longName = "a".repeat(100);
      expect(isWorkspaceName(longName)).toBe(true);
    });
  });

  describe("invalid workspace names", () => {
    it("should reject empty string", () => {
      expect(isWorkspaceName("")).toBe(false);
    });

    it("should reject name exceeding 100 characters", () => {
      const tooLong = "a".repeat(101);
      expect(isWorkspaceName(tooLong)).toBe(false);
    });

    it("should reject name starting with dash", () => {
      expect(isWorkspaceName("-feature")).toBe(false);
    });

    it("should reject name starting with underscore", () => {
      expect(isWorkspaceName("_feature")).toBe(false);
    });

    it("should reject name starting with dot", () => {
      expect(isWorkspaceName(".feature")).toBe(false);
    });

    it("should reject name starting with forward slash", () => {
      expect(isWorkspaceName("/feature")).toBe(false);
    });

    it("should reject spaces", () => {
      expect(isWorkspaceName("my feature")).toBe(false);
    });

    it("should reject special characters", () => {
      expect(isWorkspaceName("feature@branch")).toBe(false);
      expect(isWorkspaceName("feature#1")).toBe(false);
      expect(isWorkspaceName("feature$1")).toBe(false);
    });

    it("should reject names containing double dots", () => {
      expect(isWorkspaceName("a..b")).toBe(false);
      expect(isWorkspaceName("..foo")).toBe(false);
    });

    it("should reject names containing backslash", () => {
      expect(isWorkspaceName("feature\\branch")).toBe(false);
    });
  });

  describe("type narrowing", () => {
    it("should narrow type when guard returns true", () => {
      const value = "feature-branch";
      if (isWorkspaceName(value)) {
        // TypeScript should now see this as WorkspaceName
        const name: WorkspaceName = value;
        expect(name).toBe(value);
      }
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

    it("should reject keys over 64 characters", () => {
      const longKey = "a".repeat(65);
      expect(isValidMetadataKey(longKey)).toBe(false);
    });

    it("should accept keys at exactly 64 characters", () => {
      const maxKey = "a".repeat(64);
      expect(isValidMetadataKey(maxKey)).toBe(true);
    });

    it("should reject keys with special characters", () => {
      expect(isValidMetadataKey("key.name")).toBe(false);
      expect(isValidMetadataKey("key/name")).toBe(false);
      expect(isValidMetadataKey("key@name")).toBe(false);
      expect(isValidMetadataKey("key name")).toBe(false);
    });

    it("should reject keys starting with hyphen", () => {
      expect(isValidMetadataKey("-key")).toBe(false);
    });
  });
});
