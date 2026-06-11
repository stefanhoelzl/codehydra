/**
 * Unit tests for plugin protocol types and validators.
 */

import { describe, it, expect } from "vitest";
import {
  validateSetMetadataRequest,
  validateExecuteCommandRequest,
  validateOpenSystemPathRequest,
  validateWorkspaceCreateRequest,
  validateDeleteWorkspaceRequest,
  validateGetWorkspaceStatusRequest,
  validateAgentLifecycleRequest,
  validateLogRequest,
  COMMAND_TIMEOUT_MS,
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
      expect(result).toEqual({ valid: false, error: "Request must be an object" });
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
      const result = validateSetMetadataRequest({ key: "my@key", value: "test" });
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

describe("validateWorkspaceCreateRequest", () => {
  describe("valid requests", () => {
    it("accepts name and base", () => {
      const result = validateWorkspaceCreateRequest({ name: "feature-x", base: "main" });
      expect(result).toEqual({ valid: true });
    });

    it("accepts string initialPrompt", () => {
      const result = validateWorkspaceCreateRequest({
        name: "feature-x",
        base: "main",
        initialPrompt: "Implement the feature",
      });
      expect(result).toEqual({ valid: true });
    });

    it("accepts whitespace-only initialPrompt string (no trim, by design)", () => {
      const result = validateWorkspaceCreateRequest({
        name: "feature-x",
        base: "main",
        initialPrompt: "   ",
      });
      expect(result).toEqual({ valid: true });
    });

    it("accepts initialPrompt object with agent and model", () => {
      const result = validateWorkspaceCreateRequest({
        name: "feature-x",
        base: "main",
        initialPrompt: {
          prompt: "Implement the feature",
          agentName: "build",
          model: { providerID: "anthropic", modelID: "claude-sonnet" },
        },
        stealFocus: false,
      });
      expect(result).toEqual({ valid: true });
    });
  });

  describe("invalid requests", () => {
    it("rejects non-object payload", () => {
      expect(validateWorkspaceCreateRequest(null)).toEqual({
        valid: false,
        error: "Request must be an object",
      });
    });

    it("rejects missing name", () => {
      const result = validateWorkspaceCreateRequest({ base: "main" });
      expect(result).toEqual({ valid: false, error: "Missing required field: name" });
    });

    it("rejects empty base", () => {
      const result = validateWorkspaceCreateRequest({ name: "feature-x", base: "  " });
      expect(result).toEqual({ valid: false, error: "Field 'base' cannot be empty" });
    });

    it("rejects empty initialPrompt string", () => {
      const result = validateWorkspaceCreateRequest({
        name: "feature-x",
        base: "main",
        initialPrompt: "",
      });
      expect(result).toEqual({
        valid: false,
        error: "Field 'initialPrompt' must be a non-empty string or a prompt object",
      });
    });

    it("rejects initialPrompt object without prompt", () => {
      const result = validateWorkspaceCreateRequest({
        name: "feature-x",
        base: "main",
        initialPrompt: { agentName: "build" },
      });
      expect(result).toEqual({
        valid: false,
        error: "Field 'initialPrompt' must be a non-empty string or a prompt object",
      });
    });

    it("rejects malformed initialPrompt model", () => {
      const result = validateWorkspaceCreateRequest({
        name: "feature-x",
        base: "main",
        initialPrompt: { prompt: "Implement", model: { providerID: "anthropic" } },
      });
      expect(result).toEqual({
        valid: false,
        error: "Field 'initialPrompt' must be a non-empty string or a prompt object",
      });
    });

    it("rejects non-boolean stealFocus", () => {
      const result = validateWorkspaceCreateRequest({
        name: "feature-x",
        base: "main",
        stealFocus: "yes",
      });
      expect(result).toEqual({ valid: false, error: "Field 'stealFocus' must be a boolean" });
    });
  });
});

describe("validateDeleteWorkspaceRequest", () => {
  it("normalizes undefined and null to an empty request", () => {
    expect(validateDeleteWorkspaceRequest(undefined)).toEqual({ valid: true, request: {} });
    expect(validateDeleteWorkspaceRequest(null)).toEqual({ valid: true, request: {} });
  });

  it("passes keepBranch through", () => {
    expect(validateDeleteWorkspaceRequest({ keepBranch: true })).toEqual({
      valid: true,
      request: { keepBranch: true },
    });
  });

  it("rejects non-boolean keepBranch", () => {
    expect(validateDeleteWorkspaceRequest({ keepBranch: "yes" })).toEqual({
      valid: false,
      error: "Field 'keepBranch' must be a boolean",
    });
  });

  it("rejects non-object payload", () => {
    expect(validateDeleteWorkspaceRequest("delete")).toEqual({
      valid: false,
      error: "Request must be an object",
    });
  });
});

describe("validateGetWorkspaceStatusRequest", () => {
  it("normalizes undefined and null to an empty request", () => {
    expect(validateGetWorkspaceStatusRequest(undefined)).toEqual({ valid: true, request: {} });
    expect(validateGetWorkspaceStatusRequest(null)).toEqual({ valid: true, request: {} });
  });

  it("passes refresh through and strips explicit undefined", () => {
    expect(validateGetWorkspaceStatusRequest({ refresh: true })).toEqual({
      valid: true,
      request: { refresh: true },
    });
    expect(validateGetWorkspaceStatusRequest({ refresh: undefined })).toEqual({
      valid: true,
      request: {},
    });
  });

  it("rejects non-boolean refresh", () => {
    expect(validateGetWorkspaceStatusRequest({ refresh: 1 })).toEqual({
      valid: false,
      error: "Field 'refresh' must be a boolean",
    });
  });
});

describe("validateAgentLifecycleRequest", () => {
  it("accepts open and close events", () => {
    expect(validateAgentLifecycleRequest({ event: "open" })).toEqual({ valid: true });
    expect(validateAgentLifecycleRequest({ event: "close" })).toEqual({ valid: true });
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
