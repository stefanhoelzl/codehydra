// @vitest-environment node
/**
 * Focused tests for findMatchingSession utility function.
 *
 * Tests the pure logic of session matching:
 * - Filters by directory match
 * - Excludes sub-agent sessions (parentID)
 * - Returns most recently updated session
 * - Handles edge cases (missing time, equal time, empty array)
 */

import { describe, it, expect } from "vitest";
import { findMatchingSession } from "./session-utils";
import type { Session } from "./types";

describe("findMatchingSession", () => {
  describe("filters by directory match", () => {
    it("returns session matching directory", () => {
      const sessions: Session[] = [
        { id: "ses-1", directory: "/foo/bar", time: { updated: 1000 } },
        { id: "ses-2", directory: "/other/dir", time: { updated: 2000 } },
      ];

      const result = findMatchingSession(sessions, "/foo/bar");

      expect(result).not.toBeNull();
      expect(result!.id).toBe("ses-1");
    });

    it("returns null when no match", () => {
      const sessions: Session[] = [{ id: "ses-1", directory: "/foo/bar", time: { updated: 1000 } }];

      const result = findMatchingSession(sessions, "/other/path");

      expect(result).toBeNull();
    });

    it("handles empty sessions array", () => {
      const result = findMatchingSession([], "/foo/bar");

      expect(result).toBeNull();
    });

    it("handles session with missing directory", () => {
      const sessions = [
        { id: "ses-1", directory: "", time: { updated: 1000 } } as Session,
        { id: "ses-2", directory: "/foo/bar", time: { updated: 500 } },
      ];

      const result = findMatchingSession(sessions, "/foo/bar");

      expect(result).not.toBeNull();
      expect(result!.id).toBe("ses-2");
    });
  });

  describe("excludes sub-agents", () => {
    it("excludes sessions with parentID", () => {
      const sessions: Session[] = [
        { id: "ses-parent", directory: "/foo/bar", time: { updated: 1000 } },
        { id: "ses-child", directory: "/foo/bar", parentID: "ses-parent", time: { updated: 2000 } },
      ];

      const result = findMatchingSession(sessions, "/foo/bar");

      expect(result).not.toBeNull();
      expect(result!.id).toBe("ses-parent");
    });

    it("returns null when all sessions have parentID", () => {
      const sessions: Session[] = [
        { id: "ses-1", directory: "/foo/bar", parentID: "parent", time: { updated: 1000 } },
        { id: "ses-2", directory: "/foo/bar", parentID: "parent", time: { updated: 2000 } },
      ];

      const result = findMatchingSession(sessions, "/foo/bar");

      expect(result).toBeNull();
    });

    it("treats missing parentID as root session (not a sub-agent)", () => {
      const sessions: Session[] = [{ id: "ses-1", directory: "/foo/bar", time: { updated: 1000 } }];

      const result = findMatchingSession(sessions, "/foo/bar");

      expect(result).not.toBeNull();
      expect(result!.id).toBe("ses-1");
    });

    it("treats null parentID as root session (not a sub-agent)", () => {
      const sessions: Session[] = [
        { id: "ses-1", directory: "/foo/bar", parentID: null, time: { updated: 1000 } },
      ];

      const result = findMatchingSession(sessions, "/foo/bar");

      expect(result).not.toBeNull();
      expect(result!.id).toBe("ses-1");
    });
  });

  describe("returns most recent match", () => {
    it("returns session with highest time.updated", () => {
      const sessions: Session[] = [
        { id: "ses-old", directory: "/foo/bar", time: { updated: 1000 } },
        { id: "ses-new", directory: "/foo/bar", time: { updated: 3000 } },
        { id: "ses-mid", directory: "/foo/bar", time: { updated: 2000 } },
      ];

      const result = findMatchingSession(sessions, "/foo/bar");

      expect(result).not.toBeNull();
      expect(result!.id).toBe("ses-new");
    });

    it("returns first session when time.updated values are equal", () => {
      const sessions: Session[] = [
        { id: "ses-first", directory: "/foo/bar", time: { updated: 1000 } },
        { id: "ses-second", directory: "/foo/bar", time: { updated: 1000 } },
      ];

      const result = findMatchingSession(sessions, "/foo/bar");

      expect(result).not.toBeNull();
      expect(result!.id).toBe("ses-first");
    });
  });

  describe("handles missing time.updated", () => {
    it("treats missing time as 0", () => {
      const sessions = [
        { id: "ses-no-time", directory: "/foo/bar" } as Session,
        { id: "ses-with-time", directory: "/foo/bar", time: { updated: 1000 } },
      ];

      const result = findMatchingSession(sessions, "/foo/bar");

      expect(result).not.toBeNull();
      expect(result!.id).toBe("ses-with-time");
    });

    it("treats undefined time.updated as 0", () => {
      const sessions = [
        { id: "ses-undefined", directory: "/foo/bar", time: {} } as Session,
        { id: "ses-defined", directory: "/foo/bar", time: { updated: 1000 } },
      ];

      const result = findMatchingSession(sessions, "/foo/bar");

      expect(result).not.toBeNull();
      expect(result!.id).toBe("ses-defined");
    });
  });

  describe.skipIf(process.platform !== "win32")("cross-platform path matching (Windows)", () => {
    it("matches C:/foo with C:\\foo", () => {
      const sessions: Session[] = [
        { id: "ses-1", directory: "C:/Users/test/project", time: { updated: 1000 } },
      ];

      const result = findMatchingSession(sessions, "C:\\Users\\test\\project");

      expect(result).not.toBeNull();
      expect(result!.id).toBe("ses-1");
    });

    it("matches case-insensitively on Windows", () => {
      const sessions: Session[] = [
        { id: "ses-1", directory: "C:/USERS/TEST/PROJECT", time: { updated: 1000 } },
      ];

      const result = findMatchingSession(sessions, "c:/users/test/project");

      expect(result).not.toBeNull();
      expect(result!.id).toBe("ses-1");
    });
  });

  describe("handles invalid input", () => {
    it("returns null for invalid directory", () => {
      const sessions: Session[] = [{ id: "ses-1", directory: "/foo/bar", time: { updated: 1000 } }];

      // Relative path is invalid for Path class
      const result = findMatchingSession(sessions, "relative/path");

      expect(result).toBeNull();
    });

    it("returns null for non-array input", () => {
      // TypeScript wouldn't allow this, but at runtime it could happen
      const result = findMatchingSession(null as unknown as Session[], "/foo/bar");

      expect(result).toBeNull();
    });
  });
});
