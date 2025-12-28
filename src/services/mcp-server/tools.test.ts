/**
 * Tests for MCP tools behavior.
 *
 * These tests verify the tool handler logic independently of the HTTP transport.
 * They use a simplified test harness that simulates tool invocation.
 */

import { describe, it, expect, vi } from "vitest";
import type { ICoreApi, IWorkspaceApi, IProjectApi } from "../../shared/api/interfaces";
import type { ProjectId, WorkspaceName, WorkspaceStatus } from "../../shared/api/types";
import type { ResolvedWorkspace, McpError } from "./types";
import type { Logger, LogContext } from "../logging";
import type { LogLevel } from "../logging/types";
import { createBehavioralLogger } from "../logging/logging.test-utils";

/**
 * Tool result type from MCP SDK.
 */
interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/**
 * Parse tool result data.
 */
function parseToolResult<T>(
  result: ToolResult
): { success: true; data: T } | { success: false; error: McpError } {
  const text = result.content[0]?.text;
  if (!text) {
    return { success: false, error: { code: "internal-error", message: "No content" } };
  }

  const parsed = JSON.parse(text) as T | { error: McpError } | null;

  // Check for error response (either via isError flag or error in parsed content)
  if (result.isError) {
    const errorData = parsed as { error: McpError } | null;
    return { success: false, error: errorData?.error ?? { code: "internal-error", message: text } };
  }

  // Check if parsed content has error property
  if (parsed && typeof parsed === "object" && "error" in parsed) {
    return { success: false, error: (parsed as { error: McpError }).error };
  }

  return { success: true, data: parsed as T };
}

/**
 * Create a mock IWorkspaceApi.
 */
function createMockWorkspaceApi(overrides?: Partial<IWorkspaceApi>): IWorkspaceApi {
  return {
    create: vi.fn().mockResolvedValue({
      name: "test" as WorkspaceName,
      path: "/path",
      branch: "main",
      metadata: { base: "main" },
      projectId: "test-12345678" as ProjectId,
    }),
    remove: vi.fn().mockResolvedValue({ started: true }),
    forceRemove: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(undefined),
    getStatus: vi
      .fn()
      .mockResolvedValue({ isDirty: false, agent: { type: "none" } } as WorkspaceStatus),
    getOpencodePort: vi.fn().mockResolvedValue(14001),
    setMetadata: vi.fn().mockResolvedValue(undefined),
    getMetadata: vi.fn().mockResolvedValue({ base: "main" }),
    executeCommand: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/**
 * Simulated tool handler context.
 */
interface SimulatedToolContext {
  resolved: ResolvedWorkspace | null;
  workspacePath: string;
}

/**
 * Simulate tool handlers for testing.
 * This mimics the tool registration logic from McpServer.
 */
function createToolHandlers(api: ICoreApi) {
  // Handle undefined specially since JSON.stringify(undefined) returns undefined (not a string)
  const successResult = <T>(data: T): ToolResult => ({
    content: [{ type: "text", text: data === undefined ? "null" : JSON.stringify(data) }],
  });

  const errorResult = (code: McpError["code"], message: string): ToolResult => ({
    content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }],
    isError: true,
  });

  const handleError = (error: unknown): ToolResult => {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult("internal-error", message);
  };

  return {
    workspace_get_status: async (context: SimulatedToolContext): Promise<ToolResult> => {
      if (!context.resolved) {
        return errorResult("workspace-not-found", `Workspace not found: ${context.workspacePath}`);
      }
      try {
        const status = await api.workspaces.getStatus(
          context.resolved.projectId,
          context.resolved.workspaceName
        );
        return successResult(status);
      } catch (error) {
        return handleError(error);
      }
    },

    workspace_get_metadata: async (context: SimulatedToolContext): Promise<ToolResult> => {
      if (!context.resolved) {
        return errorResult("workspace-not-found", `Workspace not found: ${context.workspacePath}`);
      }
      try {
        const metadata = await api.workspaces.getMetadata(
          context.resolved.projectId,
          context.resolved.workspaceName
        );
        return successResult(metadata);
      } catch (error) {
        return handleError(error);
      }
    },

    workspace_set_metadata: async (
      context: SimulatedToolContext,
      args: { key: string; value: string | null }
    ): Promise<ToolResult> => {
      if (!context.resolved) {
        return errorResult("workspace-not-found", `Workspace not found: ${context.workspacePath}`);
      }
      try {
        await api.workspaces.setMetadata(
          context.resolved.projectId,
          context.resolved.workspaceName,
          args.key,
          args.value
        );
        return successResult(null);
      } catch (error) {
        return handleError(error);
      }
    },

    workspace_get_opencode_port: async (context: SimulatedToolContext): Promise<ToolResult> => {
      if (!context.resolved) {
        return errorResult("workspace-not-found", `Workspace not found: ${context.workspacePath}`);
      }
      try {
        const port = await api.workspaces.getOpencodePort(
          context.resolved.projectId,
          context.resolved.workspaceName
        );
        return successResult(port);
      } catch (error) {
        return handleError(error);
      }
    },

    workspace_delete: async (
      context: SimulatedToolContext,
      args: { keepBranch?: boolean }
    ): Promise<ToolResult> => {
      if (!context.resolved) {
        return errorResult("workspace-not-found", `Workspace not found: ${context.workspacePath}`);
      }
      try {
        const result = await api.workspaces.remove(
          context.resolved.projectId,
          context.resolved.workspaceName,
          args.keepBranch ?? false
        );
        return successResult(result);
      } catch (error) {
        return handleError(error);
      }
    },

    workspace_execute_command: async (
      context: SimulatedToolContext,
      args: { command: string; args?: readonly unknown[] }
    ): Promise<ToolResult> => {
      if (!context.resolved) {
        return errorResult("workspace-not-found", `Workspace not found: ${context.workspacePath}`);
      }
      try {
        const result = await api.workspaces.executeCommand(
          context.resolved.projectId,
          context.resolved.workspaceName,
          args.command,
          args.args
        );
        return successResult(result);
      } catch (error) {
        return handleError(error);
      }
    },
  };
}

