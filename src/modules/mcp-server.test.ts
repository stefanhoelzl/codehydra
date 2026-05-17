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
} from "./mcp-module";
import { type ProjectId, initialPromptSchema } from "../shared/api/types";
import { createMockLogger } from "../boundaries/platform/logging";
import { Dispatcher } from "../intents/lib/dispatcher";
import { createMockDispatcher as createBaseMockDispatcher } from "../intents/lib/dispatcher.test-utils";
import type { Intent } from "../intents/lib/types";
import type { Operation } from "../intents/lib/operation";
import {
  INTENT_GET_WORKSPACE_STATUS,
  GET_WORKSPACE_STATUS_OPERATION_ID,
} from "../intents/get-workspace-status";
import { INTENT_GET_METADATA, GET_METADATA_OPERATION_ID } from "../intents/get-metadata";
import { INTENT_SET_METADATA, SET_METADATA_OPERATION_ID } from "../intents/set-metadata";
import {
  INTENT_GET_AGENT_SESSION,
  GET_AGENT_SESSION_OPERATION_ID,
} from "../intents/get-agent-session";
import { INTENT_RESTART_AGENT, RESTART_AGENT_OPERATION_ID } from "../intents/restart-agent";
import { INTENT_LIST_PROJECTS, LIST_PROJECTS_OPERATION_ID } from "../intents/list-projects";
import { INTENT_OPEN_WORKSPACE, OPEN_WORKSPACE_OPERATION_ID } from "../intents/open-workspace";
import {
  INTENT_DELETE_WORKSPACE,
  DELETE_WORKSPACE_OPERATION_ID,
} from "../intents/delete-workspace";
import { INTENT_VSCODE_COMMAND, VSCODE_COMMAND_OPERATION_ID } from "../intents/vscode-command";
import {
  INTENT_VSCODE_SHOW_MESSAGE,
  VSCODE_SHOW_MESSAGE_OPERATION_ID,
} from "../intents/vscode-show-message";

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
 * Create a mock operation that returns a fixed result.
 */
function createMockOperation<TIntent extends Intent = Intent, TResult = void>(
  operationId: string,
  result: TResult
): Operation<TIntent, TResult> {
  return {
    id: operationId,
    execute: vi.fn(async (): Promise<TResult> => result),
  };
}

/**
 * Create a Dispatcher with mock operations registered for all MCP tool intents.
 */
