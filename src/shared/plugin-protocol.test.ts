/**
 * Unit tests for plugin protocol types and validators.
 */

import { describe, it, expect } from "vitest";
import {
  validateSetMetadataRequest,
  validateExecuteCommandRequest,
  validateLogRequest,
  COMMAND_TIMEOUT_MS,
  SHUTDOWN_DISCONNECT_TIMEOUT_MS,
  type ServerToClientEvents,
} from "./plugin-protocol";

describe("validateSetMetadataRequest", () => {
  describe("valid requests", () => {
    it("accepts valid key with string value", () => {
      const result = validateSetMetadataRequest({ key: "note", value: "test value" });
      expect(result).toEqual({ valid: true });
    });

    it("accepts valid key with null value (delete)", () => {
      const result = validateSetMetadataRequest({ key: "note", value: null });
      expect(result).toEqual({ valid: true });
    });

    it("accepts alphanumeric key with hyphens", () => {
      const result = validateSetMetadataRequest({ key: "model-name", value: "gpt-4" });
      expect(result).toEqual({ valid: true });
    });

    it("accepts key starting with uppercase", () => {
      const result = validateSetMetadataRequest({ key: "MyKey", value: "value" });
      expect(result).toEqual({ valid: true });
    });

    it("accepts empty string value", () => {
      const result = validateSetMetadataRequest({ key: "note", value: "" });
      expect(result).toEqual({ valid: true });
    });
  });

  describe("invalid requests - structure", () => {
    it("rejects null payload", () => {
      const result = validateSetMetadataRequest(null);
      expect(result).toEqual({ valid: false, error: "Request must be an object" });
    });

    it("rejects undefined payload", () => {
      const result = validateSetMetadataRequest(undefined);
      expect(result).toEqual({ valid: false, error: "Request must be an object" });
    });

    it("rejects primitive values", () => {
      expect(validateSetMetadataRequest("string")).toEqual({
        valid: false,
        error: "Request must be an object",
      });
      expect(validateSetMetadataRequest(123)).toEqual({
        valid: false,
        error: "Request must be an object",
      });
      expect(validateSetMetadataRequest(true)).toEqual({
        valid: false,
        error: "Request must be an object",
      });
    });

    it("rejects array payload", () => {
      const result = validateSetMetadataRequest([]);
      expect(result).toEqual({ valid: false, error: "Missing required field: key" });
    });
  });

  describe("invalid requests - missing fields", () => {
    it("rejects missing key field", () => {
      const result = validateSetMetadataRequest({ value: "test" });
      expect(result).toEqual({ valid: false, error: "Missing required field: key" });
    });

    it("rejects missing value field", () => {
      const result = validateSetMetadataRequest({ key: "note" });
      expect(result).toEqual({ valid: false, error: "Missing required field: value" });
    });

    it("rejects empty object", () => {
      const result = validateSetMetadataRequest({});
      expect(result).toEqual({ valid: false, error: "Missing required field: key" });
    });
  });

  describe("invalid requests - wrong types", () => {
    it("rejects non-string key", () => {
      expect(validateSetMetadataRequest({ key: 123, value: "test" })).toEqual({
        valid: false,
        error: "Field 'key' must be a string",
      });
      expect(validateSetMetadataRequest({ key: null, value: "test" })).toEqual({
        valid: false,
        error: "Field 'key' must be a string",
      });
      expect(validateSetMetadataRequest({ key: {}, value: "test" })).toEqual({
        valid: false,
        error: "Field 'key' must be a string",
      });
    });

    it("rejects non-string/null value", () => {
      expect(validateSetMetadataRequest({ key: "note", value: 123 })).toEqual({
        valid: false,
        error: "Field 'value' must be a string or null",
      });
      expect(validateSetMetadataRequest({ key: "note", value: {} })).toEqual({
        valid: false,
        error: "Field 'value' must be a string or null",
      });
      expect(validateSetMetadataRequest({ key: "note", value: [] })).toEqual({
        valid: false,
        error: "Field 'value' must be a string or null",
      });
      expect(validateSetMetadataRequest({ key: "note", value: true })).toEqual({
        valid: false,
        error: "Field 'value' must be a string or null",
      });
    });
  });

  describe("invalid requests - key format", () => {
    it("rejects empty key", () => {
      const result = validateSetMetadataRequest({ key: "", value: "test" });
      expect(result).toEqual({ valid: false, error: "Field 'key' cannot be empty" });
    });

    it("rejects key starting with digit", () => {
      const result = validateSetMetadataRequest({ key: "123note", value: "test" });
      expect(result.valid).toBe(false);
      expect(result).toHaveProperty("error");
      expect((result as { error: string }).error).toContain("Invalid key format");
    });

    it("rejects key starting with underscore", () => {
      const result = validateSetMetadataRequest({ key: "_private", value: "test" });
      expect(result.valid).toBe(false);
      expect((result as { error: string }).error).toContain("Invalid key format");
    });

    it("rejects key with underscore", () => {
      const result = validateSetMetadataRequest({ key: "my_key", value: "test" });
      expect(result.valid).toBe(false);
      expect((result as { error: string }).error).toContain("Invalid key format");
    });

    it("rejects key ending with hyphen", () => {
      const result = validateSetMetadataRequest({ key: "note-", value: "test" });
      expect(result.valid).toBe(false);
      expect((result as { error: string }).error).toContain("Invalid key format");
    });

    it("rejects key with special characters", () => {
      const result = validateSetMetadataRequest({ key: "my.key", value: "test" });
      expect(result.valid).toBe(false);
      expect((result as { error: string }).error).toContain("Invalid key format");
    });
  });
});

