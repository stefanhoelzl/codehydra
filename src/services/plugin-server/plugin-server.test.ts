/**
 * Unit tests for PluginServer.
 *
 * Tests pure logic without real Socket.IO connections.
 * For Socket.IO connection tests, see plugin-server.boundary.test.ts.
 */

import { describe, it, expect } from "vitest";
import {
  COMMAND_TIMEOUT_MS,
  normalizeWorkspacePath,
  isValidCommandRequest,
} from "../../shared/plugin-protocol";

describe("PluginServer", () => {
  describe("isValidCommandRequest", () => {
    it("returns true for valid object with command only", () => {
      expect(isValidCommandRequest({ command: "test.command" })).toBe(true);
    });

    it("returns true for valid object with command and args array", () => {
      expect(isValidCommandRequest({ command: "test.command", args: [1, "two", true] })).toBe(true);
    });

    it("returns true for valid object with empty args array", () => {
      expect(isValidCommandRequest({ command: "test.command", args: [] })).toBe(true);
    });

    it("returns false for object with non-string command", () => {
      expect(isValidCommandRequest({ command: 123 })).toBe(false);
      expect(isValidCommandRequest({ command: null })).toBe(false);
      expect(isValidCommandRequest({ command: undefined })).toBe(false);
      expect(isValidCommandRequest({ command: {} })).toBe(false);
    });

    it("returns false for object with non-array args", () => {
      expect(isValidCommandRequest({ command: "test.command", args: "not-array" })).toBe(false);
      expect(isValidCommandRequest({ command: "test.command", args: 123 })).toBe(false);
      expect(isValidCommandRequest({ command: "test.command", args: {} })).toBe(false);
    });

    it("returns false for null", () => {
      expect(isValidCommandRequest(null)).toBe(false);
    });

    it("returns false for undefined", () => {
      expect(isValidCommandRequest(undefined)).toBe(false);
    });

    it("returns false for non-object values", () => {
      expect(isValidCommandRequest("string")).toBe(false);
      expect(isValidCommandRequest(123)).toBe(false);
      expect(isValidCommandRequest(true)).toBe(false);
    });

    it("returns false for object missing command property", () => {
      expect(isValidCommandRequest({})).toBe(false);
      expect(isValidCommandRequest({ args: [] })).toBe(false);
      expect(isValidCommandRequest({ other: "value" })).toBe(false);
    });
  });

  describe("COMMAND_TIMEOUT_MS constant", () => {
    it("exports default timeout of 10 seconds", () => {
      expect(COMMAND_TIMEOUT_MS).toBe(10_000);
    });
  });

  describe("normalizeWorkspacePath", () => {
    it("normalizes path with trailing separator", () => {
      expect(normalizeWorkspacePath("/test/workspace/")).toBe("/test/workspace");
    });

    it("normalizes path with double separators", () => {
      expect(normalizeWorkspacePath("/test//workspace")).toBe("/test/workspace");
    });

    it("handles Windows-style paths", () => {
      // path.normalize converts backslashes to forward slashes on POSIX
      // but keeps them on Windows - we just verify it doesn't crash
      const result = normalizeWorkspacePath("C:\\Users\\test\\workspace");
      expect(result).toBeTruthy();
      expect(result.length).toBeGreaterThan(0);
    });

    it("handles empty string", () => {
      expect(normalizeWorkspacePath("")).toBe(".");
    });

    it("handles root path", () => {
      expect(normalizeWorkspacePath("/")).toBe("/");
    });

    it("handles relative path", () => {
      expect(normalizeWorkspacePath("relative/path")).toBe("relative/path");
    });
  });
});