function createMockDispatcher(): {
  dispatcher: Dispatcher;
  operations: Record<string, ReturnType<typeof vi.fn>>;
} {
  const dispatcher = createBaseMockDispatcher();

  const getStatusOp = createMockOperation(GET_WORKSPACE_STATUS_OPERATION_ID, {
    isDirty: false,
    unmergedCommits: 0,
    agent: { type: "none" as const },
  });
  const getMetadataOp = createMockOperation(GET_METADATA_OPERATION_ID, { base: "main" });
  const setMetadataOp = createMockOperation(SET_METADATA_OPERATION_ID, undefined);
  const getAgentSessionOp = createMockOperation(GET_AGENT_SESSION_OPERATION_ID, {
    port: 14001,
    sessionId: "test-session",
  });
  const restartAgentOp = createMockOperation(RESTART_AGENT_OPERATION_ID, 14001);
  const listProjectsOp = createMockOperation(LIST_PROJECTS_OPERATION_ID, []);
  const openWorkspaceOp = createMockOperation(OPEN_WORKSPACE_OPERATION_ID, {
    name: "test",
    path: "/path",
    branch: "main",
    metadata: { base: "main" },
    projectId: "test-12345678" as ProjectId,
  });
  const deleteWorkspaceOp = createMockOperation(DELETE_WORKSPACE_OPERATION_ID, { started: true });
  const executeCommandOp = createMockOperation(VSCODE_COMMAND_OPERATION_ID, undefined);
  const showMessageOp = createMockOperation(VSCODE_SHOW_MESSAGE_OPERATION_ID, null);

  dispatcher.registerOperation(INTENT_GET_WORKSPACE_STATUS, getStatusOp);
  dispatcher.registerOperation(INTENT_GET_METADATA, getMetadataOp);
  dispatcher.registerOperation(INTENT_SET_METADATA, setMetadataOp);
  dispatcher.registerOperation(INTENT_GET_AGENT_SESSION, getAgentSessionOp);
  dispatcher.registerOperation(INTENT_RESTART_AGENT, restartAgentOp);
  dispatcher.registerOperation(INTENT_LIST_PROJECTS, listProjectsOp);
  dispatcher.registerOperation(INTENT_OPEN_WORKSPACE, openWorkspaceOp);
  dispatcher.registerOperation(INTENT_DELETE_WORKSPACE, deleteWorkspaceOp);
  dispatcher.registerOperation(INTENT_VSCODE_COMMAND, executeCommandOp);
  dispatcher.registerOperation(INTENT_VSCODE_SHOW_MESSAGE, showMessageOp);

  return {
    dispatcher,
    operations: {
      getStatus: getStatusOp.execute as ReturnType<typeof vi.fn>,
      getMetadata: getMetadataOp.execute as ReturnType<typeof vi.fn>,
      setMetadata: setMetadataOp.execute as ReturnType<typeof vi.fn>,
      getAgentSession: getAgentSessionOp.execute as ReturnType<typeof vi.fn>,
      restartAgent: restartAgentOp.execute as ReturnType<typeof vi.fn>,
      listProjects: listProjectsOp.execute as ReturnType<typeof vi.fn>,
      openWorkspace: openWorkspaceOp.execute as ReturnType<typeof vi.fn>,
      deleteWorkspace: deleteWorkspaceOp.execute as ReturnType<typeof vi.fn>,
      executeCommand: executeCommandOp.execute as ReturnType<typeof vi.fn>,
      showMessage: showMessageOp.execute as ReturnType<typeof vi.fn>,
    },
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
  let mockDispatcher: ReturnType<typeof createMockDispatcher>;
  let mockLogger: ReturnType<typeof createMockLogger>;
  let mockMcpSdk: ReturnType<typeof createMockMcpSdk>;
  let mockFactory: McpServerFactory;

  beforeEach(() => {
    mockDispatcher = createMockDispatcher();
    mockLogger = createMockLogger();
    mockMcpSdk = createMockMcpSdk();
    mockFactory = () => mockMcpSdk as unknown as ReturnType<typeof createDefaultMcpServer>;
  });

  describe("constructor", () => {
    it("creates server with injected dependencies", () => {
      const server = new McpServer(mockDispatcher.dispatcher, mockFactory, mockLogger);
      expect(server).toBeInstanceOf(McpServer);
    });

    it("creates server without logger", () => {
      const server = new McpServer(mockDispatcher.dispatcher, mockFactory);
      expect(server).toBeInstanceOf(McpServer);
    });

    it("creates server with default factory", () => {
      const server = new McpServer(mockDispatcher.dispatcher);
      expect(server).toBeInstanceOf(McpServer);
    });
  });

  describe("isRunning", () => {
    it("returns false before start", () => {
      const server = new McpServer(mockDispatcher.dispatcher, mockFactory, mockLogger);
      expect(server.isRunning()).toBe(false);
    });
  });

  describe("tool registration", () => {
    let server: McpServer;
    let port: number;

    beforeEach(async () => {
      port = await findFreePort();
      server = new McpServer(mockDispatcher.dispatcher, mockFactory, mockLogger);
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
      expect(toolNames).toContain("ui_show_message");
      expect(toolNames).toContain("log");
      expect(tools.length).toBe(11);
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

      // Verify operation was called
      expect(mockDispatcher.operations.restartAgent).toHaveBeenCalled();

      // Verify result contains the port number
      expect(result).toEqual({
        content: [{ type: "text", text: "14001" }],
      });
    });
  });

  describe("dispose", () => {
    it("stops the server", async () => {
      const port = await findFreePort();
      const server = new McpServer(mockDispatcher.dispatcher, mockFactory, mockLogger);

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
