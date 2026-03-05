/**
 * Tests for MCP tools behavior.
 *
 * These tests verify the tool handler logic independently of the HTTP transport.
 * They use a simplified test harness that simulates tool invocation.
 */

import { describe, it, expect, vi } from "vitest";
import type { WorkspaceStatus } from "../../shared/api/types";
import type { McpApiHandlers, McpError } from "./types";
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
 * Simulated tool handler context.
 * After the workspace registry removal, only workspacePath is needed.
 */
interface SimulatedToolContext {
  workspacePath: string;
}

/**
 * Create mock McpApiHandlers with sensible defaults.
 */
function createMockHandlers(overrides?: Partial<McpApiHandlers>): McpApiHandlers {
  return {
    getStatus: vi
      .fn()
      .mockResolvedValue({ isDirty: false, unmergedCommits: 0, agent: { type: "none" } }),
    getMetadata: vi.fn().mockResolvedValue({ base: "main" }),
    setMetadata: vi.fn().mockResolvedValue(undefined),
    getAgentSession: vi.fn().mockResolvedValue(null),
    restartAgentServer: vi.fn().mockResolvedValue(14001),
    listProjects: vi.fn().mockResolvedValue([]),
    createWorkspace: vi.fn().mockResolvedValue({ name: "test", path: "/path" }),
    deleteWorkspace: vi.fn().mockResolvedValue({ started: true }),
    executeCommand: vi.fn().mockResolvedValue(undefined),
    showNotification: vi.fn().mockResolvedValue({ action: null }),
    updateStatusBar: vi.fn().mockResolvedValue(undefined),
    disposeStatusBar: vi.fn().mockResolvedValue(undefined),
    showQuickPick: vi.fn().mockResolvedValue({ selected: null }),
    showInputBox: vi.fn().mockResolvedValue({ value: null }),
    ...overrides,
  };
}

/**
 * Simulate tool handlers for testing.
 * This mimics the tool registration logic from McpServer.
 * Tools now call flat McpApiHandlers methods.
 */