/**
 * Create log tool handler for testing.
 * This mimics the log tool registration logic from McpServer.
 */
function createLogToolHandler(logger: Logger) {
  const successResult = <T>(data: T): ToolResult => ({
    content: [{ type: "text", text: data === undefined ? "null" : JSON.stringify(data) }],
  });

  return {
    log: async (
      context: SimulatedToolContext,
      args: { level: LogLevel; message: string; context?: Record<string, unknown> }
    ): Promise<ToolResult> => {
      // Auto-append workspace context for traceability
      const logContext: LogContext = {
        ...((args.context as LogContext) ?? {}),
        workspace: context.workspacePath,
      };

      // Call appropriate logger method based on level
      const level = args.level;
      switch (level) {
        case "silly":
          logger.silly(args.message, logContext);
          break;
        case "debug":
          logger.debug(args.message, logContext);
          break;
        case "info":
          logger.info(args.message, logContext);
          break;
        case "warn":
          logger.warn(args.message, logContext);
          break;
        case "error":
          logger.error(args.message, logContext);
          break;
      }

      return successResult(null);
    },
  };
}

/**
 * Create a test context with resolved workspace.
 */
function createResolvedContext(): SimulatedToolContext {
  return {
    workspacePath: "/path/to/workspace",
    resolved: {
      projectId: "test-12345678" as ProjectId,
      workspaceName: "feature-branch" as WorkspaceName,
      workspacePath: "/path/to/workspace",
    },
  };
}

/**
 * Create a test context without resolved workspace.
 */
function createUnresolvedContext(): SimulatedToolContext {
  return {
    workspacePath: "/unknown/path",
    resolved: null,
  };
}