describe("validateExecuteCommandRequest", () => {
  describe("valid requests", () => {
    it("accepts valid command string", () => {
      const result = validateExecuteCommandRequest({ command: "workbench.action.files.save" });
      expect(result).toEqual({ valid: true });
    });

    it("accepts command with empty args array", () => {
      const result = validateExecuteCommandRequest({
        command: "workbench.action.files.save",
        args: [],
      });
      expect(result).toEqual({ valid: true });
    });

    it("accepts command with args array containing values", () => {
      const result = validateExecuteCommandRequest({
        command: "vscode.openFolder",
        args: ["/path/to/folder", { forceNewWindow: true }],
      });
      expect(result).toEqual({ valid: true });
    });
  });

  describe("invalid requests - structure", () => {
    it("rejects null payload", () => {
      const result = validateExecuteCommandRequest(null);
      expect(result).toEqual({ valid: false, error: "Request must be an object" });
    });

    it("rejects undefined payload", () => {
      const result = validateExecuteCommandRequest(undefined);
      expect(result).toEqual({ valid: false, error: "Request must be an object" });
    });

    it("rejects primitive values", () => {
      expect(validateExecuteCommandRequest("string")).toEqual({
        valid: false,
        error: "Request must be an object",
      });
      expect(validateExecuteCommandRequest(123)).toEqual({
        valid: false,
        error: "Request must be an object",
      });
    });
  });

  describe("invalid requests - missing command", () => {
    it("rejects missing command field", () => {
      const result = validateExecuteCommandRequest({});
      expect(result).toEqual({ valid: false, error: "Missing required field: command" });
    });

    it("rejects object with only args", () => {
      const result = validateExecuteCommandRequest({ args: [] });
      expect(result).toEqual({ valid: false, error: "Missing required field: command" });
    });
  });

  describe("invalid requests - wrong types", () => {
    it("rejects non-string command", () => {
      expect(validateExecuteCommandRequest({ command: 123 })).toEqual({
        valid: false,
        error: "Field 'command' must be a string",
      });
      expect(validateExecuteCommandRequest({ command: null })).toEqual({
        valid: false,
        error: "Field 'command' must be a string",
      });
      expect(validateExecuteCommandRequest({ command: {} })).toEqual({
        valid: false,
        error: "Field 'command' must be a string",
      });
    });

    it("rejects non-array args", () => {
      expect(validateExecuteCommandRequest({ command: "test.command", args: "not-array" })).toEqual(
        {
          valid: false,
          error: "Field 'args' must be an array",
        }
      );
      expect(validateExecuteCommandRequest({ command: "test.command", args: 123 })).toEqual({
        valid: false,
        error: "Field 'args' must be an array",
      });
      expect(validateExecuteCommandRequest({ command: "test.command", args: {} })).toEqual({
        valid: false,
        error: "Field 'args' must be an array",
      });
    });
  });

  describe("invalid requests - empty command", () => {
    it("rejects empty command string", () => {
      const result = validateExecuteCommandRequest({ command: "" });
      expect(result).toEqual({ valid: false, error: "Field 'command' cannot be empty" });
    });

    it("rejects whitespace-only command", () => {
      const result = validateExecuteCommandRequest({ command: "   " });
      expect(result).toEqual({ valid: false, error: "Field 'command' cannot be empty" });
    });

    it("rejects command with only tabs", () => {
      const result = validateExecuteCommandRequest({ command: "\t\t" });
      expect(result).toEqual({ valid: false, error: "Field 'command' cannot be empty" });
    });
  });
});

describe("COMMAND_TIMEOUT_MS constant", () => {
  it("exports default timeout of 10 seconds", () => {
    expect(COMMAND_TIMEOUT_MS).toBe(10_000);
  });
});

describe("SHUTDOWN_DISCONNECT_TIMEOUT_MS constant", () => {
  it("exports default timeout of 5 seconds", () => {
    expect(SHUTDOWN_DISCONNECT_TIMEOUT_MS).toBe(5_000);
  });
});

describe("shutdown event signature", () => {
  it("accepts correct callback type", () => {
    // Type-level test: verify the shutdown event signature compiles correctly
    // This test validates that the ServerToClientEvents interface has the correct type
    const mockHandler: ServerToClientEvents["shutdown"] = (ack) => {
      // ack should accept PluginResult<void>
      ack({ success: true, data: undefined });
      ack({ success: false, error: "test error" });
    };

    // The test passes if TypeScript compiles without errors
    expect(typeof mockHandler).toBe("function");
  });

  it("ack callback matches PluginResult<void> type", () => {
    // Verify the ack callback type is compatible with PluginResult<void>
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
      expect(result).toEqual({ valid: false, error: "Field 'level' must be a string" });
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
      expect(result.valid).toBe(false);
      expect((result as { error: string }).error).toContain("Invalid context value type");
      expect((result as { error: string }).error).toContain("function");
    });

    it("rejects invalid context value (nested object)", () => {
      const result = validateLogRequest({
        level: "info",
        message: "test",
        context: { nested: { deep: 1 } },
      });
      expect(result.valid).toBe(false);
      expect((result as { error: string }).error).toContain("Invalid context value type");
      expect((result as { error: string }).error).toContain("object");
    });

    it("rejects invalid context value (array)", () => {
      const result = validateLogRequest({
        level: "info",
        message: "test",
        context: { arr: [1, 2] },
      });
      expect(result.valid).toBe(false);
      expect((result as { error: string }).error).toContain("Invalid context value type");
      expect((result as { error: string }).error).toContain("array");
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

// Note: normalizeWorkspacePath was removed.
// Path normalization is now handled by the Path class (services/platform/path.ts)
// which is tested in path.test.ts
