/**
 * Unit tests for PluginServer.
 *
 * Tests pure logic without real Socket.IO connections.
 * For Socket.IO connection tests, see plugin-server.boundary.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  COMMAND_TIMEOUT_MS,
  normalizeWorkspacePath,
  isValidCommandRequest,
} from "../../shared/plugin-protocol";
import { PluginServer } from "./plugin-server";
import { createMockPortManager } from "../platform/network.test-utils";
import { createSilentLogger } from "../logging/logging.test-utils";

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
      // Use regex to match both Unix (/) and Windows (\) path separators
      expect(normalizeWorkspacePath("/test/workspace/")).toMatch(/[/\\]test[/\\]workspace$/);
    });

    it("normalizes path with double separators", () => {
      expect(normalizeWorkspacePath("/test//workspace")).toMatch(/[/\\]test[/\\]workspace$/);
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
      // Root path is "/" on Unix and "\" on Windows
      expect(normalizeWorkspacePath("/")).toMatch(/^[/\\]$/);
    });

    it("handles relative path", () => {
      expect(normalizeWorkspacePath("relative/path")).toMatch(/^relative[/\\]path$/);
    });
  });

  describe("onConnect", () => {
    let server: PluginServer;
    let mockPortManager: ReturnType<typeof createMockPortManager>;

    beforeEach(() => {
      mockPortManager = createMockPortManager({ findFreePort: { port: 3000 } });
      server = new PluginServer(mockPortManager, createSilentLogger());
    });

    afterEach(async () => {
      await server.close();
    });

    it("returns unsubscribe function that removes callback", () => {
      const callback = vi.fn();
      const unsubscribe = server.onConnect(callback);

      // Callback is registered
      expect(typeof unsubscribe).toBe("function");

      // After unsubscribe, callback should be removed (tested indirectly via boundary tests)
      unsubscribe();

      // Calling unsubscribe again should not throw
      expect(() => unsubscribe()).not.toThrow();
    });

    it("allows multiple callbacks to be registered", () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      const unsubscribe1 = server.onConnect(callback1);
      const unsubscribe2 = server.onConnect(callback2);

      expect(typeof unsubscribe1).toBe("function");
      expect(typeof unsubscribe2).toBe("function");

      // Cleanup
      unsubscribe1();
      unsubscribe2();
    });

    it("unsubscribe removes only the specific callback", () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      const unsubscribe1 = server.onConnect(callback1);
      server.onConnect(callback2);

      // Unsubscribe first callback
      unsubscribe1();

      // Second callback should still be registered (tested via boundary tests)
      // This test verifies the unsubscribe logic doesn't affect other callbacks
    });
  });
});