function createToolHandlers(handlers: McpApiHandlers) {
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
      if (!context.workspacePath) {
        return errorResult("workspace-not-found", "Missing workspace path");
      }
      try {
        const status = await handlers.getStatus(context.workspacePath);
        return successResult(status);
      } catch (error) {
        return handleError(error);
      }
    },

    workspace_get_metadata: async (context: SimulatedToolContext): Promise<ToolResult> => {
      if (!context.workspacePath) {
        return errorResult("workspace-not-found", "Missing workspace path");
      }
      try {
        const metadata = await handlers.getMetadata(context.workspacePath);
        return successResult(metadata);
      } catch (error) {
        return handleError(error);
      }
    },

    workspace_set_metadata: async (
      context: SimulatedToolContext,
      args: { key: string; value: string | null }
    ): Promise<ToolResult> => {
      if (!context.workspacePath) {
        return errorResult("workspace-not-found", "Missing workspace path");
      }
      try {
        await handlers.setMetadata(context.workspacePath, args.key, args.value);
        return successResult(null);
      } catch (error) {
        return handleError(error);
      }
    },

    workspace_get_agent_session: async (context: SimulatedToolContext): Promise<ToolResult> => {
      if (!context.workspacePath) {
        return errorResult("workspace-not-found", "Missing workspace path");
      }
      try {
        const session = await handlers.getAgentSession(context.workspacePath);
        return successResult(session);
      } catch (error) {
        return handleError(error);
      }
    },

    workspace_delete: async (
      context: SimulatedToolContext,
      args: { keepBranch?: boolean }
    ): Promise<ToolResult> => {
      if (!context.workspacePath) {
        return errorResult("workspace-not-found", "Missing workspace path");
      }
      try {
        const result = await handlers.deleteWorkspace(context.workspacePath, {
          keepBranch: args.keepBranch ?? false,
        });
        return successResult(result);
      } catch (error) {
        return handleError(error);
      }
    },

    workspace_execute_command: async (
      context: SimulatedToolContext,
      args: { command: string; args?: readonly unknown[] }
    ): Promise<ToolResult> => {
      if (!context.workspacePath) {
        return errorResult("workspace-not-found", "Missing workspace path");
      }
      try {
        const result = await handlers.executeCommand(
          context.workspacePath,
          args.command,
          args.args
        );
        return successResult(result);
      } catch (error) {
        return handleError(error);
      }
    },

    project_list: async (): Promise<ToolResult> => {
      try {
        const projects = await handlers.listProjects();
        return successResult(projects);
      } catch (error) {
        return handleError(error);
      }
    },

    workspace_create: async (
      _context: SimulatedToolContext,
      args: { projectPath: string; name: string; base: string; stealFocus?: boolean }
    ): Promise<ToolResult> => {
      try {
        const result = await handlers.createWorkspace({
          projectPath: args.projectPath,
          name: args.name,
          base: args.base,
          stealFocus: args.stealFocus ?? false,
        });
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
 * Create a test context with a valid workspace path.
 */
function createContext(): SimulatedToolContext {
  return {
    workspacePath: "/path/to/workspace",
  };
}

/**
 * Create a test context with an empty workspace path (simulates missing header).
 */
function createEmptyContext(): SimulatedToolContext {
  return {
    workspacePath: "",
  };
}

describe("MCP Tools", () => {
  describe("workspace_get_status", () => {
    it("returns correct status format on success", async () => {
      const expectedStatus: WorkspaceStatus = {
        isDirty: true,
        unmergedCommits: 0,
        agent: { type: "busy", counts: { idle: 0, busy: 1, total: 1 } },
      };

      const mockHandlers = createMockHandlers({
        getStatus: vi.fn().mockResolvedValue(expectedStatus),
      });

      const toolHandlers = createToolHandlers(mockHandlers);
      const context = createContext();

      const result = await toolHandlers.workspace_get_status(context);
      const parsed = parseToolResult<WorkspaceStatus>(result);

      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.isDirty).toBe(true);
        expect(parsed.data.agent.type).toBe("busy");
      }
    });

    it("returns error when workspace not found", async () => {
      const mockHandlers = createMockHandlers();
      const toolHandlers = createToolHandlers(mockHandlers);
      const context = createEmptyContext();

      const result = await toolHandlers.workspace_get_status(context);
      const parsed = parseToolResult<WorkspaceStatus>(result);

      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.code).toBe("workspace-not-found");
      }
    });

    it("propagates API errors correctly", async () => {
      const mockHandlers = createMockHandlers({
        getStatus: vi.fn().mockRejectedValue(new Error("API error")),
      });

      const toolHandlers = createToolHandlers(mockHandlers);
      const context = createContext();

      const result = await toolHandlers.workspace_get_status(context);
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

      const mockHandlers = createMockHandlers({
        getMetadata: vi.fn().mockResolvedValue(expectedMetadata),
      });

      const toolHandlers = createToolHandlers(mockHandlers);
      const context = createContext();

      const result = await toolHandlers.workspace_get_metadata(context);
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
      const mockHandlers = createMockHandlers({
        setMetadata: setMetadataMock,
      });

      const toolHandlers = createToolHandlers(mockHandlers);
      const context = createContext();

      const result = await toolHandlers.workspace_set_metadata(context, {
        key: "note",
        value: "test value",
      });
      const parsed = parseToolResult<null>(result);

      expect(parsed.success).toBe(true);
      expect(setMetadataMock).toHaveBeenCalledWith(context.workspacePath, "note", "test value");
    });

    it("deletes metadata when value is null", async () => {
      const setMetadataMock = vi.fn().mockResolvedValue(undefined);
      const mockHandlers = createMockHandlers({
        setMetadata: setMetadataMock,
      });

      const toolHandlers = createToolHandlers(mockHandlers);
      const context = createContext();

      await toolHandlers.workspace_set_metadata(context, {
        key: "note",
        value: null,
      });

      expect(setMetadataMock).toHaveBeenCalledWith(context.workspacePath, "note", null);
    });

    it("propagates validation errors from API", async () => {
      const mockHandlers = createMockHandlers({
        setMetadata: vi.fn().mockRejectedValue(new Error("Invalid key format")),
      });

      const toolHandlers = createToolHandlers(mockHandlers);
      const context = createContext();

      const result = await toolHandlers.workspace_set_metadata(context, {
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

  describe("workspace_get_agent_session", () => {
    it("returns session info on success", async () => {
      const mockHandlers = createMockHandlers({
        getAgentSession: vi.fn().mockResolvedValue({ port: 14001, sessionId: "test-session-id" }),
      });

      const toolHandlers = createToolHandlers(mockHandlers);
      const context = createContext();

      const result = await toolHandlers.workspace_get_agent_session(context);
      const parsed = parseToolResult<{ port: number; sessionId: string }>(result);

      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data).toEqual({ port: 14001, sessionId: "test-session-id" });
      }
    });

    it("returns null when server not running", async () => {
      const mockHandlers = createMockHandlers({
        getAgentSession: vi.fn().mockResolvedValue(null),
      });

      const toolHandlers = createToolHandlers(mockHandlers);
      const context = createContext();

      const result = await toolHandlers.workspace_get_agent_session(context);
      const parsed = parseToolResult<{ port: number; sessionId: string } | null>(result);

      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data).toBeNull();
      }
    });
  });

  describe("workspace_delete", () => {
    it("calls handler with correct params", async () => {
      const deleteWorkspaceMock = vi.fn().mockResolvedValue({ started: true });
      const mockHandlers = createMockHandlers({
        deleteWorkspace: deleteWorkspaceMock,
      });

      const toolHandlers = createToolHandlers(mockHandlers);
      const context = createContext();

      const result = await toolHandlers.workspace_delete(context, { keepBranch: false });
      const parsed = parseToolResult<{ started: boolean }>(result);

      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.started).toBe(true);
      }

      expect(deleteWorkspaceMock).toHaveBeenCalledWith(context.workspacePath, {
        keepBranch: false,
      });
    });

    it("respects keepBranch option", async () => {
      const deleteWorkspaceMock = vi.fn().mockResolvedValue({ started: true });
      const mockHandlers = createMockHandlers({
        deleteWorkspace: deleteWorkspaceMock,
      });

      const toolHandlers = createToolHandlers(mockHandlers);
      const context = createContext();

      await toolHandlers.workspace_delete(context, { keepBranch: true });

      expect(deleteWorkspaceMock).toHaveBeenCalledWith(context.workspacePath, {
        keepBranch: true,
      });
    });

    it("defaults keepBranch to false", async () => {
      const deleteWorkspaceMock = vi.fn().mockResolvedValue({ started: true });
      const mockHandlers = createMockHandlers({
        deleteWorkspace: deleteWorkspaceMock,
      });

      const toolHandlers = createToolHandlers(mockHandlers);
      const context = createContext();

      await toolHandlers.workspace_delete(context, {});

      expect(deleteWorkspaceMock).toHaveBeenCalledWith(context.workspacePath, {
        keepBranch: false,
      });
    });
  });

  describe("workspace_execute_command", () => {
    it("returns command result on success", async () => {
      const mockHandlers = createMockHandlers({
        executeCommand: vi.fn().mockResolvedValue("command result"),
      });

      const toolHandlers = createToolHandlers(mockHandlers);
      const context = createContext();

      const result = await toolHandlers.workspace_execute_command(context, {
        command: "test.command",
      });
      const parsed = parseToolResult<unknown>(result);

      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data).toBe("command result");
      }
    });

    it("returns null for commands that return null", async () => {
      const mockHandlers = createMockHandlers({
        executeCommand: vi.fn().mockResolvedValue(null),
      });

      const toolHandlers = createToolHandlers(mockHandlers);
      const context = createContext();

      const result = await toolHandlers.workspace_execute_command(context, {
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
      const mockHandlers = createMockHandlers({
        executeCommand: vi.fn().mockResolvedValue(undefined),
      });

      const toolHandlers = createToolHandlers(mockHandlers);
      const context = createContext();

      const result = await toolHandlers.workspace_execute_command(context, {
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

    it("passes command and args to handler", async () => {
      const executeCommandMock = vi.fn().mockResolvedValue(undefined);
      const mockHandlers = createMockHandlers({
        executeCommand: executeCommandMock,
      });

      const toolHandlers = createToolHandlers(mockHandlers);
      const context = createContext();

      await toolHandlers.workspace_execute_command(context, {
        command: "vscode.open",
        args: ["/path/to/file", { preview: true }],
      });

      expect(executeCommandMock).toHaveBeenCalledWith(context.workspacePath, "vscode.open", [
        "/path/to/file",
        { preview: true },
      ]);
    });

    it("returns error when workspace not found", async () => {
      const mockHandlers = createMockHandlers();
      const toolHandlers = createToolHandlers(mockHandlers);
      const context = createEmptyContext();

      const result = await toolHandlers.workspace_execute_command(context, {
        command: "test.command",
      });
      const parsed = parseToolResult<unknown>(result);

      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.code).toBe("workspace-not-found");
      }
    });

    it("propagates API errors correctly", async () => {
      const mockHandlers = createMockHandlers({
        executeCommand: vi.fn().mockRejectedValue(new Error("Command not found: invalid.command")),
      });

      const toolHandlers = createToolHandlers(mockHandlers);
      const context = createContext();

      const result = await toolHandlers.workspace_execute_command(context, {
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
      const mockHandlers = createMockHandlers({
        executeCommand: vi.fn().mockRejectedValue(new Error("Command timed out")),
      });

      const toolHandlers = createToolHandlers(mockHandlers);
      const context = createContext();

      const result = await toolHandlers.workspace_execute_command(context, {
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

  describe("project_list", () => {
    it("returns projects from handler", async () => {
      const mockProjects = [
        { id: "proj-1", name: "my-project", path: "/projects/my-project", workspaces: [] },
      ];
      const mockHandlers = createMockHandlers({
        listProjects: vi.fn().mockResolvedValue(mockProjects),
      });

      const toolHandlers = createToolHandlers(mockHandlers);

      const result = await toolHandlers.project_list();
      const parsed = parseToolResult<typeof mockProjects>(result);

      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data).toEqual(mockProjects);
      }
    });

    it("returns empty array when no projects open", async () => {
      const mockHandlers = createMockHandlers();
      const toolHandlers = createToolHandlers(mockHandlers);

      const result = await toolHandlers.project_list();
      const parsed = parseToolResult<unknown[]>(result);

      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data).toEqual([]);
      }
    });

    it("propagates errors", async () => {
      const mockHandlers = createMockHandlers({
        listProjects: vi.fn().mockRejectedValue(new Error("List failed")),
      });
      const toolHandlers = createToolHandlers(mockHandlers);

      const result = await toolHandlers.project_list();
      const parsed = parseToolResult<unknown>(result);

      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.code).toBe("internal-error");
      }
    });
  });

  describe("workspace_create", () => {
    it("calls handler with projectPath", async () => {
      const mockWorkspace = { name: "feature", path: "/workspaces/feature" };
      const createMock = vi.fn().mockResolvedValue(mockWorkspace);
      const mockHandlers = createMockHandlers({ createWorkspace: createMock });
      const toolHandlers = createToolHandlers(mockHandlers);
      const context = createContext();

      const result = await toolHandlers.workspace_create(context, {
        projectPath: "/projects/my-project",
        name: "feature",
        base: "main",
      });
      const parsed = parseToolResult<typeof mockWorkspace>(result);

      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data).toEqual(mockWorkspace);
      }
      expect(createMock).toHaveBeenCalledWith({
        projectPath: "/projects/my-project",
        name: "feature",
        base: "main",
        stealFocus: false,
      });
    });

    it("passes stealFocus when provided", async () => {
      const createMock = vi.fn().mockResolvedValue({ name: "ws", path: "/ws" });
      const mockHandlers = createMockHandlers({ createWorkspace: createMock });
      const toolHandlers = createToolHandlers(mockHandlers);
      const context = createContext();

      await toolHandlers.workspace_create(context, {
        projectPath: "/projects/my-project",
        name: "ws",
        base: "main",
        stealFocus: true,
      });

      expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ stealFocus: true }));
    });

    it("propagates errors", async () => {
      const mockHandlers = createMockHandlers({
        createWorkspace: vi.fn().mockRejectedValue(new Error("Create failed")),
      });
      const toolHandlers = createToolHandlers(mockHandlers);
      const context = createContext();

      const result = await toolHandlers.workspace_create(context, {
        projectPath: "/projects/my-project",
        name: "ws",
        base: "main",
      });
      const parsed = parseToolResult<unknown>(result);

      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.code).toBe("internal-error");
      }
    });
  });

  describe("log", () => {
    it("logs info level message with workspace context", async () => {
      const logger = createBehavioralLogger();
      const handler = createLogToolHandler(logger);
      const context = createContext();

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
      const context = createContext();

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
      const context = createContext();

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
      const context = createContext();

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