describe("MCP Tools", () => {
  describe("workspace_get_status", () => {
    it("returns correct status format on success", async () => {
      const expectedStatus: WorkspaceStatus = {
        isDirty: true,
        agent: { type: "busy", counts: { idle: 0, busy: 1, total: 1 } },
      };

      const workspaceApi = createMockWorkspaceApi({
        getStatus: vi.fn().mockResolvedValue(expectedStatus),
      });

      const api: ICoreApi = {
        workspaces: workspaceApi,
        projects: {} as IProjectApi,
        on: vi.fn().mockReturnValue(() => {}),
        dispose: vi.fn(),
      };

      const handlers = createToolHandlers(api);
      const context = createResolvedContext();

      const result = await handlers.workspace_get_status(context);
      const parsed = parseToolResult<WorkspaceStatus>(result);

      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.isDirty).toBe(true);
        expect(parsed.data.agent.type).toBe("busy");
      }
    });

    it("returns error when workspace not found", async () => {
      const api: ICoreApi = {
        workspaces: createMockWorkspaceApi(),
        projects: {} as IProjectApi,
        on: vi.fn().mockReturnValue(() => {}),
        dispose: vi.fn(),
      };

      const handlers = createToolHandlers(api);
      const context = createUnresolvedContext();

      const result = await handlers.workspace_get_status(context);
      const parsed = parseToolResult<WorkspaceStatus>(result);

      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.code).toBe("workspace-not-found");
      }
    });

    it("propagates API errors correctly", async () => {
      const workspaceApi = createMockWorkspaceApi({
        getStatus: vi.fn().mockRejectedValue(new Error("API error")),
      });

      const api: ICoreApi = {
        workspaces: workspaceApi,
        projects: {} as IProjectApi,
        on: vi.fn().mockReturnValue(() => {}),
        dispose: vi.fn(),
      };

      const handlers = createToolHandlers(api);
      const context = createResolvedContext();

      const result = await handlers.workspace_get_status(context);
      const parsed = parseToolResult<WorkspaceStatus>(result);

      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.code).toBe("internal-error");
        expect(parsed.error.message).toBe("API error");
      }
    });
  });

  describe("workspace_get_metadata", () => {
    it("returns metadata object on success", async () => {
      const expectedMetadata = { base: "main", note: "test workspace" };

      const workspaceApi = createMockWorkspaceApi({
        getMetadata: vi.fn().mockResolvedValue(expectedMetadata),
      });

      const api: ICoreApi = {
        workspaces: workspaceApi,
        projects: {} as IProjectApi,
        on: vi.fn().mockReturnValue(() => {}),
        dispose: vi.fn(),
      };

      const handlers = createToolHandlers(api);
      const context = createResolvedContext();

      const result = await handlers.workspace_get_metadata(context);
      const parsed = parseToolResult<Record<string, string>>(result);

      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.base).toBe("main");
        expect(parsed.data.note).toBe("test workspace");
      }
    });
  });

  describe("workspace_set_metadata", () => {
    it("sets metadata successfully", async () => {
      const setMetadataMock = vi.fn().mockResolvedValue(undefined);
      const workspaceApi = createMockWorkspaceApi({
        setMetadata: setMetadataMock,
      });

      const api: ICoreApi = {
        workspaces: workspaceApi,
        projects: {} as IProjectApi,
        on: vi.fn().mockReturnValue(() => {}),
        dispose: vi.fn(),
      };

      const handlers = createToolHandlers(api);
      const context = createResolvedContext();

      const result = await handlers.workspace_set_metadata(context, {
        key: "note",
        value: "test value",
      });
      const parsed = parseToolResult<null>(result);

      expect(parsed.success).toBe(true);
      expect(setMetadataMock).toHaveBeenCalledWith(
        context.resolved!.projectId,
        context.resolved!.workspaceName,
        "note",
        "test value"
      );
    });

    it("deletes metadata when value is null", async () => {
      const setMetadataMock = vi.fn().mockResolvedValue(undefined);
      const workspaceApi = createMockWorkspaceApi({
        setMetadata: setMetadataMock,
      });

      const api: ICoreApi = {
        workspaces: workspaceApi,
        projects: {} as IProjectApi,
        on: vi.fn().mockReturnValue(() => {}),
        dispose: vi.fn(),
      };

      const handlers = createToolHandlers(api);
      const context = createResolvedContext();

      await handlers.workspace_set_metadata(context, {
        key: "note",
        value: null,
      });

      expect(setMetadataMock).toHaveBeenCalledWith(
        context.resolved!.projectId,
        context.resolved!.workspaceName,
        "note",
        null
      );
    });

    it("propagates validation errors from API", async () => {
      const workspaceApi = createMockWorkspaceApi({
        setMetadata: vi.fn().mockRejectedValue(new Error("Invalid key format")),
      });

      const api: ICoreApi = {
        workspaces: workspaceApi,
        projects: {} as IProjectApi,
        on: vi.fn().mockReturnValue(() => {}),
        dispose: vi.fn(),
      };

      const handlers = createToolHandlers(api);
      const context = createResolvedContext();

      const result = await handlers.workspace_set_metadata(context, {
        key: "123invalid",
        value: "test",
      });
      const parsed = parseToolResult<null>(result);

      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.code).toBe("internal-error");
      }
    });
  });

  describe("workspace_get_opencode_port", () => {
    it("returns port number on success", async () => {
      const workspaceApi = createMockWorkspaceApi({
        getOpencodePort: vi.fn().mockResolvedValue(14001),
      });

      const api: ICoreApi = {
        workspaces: workspaceApi,
        projects: {} as IProjectApi,
        on: vi.fn().mockReturnValue(() => {}),
        dispose: vi.fn(),
      };

      const handlers = createToolHandlers(api);
      const context = createResolvedContext();

      const result = await handlers.workspace_get_opencode_port(context);
      const parsed = parseToolResult<number>(result);

      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data).toBe(14001);
      }
    });

    it("returns null when server not running", async () => {
      const workspaceApi = createMockWorkspaceApi({
        getOpencodePort: vi.fn().mockResolvedValue(null),
      });

      const api: ICoreApi = {
        workspaces: workspaceApi,
        projects: {} as IProjectApi,
        on: vi.fn().mockReturnValue(() => {}),
        dispose: vi.fn(),
      };

      const handlers = createToolHandlers(api);
      const context = createResolvedContext();

      const result = await handlers.workspace_get_opencode_port(context);
      const parsed = parseToolResult<number | null>(result);

      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data).toBeNull();
      }
    });
  });

  describe("workspace_delete", () => {
    it("calls API with correct params", async () => {
      const removeMock = vi.fn().mockResolvedValue({ started: true });
      const workspaceApi = createMockWorkspaceApi({
        remove: removeMock,
      });

      const api: ICoreApi = {
        workspaces: workspaceApi,
        projects: {} as IProjectApi,
        on: vi.fn().mockReturnValue(() => {}),
        dispose: vi.fn(),
      };

      const handlers = createToolHandlers(api);
      const context = createResolvedContext();

      const result = await handlers.workspace_delete(context, { keepBranch: false });
      const parsed = parseToolResult<{ started: boolean }>(result);

      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.started).toBe(true);
      }

      expect(removeMock).toHaveBeenCalledWith(
        context.resolved!.projectId,
        context.resolved!.workspaceName,
        false
      );
    });

    it("respects keepBranch option", async () => {
      const removeMock = vi.fn().mockResolvedValue({ started: true });
      const workspaceApi = createMockWorkspaceApi({
        remove: removeMock,
      });

      const api: ICoreApi = {
        workspaces: workspaceApi,
        projects: {} as IProjectApi,
        on: vi.fn().mockReturnValue(() => {}),
        dispose: vi.fn(),
      };

      const handlers = createToolHandlers(api);
      const context = createResolvedContext();

      await handlers.workspace_delete(context, { keepBranch: true });

      expect(removeMock).toHaveBeenCalledWith(
        context.resolved!.projectId,
        context.resolved!.workspaceName,
        true
      );
    });

    it("defaults keepBranch to false", async () => {
      const removeMock = vi.fn().mockResolvedValue({ started: true });
      const workspaceApi = createMockWorkspaceApi({
        remove: removeMock,
      });

      const api: ICoreApi = {
        workspaces: workspaceApi,
        projects: {} as IProjectApi,
        on: vi.fn().mockReturnValue(() => {}),
        dispose: vi.fn(),
      };

      const handlers = createToolHandlers(api);
      const context = createResolvedContext();

      await handlers.workspace_delete(context, {});

      expect(removeMock).toHaveBeenCalledWith(
        context.resolved!.projectId,
        context.resolved!.workspaceName,
        false
      );
    });
  });

  describe("workspace_execute_command", () => {
    it("returns command result on success", async () => {
      const executeCommandMock = vi.fn().mockResolvedValue("command result");
      const workspaceApi = createMockWorkspaceApi({
        executeCommand: executeCommandMock,
      });

      const api: ICoreApi = {
        workspaces: workspaceApi,
        projects: {} as IProjectApi,
        on: vi.fn().mockReturnValue(() => {}),
        dispose: vi.fn(),
      };

      const handlers = createToolHandlers(api);
      const context = createResolvedContext();

      const result = await handlers.workspace_execute_command(context, {
        command: "test.command",
      });
      const parsed = parseToolResult<unknown>(result);

      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data).toBe("command result");
      }
    });

    it("returns null for commands that return null", async () => {
      const executeCommandMock = vi.fn().mockResolvedValue(null);
      const workspaceApi = createMockWorkspaceApi({
        executeCommand: executeCommandMock,
      });

      const api: ICoreApi = {
        workspaces: workspaceApi,
        projects: {} as IProjectApi,
        on: vi.fn().mockReturnValue(() => {}),
        dispose: vi.fn(),
      };

      const handlers = createToolHandlers(api);
      const context = createResolvedContext();

      const result = await handlers.workspace_execute_command(context, {
        command: "workbench.action.files.saveAll",
      });
      const parsed = parseToolResult<unknown>(result);

      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data).toBeNull();
      }
    });

    it("handles undefined result correctly (converts to null string)", async () => {
      // Most VS Code commands return undefined - verify the result has a valid string text field
      const executeCommandMock = vi.fn().mockResolvedValue(undefined);
      const workspaceApi = createMockWorkspaceApi({
        executeCommand: executeCommandMock,
      });

      const api: ICoreApi = {
        workspaces: workspaceApi,
        projects: {} as IProjectApi,
        on: vi.fn().mockReturnValue(() => {}),
        dispose: vi.fn(),
      };

      const handlers = createToolHandlers(api);
      const context = createResolvedContext();

      const result = await handlers.workspace_execute_command(context, {
        command: "workbench.action.files.saveAll",
      });

      // Verify the result structure
      expect(result.content).toHaveLength(1);

      // Verify the text field is a valid string (not undefined)
      // This is the critical fix: JSON.stringify(undefined) returns undefined,
      // but MCP requires the text field to be a string
      const text = result.content[0]?.text;
      expect(text).toBe("null");
      expect(typeof text).toBe("string");

      // Verify it can be parsed as valid JSON
      const parsed = parseToolResult<unknown>(result);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data).toBeNull();
      }
    });

    it("passes command and args to API", async () => {
      const executeCommandMock = vi.fn().mockResolvedValue(undefined);
      const workspaceApi = createMockWorkspaceApi({
        executeCommand: executeCommandMock,
      });

      const api: ICoreApi = {
        workspaces: workspaceApi,
        projects: {} as IProjectApi,
        on: vi.fn().mockReturnValue(() => {}),
        dispose: vi.fn(),
      };

      const handlers = createToolHandlers(api);
      const context = createResolvedContext();

      await handlers.workspace_execute_command(context, {
        command: "vscode.open",
        args: ["/path/to/file", { preview: true }],
      });

      expect(executeCommandMock).toHaveBeenCalledWith(
        context.resolved!.projectId,
        context.resolved!.workspaceName,
        "vscode.open",
        ["/path/to/file", { preview: true }]
      );
    });

    it("returns error when workspace not found", async () => {
      const api: ICoreApi = {
        workspaces: createMockWorkspaceApi(),
        projects: {} as IProjectApi,
        on: vi.fn().mockReturnValue(() => {}),
        dispose: vi.fn(),
      };

      const handlers = createToolHandlers(api);
      const context = createUnresolvedContext();

      const result = await handlers.workspace_execute_command(context, {
        command: "test.command",
      });
      const parsed = parseToolResult<unknown>(result);

      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.code).toBe("workspace-not-found");
      }
    });

    it("propagates API errors correctly", async () => {
      const executeCommandMock = vi
        .fn()
        .mockRejectedValue(new Error("Command not found: invalid.command"));
      const workspaceApi = createMockWorkspaceApi({
        executeCommand: executeCommandMock,
      });

      const api: ICoreApi = {
        workspaces: workspaceApi,
        projects: {} as IProjectApi,
        on: vi.fn().mockReturnValue(() => {}),
        dispose: vi.fn(),
      };

      const handlers = createToolHandlers(api);
      const context = createResolvedContext();

      const result = await handlers.workspace_execute_command(context, {
        command: "invalid.command",
      });
      const parsed = parseToolResult<unknown>(result);

      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.code).toBe("internal-error");
        expect(parsed.error.message).toBe("Command not found: invalid.command");
      }
    });

    it("propagates timeout errors correctly", async () => {
      const executeCommandMock = vi.fn().mockRejectedValue(new Error("Command timed out"));
      const workspaceApi = createMockWorkspaceApi({
        executeCommand: executeCommandMock,
      });

      const api: ICoreApi = {
        workspaces: workspaceApi,
        projects: {} as IProjectApi,
        on: vi.fn().mockReturnValue(() => {}),
        dispose: vi.fn(),
      };

      const handlers = createToolHandlers(api);
      const context = createResolvedContext();

      const result = await handlers.workspace_execute_command(context, {
        command: "slow.command",
      });
      const parsed = parseToolResult<unknown>(result);

      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.code).toBe("internal-error");
        expect(parsed.error.message).toBe("Command timed out");
      }
    });
  });

  describe("log", () => {
    it("logs info level message with workspace context", async () => {
      const logger = createBehavioralLogger();
      const handler = createLogToolHandler(logger);
      const context = createResolvedContext();

      const result = await handler.log(context, {
        level: "info",
        message: "Test message",
      });
      const parsed = parseToolResult<null>(result);

      expect(parsed.success).toBe(true);

      const messages = logger.getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        level: "info",
        message: "Test message",
      });
      expect(messages[0]?.context?.workspace).toBe(context.workspacePath);
    });

    it("logs all levels correctly", async () => {
      const logger = createBehavioralLogger();
      const handler = createLogToolHandler(logger);
      const context = createResolvedContext();

      const levels: LogLevel[] = ["silly", "debug", "info", "warn", "error"];

      for (const level of levels) {
        await handler.log(context, { level, message: `${level} message` });
      }

      for (const level of levels) {
        const messages = logger.getMessagesByLevel(level);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({
          level,
          message: `${level} message`,
        });
      }
    });

    it("preserves context and adds workspace", async () => {
      const logger = createBehavioralLogger();
      const handler = createLogToolHandler(logger);
      const context = createResolvedContext();

      await handler.log(context, {
        level: "debug",
        message: "Test",
        context: { key: "value", count: 42 },
      });

      const messages = logger.getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]?.context).toEqual({
        key: "value",
        count: 42,
        workspace: context.workspacePath,
      });
    });

    it("returns success result immediately", async () => {
      const logger = createBehavioralLogger();
      const handler = createLogToolHandler(logger);
      const context = createResolvedContext();

      const result = await handler.log(context, {
        level: "info",
        message: "Test",
      });
      const parsed = parseToolResult<null>(result);

      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data).toBeNull();
      }
    });
  });
});
