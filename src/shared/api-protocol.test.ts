/**
 * Unit tests for API protocol types and validators.
 */

import { describe, it, expect } from "vitest";
import {
  validateOpenSystemPathRequest,
  validateAgentLifecycleRequest,
  validateLogRequest,
  COMMAND_TIMEOUT_MS,
  type ServerToClientEvents,
} from "./api-protocol";

describe("validateOpenSystemPathRequest", () => {
  describe("valid requests", () => {
    it("accepts explorer action with path", () => {
      const result = validateOpenSystemPathRequest({ app: "explorer", path: "/project/src" });
      expect(result).toEqual({ valid: true });
    });

    it("accepts default action with path", () => {
      const result = validateOpenSystemPathRequest({ app: "default", path: "/project/file.txt" });
      expect(result).toEqual({ valid: true });
    });
  });

  describe("invalid requests - structure", () => {
    it("rejects null payload", () => {
      const result = validateOpenSystemPathRequest(null);
      expect(result).toEqual({ valid: false, error: "Request must be an object" });
    });

    it("rejects undefined payload", () => {
      const result = validateOpenSystemPathRequest(undefined);
      expect(result).toEqual({ valid: false, error: "Request must be an object" });
    });

    it("rejects primitive values", () => {
      expect(validateOpenSystemPathRequest("string")).toEqual({
        valid: false,
        error: "Request must be an object",
      });
    });
  });

  describe("invalid requests - app field", () => {
    it("rejects missing app field", () => {
      const result = validateOpenSystemPathRequest({ path: "/some/path" });
      expect(result).toEqual({ valid: false, error: "Missing required field: app" });
    });

    it("rejects invalid app value", () => {
      const result = validateOpenSystemPathRequest({ app: "invalid", path: "/some/path" });
      expect(result).toEqual({
        valid: false,
        error: "Field 'app' must be 'default' or 'explorer'",
      });
    });
  });

  describe("invalid requests - path field", () => {
    it("rejects missing path field", () => {
      const result = validateOpenSystemPathRequest({ app: "explorer" });
      expect(result).toEqual({ valid: false, error: "Missing required field: path" });
    });

    it("rejects non-string path", () => {
      const result = validateOpenSystemPathRequest({ app: "explorer", path: 123 });
      expect(result).toEqual({ valid: false, error: "Field 'path' must be a string" });
    });

    it("rejects empty path string", () => {
      const result = validateOpenSystemPathRequest({ app: "explorer", path: "" });
      expect(result).toEqual({ valid: false, error: "Field 'path' cannot be empty" });
    });

    it("rejects whitespace-only path", () => {
      const result = validateOpenSystemPathRequest({ app: "explorer", path: "   " });
      expect(result).toEqual({ valid: false, error: "Field 'path' cannot be empty" });
    });
  });
});

describe("validateAgentLifecycleRequest", () => {
  it("accepts open and close events", () => {
    expect(validateAgentLifecycleRequest({ event: "open" })).toEqual({ valid: true });
    expect(validateAgentLifecycleRequest({ event: "close" })).toEqual({ valid: true });
    expect(validateAgentLifecycleRequest({ event: "close", pid: 42 })).toEqual({ valid: true });
  });

  it("accepts the shell's pid, which must come with one", () => {
    expect(validateAgentLifecycleRequest({ event: "pid", pid: 42 })).toEqual({ valid: true });
    expect(validateAgentLifecycleRequest({ event: "pid" })).toEqual({
      valid: false,
      error: "Missing required field: pid",
    });
    expect(validateAgentLifecycleRequest({ event: "pid", pid: -1 }).valid).toBe(false);
  });

  it("rejects unknown events with the received value", () => {
    expect(validateAgentLifecycleRequest({ event: "pause" })).toEqual({
      valid: false,
      error: "Invalid agent lifecycle event: pause",
    });
  });

  it("rejects missing event", () => {
    expect(validateAgentLifecycleRequest({})).toEqual({
      valid: false,
      error: "Missing required field: event",
    });
  });

  it("rejects non-object payload", () => {
    expect(validateAgentLifecycleRequest(null)).toEqual({
      valid: false,
      error: "Request must be an object",
    });
  });
});

describe("COMMAND_TIMEOUT_MS constant", () => {
  it("exports default timeout of 10 seconds", () => {
    expect(COMMAND_TIMEOUT_MS).toBe(10_000);
  });
});

describe("shutdown event signature", () => {
  it("accepts correct callback type", () => {
    // Type-level test: verify the shutdown event signature compiles correctly
    // This test validates that the ServerToClientEvents interface has the correct type
    const mockHandler: ServerToClientEvents["shutdown"] = (ack) => {
      // ack should accept ApiResult<void>
      ack({ success: true, data: undefined });
      ack({ success: false, error: "test error" });
    };

    // The test passes if TypeScript compiles without errors
    expect(typeof mockHandler).toBe("function");
  });

  it("ack callback matches ApiResult<void> type", () => {
    // Verify the ack callback type is compatible with ApiResult<void>
    type ShutdownAck = Parameters<ServerToClientEvents["shutdown"]>[0];
    type AckParam = Parameters<ShutdownAck>[0];

    // These assignments should compile - they verify type compatibility
    const successResult: AckParam = { success: true, data: undefined };
    const errorResult: AckParam = { success: false, error: "error message" };

    expect(successResult.success).toBe(true);
    expect(errorResult.success).toBe(false);
  });
});

