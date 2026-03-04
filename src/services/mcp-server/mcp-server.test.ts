/**
 * Unit tests for MCP Server.
 */

import { createServer } from "node:net";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  McpServer,
  createDefaultMcpServer,
  SERVER_INSTRUCTIONS,
  type McpServerFactory,
} from "./mcp-server";
import type { McpApiHandlers } from "./types";
import { type ProjectId, initialPromptSchema } from "../../shared/api/types";
import { createMockLogger } from "../logging";

/**
 * Find a free port for testing.
 */
async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        reject(new Error("Could not get port"));
      }
    });
    server.on("error", reject);
  });
}

/**
 * Create a mock McpApiHandlers for testing.
 */
function createMockMcpHandlers(overrides?: Partial<McpApiHandlers>): McpApiHandlers {
  return {
    getStatus: vi.fn().mockResolvedValue({ isDirty: false, agent: { type: "none" } }),
    getMetadata: vi.fn().mockResolvedValue({ base: "main" }),
    setMetadata: vi.fn().mockResolvedValue(undefined),
    getAgentSession: vi.fn().mockResolvedValue(14001),
    restartAgentServer: vi.fn().mockResolvedValue(14001),
    listProjects: vi.fn().mockResolvedValue([]),
    createWorkspace: vi.fn().mockResolvedValue({
      name: "test",
      path: "/path",
      branch: "main",
      metadata: { base: "main" },
      projectId: "test-12345678" as ProjectId,
    }),
    deleteWorkspace: vi.fn().mockResolvedValue({ started: true }),
    executeCommand: vi.fn().mockResolvedValue(undefined),
    ...overrides,
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

const testWorkspacePath = "/home/user/projects/my-app/.worktrees/feature-branch";

/**
 * Send an initialize request to trigger session creation.
 * The mock SDK won't produce a response, but tools will be registered.
 * Returns the fetch response (an open SSE stream).
 */
async function sendInitialize(port: number, workspacePath = testWorkspacePath): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "X-Workspace-Path": workspacePath,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      },
      id: 1,
    }),
  });
}

describe("McpServer", () => {
  let mockHandlers: McpApiHandlers;
  let mockLogger: ReturnType<typeof createMockLogger>;
  let mockMcpSdk: ReturnType<typeof createMockMcpSdk>;
  let mockFactory: McpServerFactory;

  beforeEach(() => {
    mockHandlers = createMockMcpHandlers();
    mockLogger = createMockLogger();
    mockMcpSdk = createMockMcpSdk();
    mockFactory = () => mockMcpSdk as unknown as ReturnType<typeof createDefaultMcpServer>;
  });

  describe("constructor", () => {
    it("creates server with injected dependencies", () => {
      const server = new McpServer(mockHandlers, mockFactory, mockLogger);
      expect(server).toBeInstanceOf(McpServer);
    });

    it("creates server without logger", () => {
      const server = new McpServer(mockHandlers, mockFactory);
      expect(server).toBeInstanceOf(McpServer);
    });

    it("creates server with default factory", () => {
      const server = new McpServer(mockHandlers);
      expect(server).toBeInstanceOf(McpServer);
    });
  });

  describe("isRunning", () => {
    it("returns false before start", () => {
      const server = new McpServer(mockHandlers, mockFactory, mockLogger);
      expect(server.isRunning()).toBe(false);
    });
  });

  describe("tool registration", () => {
    let server: McpServer;
    let port: number;

    beforeEach(async () => {
      port = await findFreePort();
      server = new McpServer(mockHandlers, mockFactory, mockLogger);
      await server.start(port);
    });

    afterEach(async () => {
      await server.stop();
    });

    it("registers all required tools when a client initializes", async () => {
      // Send initialize to trigger session creation and tool registration
      await sendInitialize(port);

      const tools = mockMcpSdk.getRegisteredTools();
      const toolNames = tools.map((t) => t.name);

      expect(toolNames).toContain("workspace_get_status");
      expect(toolNames).toContain("workspace_get_metadata");
      expect(toolNames).toContain("workspace_set_metadata");
      expect(toolNames).toContain("workspace_get_agent_session");
      expect(toolNames).toContain("workspace_restart_agent_server");
      expect(toolNames).toContain("workspace_delete");
      expect(toolNames).toContain("workspace_execute_command");
      expect(toolNames).toContain("project_list");
      expect(toolNames).toContain("workspace_create");
      expect(toolNames).toContain("log");
      expect(tools.length).toBe(10);
    });

    it("workspace_restart_agent_server tool calls handler and returns port", async () => {
      // Trigger tool registration via initialize
      await sendInitialize(port);

      // Find the registered tool handler
      const tools = mockMcpSdk.getRegisteredTools();
      const restartTool = tools.find((t) => t.name === "workspace_restart_agent_server");
      expect(restartTool).toBeDefined();

      // Invoke the handler with workspace path in extra.authInfo.extra (matches real MCP flow)
      const result = await restartTool!.handler(
        {}, // empty input schema
        { authInfo: { extra: { workspacePath: testWorkspacePath } } }
      );

      // Verify handler was called
      expect(mockHandlers.restartAgentServer).toHaveBeenCalled();

      // Verify result contains the port number
      expect(result).toEqual({
        content: [{ type: "text", text: "14001" }],
      });
    });
  });

  describe("dispose", () => {
    it("stops the server", async () => {
      const port = await findFreePort();
      const server = new McpServer(mockHandlers, mockFactory, mockLogger);

      await server.start(port);
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
