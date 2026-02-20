/**
 * Unit tests for MCP Server.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  McpServer,
  createDefaultMcpServer,
  SERVER_INSTRUCTIONS,
  type McpServerFactory,
} from "./mcp-server";
import type { ICoreApi, IWorkspaceApi, IProjectApi } from "../../shared/api/interfaces";
import { type ProjectId, initialPromptSchema } from "../../shared/api/types";
import { createMockLogger } from "../logging";

/**
 * Create a mock ICoreApi for testing.
 */
function createMockCoreApi(overrides?: {
  workspaces?: Partial<IWorkspaceApi>;
  projects?: Partial<IProjectApi>;
}): ICoreApi {
  const defaultWorkspaces: IWorkspaceApi = {
    create: vi.fn().mockResolvedValue({
      name: "test",
      path: "/path",
      branch: "main",
      metadata: { base: "main" },
      projectId: "test-12345678" as ProjectId,
    }),
    remove: vi.fn().mockResolvedValue({ started: true }),
    getStatus: vi.fn().mockResolvedValue({ isDirty: false, agent: { type: "none" } }),
    getAgentSession: vi.fn().mockResolvedValue(14001),
    restartAgentServer: vi.fn().mockResolvedValue(14001),
    setMetadata: vi.fn().mockResolvedValue(undefined),
    getMetadata: vi.fn().mockResolvedValue({ base: "main" }),
    executeCommand: vi.fn().mockResolvedValue(undefined),
  };

  const defaultProjects: IProjectApi = {
    open: vi.fn().mockResolvedValue({
      id: "test-12345678" as ProjectId,
      name: "test",
      path: "/path",
      workspaces: [],
    }),
    close: vi.fn().mockResolvedValue(undefined),
    clone: vi.fn().mockResolvedValue({
      id: "test-12345678" as ProjectId,
      name: "test",
      path: "/path",
      workspaces: [],
    }),
    fetchBases: vi.fn().mockResolvedValue({ bases: [] }),
  };

  return {
    workspaces: { ...defaultWorkspaces, ...overrides?.workspaces },
    projects: { ...defaultProjects, ...overrides?.projects },
    on: vi.fn().mockReturnValue(() => {}),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Create a mock MCP SDK server for testing.
 */
function createMockMcpSdk() {
  const registeredTools: Array<{ name: string; handler: (...args: unknown[]) => unknown }> = [];

  return {
    server: {},
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(false),
    registerTool: vi
      .fn()
      .mockImplementation(
        (name: string, _config: unknown, handler: (...args: unknown[]) => unknown) => {
          registeredTools.push({ name, handler });
          return { name };
        }
      ),
    getRegisteredTools: () => registeredTools,
  };
}

describe("McpServer", () => {
  let mockApi: ICoreApi;
  let mockLogger: ReturnType<typeof createMockLogger>;
  let mockMcpSdk: ReturnType<typeof createMockMcpSdk>;
  let mockFactory: McpServerFactory;

  beforeEach(() => {
    mockApi = createMockCoreApi();
    mockLogger = createMockLogger();
    mockMcpSdk = createMockMcpSdk();
    mockFactory = () => mockMcpSdk as unknown as ReturnType<typeof createDefaultMcpServer>;
  });

  describe("constructor", () => {
    it("creates server with injected dependencies", () => {
      const server = new McpServer(mockApi, mockFactory, mockLogger);
      expect(server).toBeInstanceOf(McpServer);
    });

    it("creates server without logger", () => {
      const server = new McpServer(mockApi, mockFactory);
      expect(server).toBeInstanceOf(McpServer);
    });

    it("creates server with default factory", () => {
      const server = new McpServer(mockApi);
      expect(server).toBeInstanceOf(McpServer);
    });
  });

  describe("isRunning", () => {
    it("returns false before start", () => {
      const server = new McpServer(mockApi, mockFactory, mockLogger);
      expect(server.isRunning()).toBe(false);
    });
  });

  describe("tool registration", () => {
    it("registers all required tools when started", async () => {
      const server = new McpServer(mockApi, mockFactory, mockLogger);

      // Start and immediately stop to trigger registration
      await server.start(0); // Port 0 = let OS assign
      await server.stop();

      // Check that all tools were registered
      const tools = mockMcpSdk.getRegisteredTools();
      const toolNames = tools.map((t) => t.name);

      expect(toolNames).toContain("workspace_get_status");
      expect(toolNames).toContain("workspace_get_metadata");
      expect(toolNames).toContain("workspace_set_metadata");
      expect(toolNames).toContain("workspace_get_agent_session");
      expect(toolNames).toContain("workspace_restart_agent_server");
      expect(toolNames).toContain("workspace_delete");
      expect(toolNames).toContain("workspace_execute_command");
      expect(toolNames).toContain("workspace_create");
      expect(toolNames).toContain("log");
      expect(tools.length).toBe(9);
    });

    it("workspace_restart_agent_server tool calls API and returns port", async () => {
      const workspacePath = "/project/workspaces/test-workspace";

      // Create server
      const server = new McpServer(mockApi, mockFactory, mockLogger);

      await server.start(0);
      await server.stop();

      // Find the registered tool handler
      const tools = mockMcpSdk.getRegisteredTools();
      const restartTool = tools.find((t) => t.name === "workspace_restart_agent_server");
      expect(restartTool).toBeDefined();

      // Invoke the handler with workspace path in extra.authInfo.extra (matches real MCP flow)
      const result = await restartTool!.handler(
        {}, // empty input schema
        { authInfo: { extra: { workspacePath } } }
      );

      // Verify API was called
      expect(mockApi.workspaces.restartAgentServer).toHaveBeenCalled();

      // Verify result contains the port number
      expect(result).toEqual({
        content: [{ type: "text", text: "14001" }],
      });
    });
  });

  describe("dispose", () => {
    it("stops the server", async () => {
      const server = new McpServer(mockApi, mockFactory, mockLogger);

      await server.start(0);
      expect(server.isRunning()).toBe(true);

      await server.dispose();
      expect(server.isRunning()).toBe(false);
    });
  });
});

describe("createDefaultMcpServer", () => {
  it("creates an MCP SDK server instance", () => {
    const sdk = createDefaultMcpServer();
    expect(sdk).toBeDefined();
    expect(typeof sdk.registerTool).toBe("function");
    expect(typeof sdk.connect).toBe("function");
    expect(typeof sdk.close).toBe("function");
  });
});

describe("SERVER_INSTRUCTIONS", () => {
  it("includes workspace creation guidance", () => {
    expect(SERVER_INSTRUCTIONS).toContain("workspace_create");
    expect(SERVER_INSTRUCTIONS).toContain('"plan"');
    expect(SERVER_INSTRUCTIONS).toContain("read-only");
    expect(SERVER_INSTRUCTIONS).toContain("full permissions");
  });
});

describe("initialPromptSchema validation", () => {
  // Uses the schema imported from types - this tests the exact schema used by workspace_create

  it("rejects empty string prompt", () => {
    const result = initialPromptSchema.safeParse("");
    expect(result.success).toBe(false);
  });

  it("rejects object with empty prompt string", () => {
    const result = initialPromptSchema.safeParse({ prompt: "" });
    expect(result.success).toBe(false);
  });

  it("accepts non-empty string prompt", () => {
    const result = initialPromptSchema.safeParse("Implement the feature");
    expect(result.success).toBe(true);
  });

  it("accepts object with non-empty prompt", () => {
    const result = initialPromptSchema.safeParse({ prompt: "Implement the feature" });
    expect(result.success).toBe(true);
  });

  it("accepts object with prompt and agent", () => {
    const result = initialPromptSchema.safeParse({
      prompt: "Implement the feature",
      agent: "build",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ prompt: "Implement the feature", agent: "build" });
    }
  });
});