describe("validateLogRequest", () => {
  describe("valid requests", () => {
    it("accepts valid log request with message only", () => {
      const result = validateLogRequest({ level: "info", message: "test message" });
      expect(result).toEqual({ valid: true });
    });

    it("accepts log request with context", () => {
      const result = validateLogRequest({
        level: "debug",
        message: "test message",
        context: { key: "value" },
      });
      expect(result).toEqual({ valid: true });
    });

    it("accepts log request with multi-key context", () => {
      const result = validateLogRequest({
        level: "info",
        message: "test",
        context: { k1: "v1", k2: 123, k3: true, k4: null },
      });
      expect(result).toEqual({ valid: true });
    });

    it("accepts log request with empty context", () => {
      const result = validateLogRequest({
        level: "info",
        message: "test",
        context: {},
      });
      expect(result).toEqual({ valid: true });
    });

    it("accepts context with null value (valid)", () => {
      const result = validateLogRequest({
        level: "info",
        message: "test",
        context: { key: null },
      });
      expect(result).toEqual({ valid: true });
    });

    it.each(["silly", "debug", "info", "warn", "error"])("accepts valid log level: %s", (level) => {
      const result = validateLogRequest({ level, message: "test" });
      expect(result).toEqual({ valid: true });
    });
  });

  describe("invalid requests - level", () => {
    it("rejects invalid level", () => {
      const result = validateLogRequest({ level: "invalid", message: "test" });
      expect(result.valid).toBe(false);
      expect((result as { error: string }).error).toContain("Invalid log level");
    });

    it("rejects missing level", () => {
      const result = validateLogRequest({ message: "test" });
      expect(result).toEqual({ valid: false, error: "Missing required field: level" });
    });

    it("rejects non-string level", () => {
      const result = validateLogRequest({ level: 123, message: "test" });
      expect(result).toEqual({ valid: false, error: "Invalid log level: 123" });
    });
  });

  describe("invalid requests - message", () => {
    it("rejects missing message", () => {
      const result = validateLogRequest({ level: "info" });
      expect(result).toEqual({ valid: false, error: "Missing required field: message" });
    });

    it("rejects empty message string", () => {
      const result = validateLogRequest({ level: "info", message: "" });
      expect(result).toEqual({ valid: false, error: "Field 'message' cannot be empty" });
    });

    it("rejects non-string message", () => {
      const result = validateLogRequest({ level: "info", message: 123 });
      expect(result).toEqual({ valid: false, error: "Field 'message' must be a string" });
    });
  });

  describe("invalid requests - context", () => {
    it("rejects invalid context type (string)", () => {
      const result = validateLogRequest({
        level: "info",
        message: "test",
        context: "not-object",
      });
      expect(result).toEqual({ valid: false, error: "Field 'context' must be an object" });
    });

    it("rejects invalid context value (function)", () => {
      const result = validateLogRequest({
        level: "info",
        message: "test",
        context: { fn: () => {} },
      });
      expect(result).toEqual({
        valid: false,
        error: "Field 'context.fn' must be a string, number, boolean, or null",
      });
    });

    it("rejects invalid context value (nested object)", () => {
      const result = validateLogRequest({
        level: "info",
        message: "test",
        context: { nested: { deep: 1 } },
      });
      expect(result).toEqual({
        valid: false,
        error: "Field 'context.nested' must be a string, number, boolean, or null",
      });
    });

    it("rejects invalid context value (array)", () => {
      const result = validateLogRequest({
        level: "info",
        message: "test",
        context: { arr: [1, 2] },
      });
      expect(result).toEqual({
        valid: false,
        error: "Field 'context.arr' must be a string, number, boolean, or null",
      });
    });
  });

  describe("invalid requests - structure", () => {
    it("rejects null payload", () => {
      const result = validateLogRequest(null);
      expect(result).toEqual({ valid: false, error: "Request must be an object" });
    });

    it("rejects undefined payload", () => {
      const result = validateLogRequest(undefined);
      expect(result).toEqual({ valid: false, error: "Request must be an object" });
    });

    it("rejects primitive values", () => {
      expect(validateLogRequest("string")).toEqual({
        valid: false,
        error: "Request must be an object",
      });
      expect(validateLogRequest(123)).toEqual({
        valid: false,
        error: "Request must be an object",
      });
    });
  });
});

describe("UI event signatures", () => {
  it("showNotification event accepts correct types", () => {
    const mockHandler: ServerToClientEvents["ui:showNotification"] = (_request, ack) => {
      ack({ success: true, data: { action: null } });
      ack({ success: true, data: { action: "Yes" } });
    };
    expect(typeof mockHandler).toBe("function");
  });

  it("statusBarUpdate event accepts correct types", () => {
    const mockHandler: ServerToClientEvents["ui:statusBarUpdate"] = (_request, ack) => {
      ack({ success: true, data: undefined });
      ack({ success: false, error: "test error" });
    };
    expect(typeof mockHandler).toBe("function");
  });

  it("statusBarDispose event accepts correct types", () => {
    const mockHandler: ServerToClientEvents["ui:statusBarDispose"] = (_request, ack) => {
      ack({ success: true, data: undefined });
      ack({ success: false, error: "test error" });
    };
    expect(typeof mockHandler).toBe("function");
  });

  it("showQuickPick event accepts correct types", () => {
    const mockHandler: ServerToClientEvents["ui:showQuickPick"] = (_request, ack) => {
      ack({ success: true, data: { selected: null } });
      ack({ success: true, data: { selected: "Option 1" } });
    };
    expect(typeof mockHandler).toBe("function");
  });

  it("showInputBox event accepts correct types", () => {
    const mockHandler: ServerToClientEvents["ui:showInputBox"] = (_request, ack) => {
      ack({ success: true, data: { value: null } });
      ack({ success: true, data: { value: "user input" } });
    };
    expect(typeof mockHandler).toBe("function");
  });
});

// Note: normalizeWorkspacePath was removed.
// Path normalization is now handled by the Path class (services/platform/path.ts)
// which is tested in path.test.ts
