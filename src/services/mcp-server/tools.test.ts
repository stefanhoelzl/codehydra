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
  const successResult = <T>(data: T): ToolResult => ({
    content: [{ type: "text", text: JSON.stringify(data) }],
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
});
