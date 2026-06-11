/**
 * Unit tests for MCP Server.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  McpServer,
  createDefaultMcpServer,
  SERVER_INSTRUCTIONS,
  type McpServerFactory,
} from "./mcp-module";
import { initialPromptSchema } from "../shared/api/types";
import { createMockLogger } from "../boundaries/platform/logging";
import { Dispatcher } from "../intents/lib/dispatcher";
import { createMockDispatcher as createBaseMockDispatcher } from "../intents/lib/dispatcher.test-utils";
import type { Intent } from "../intents/lib/types";
import { INTENT_HIBERNATE_WORKSPACE } from "../intents/hibernate-workspace";
import { INTENT_WAKE_WORKSPACE } from "../intents/wake-workspace";
import { INTENT_DELETE_WORKSPACE } from "../intents/delete-workspace";
import {
  createMockToolOperations,
  findFreePort,
  type DeleteControl,
  type MockToolOperations,
} from "./mcp-server.test-utils";

/**
 * Create a Dispatcher with mock operations registered for all MCP tool intents.
 */
function createMockDispatcher(): {
  dispatcher: Dispatcher;
  operations: MockToolOperations["operations"];
  deleteControl: DeleteControl;
} {
  const dispatcher = createBaseMockDispatcher();
  const { operations, deleteControl } = createMockToolOperations(dispatcher);
  return { dispatcher, operations, deleteControl };
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
      expect(toolNames).toContain("workspace_hibernate");
      expect(toolNames).toContain("workspace_wake");
      expect(toolNames).toContain("workspace_delete");
      expect(toolNames).toContain("workspace_execute_command");
      expect(toolNames).toContain("project_list");
      expect(toolNames).toContain("workspace_create");
      expect(toolNames).toContain("ui_show_message");
      expect(toolNames).toContain("log");
      expect(tools.length).toBe(13);
    });

    it("workspace_hibernate tool dispatches the hibernate intent", async () => {
      await sendInitialize(port);

      const tools = mockMcpSdk.getRegisteredTools();
      const hibernateTool = tools.find((t) => t.name === "workspace_hibernate");
      expect(hibernateTool).toBeDefined();

      const result = await hibernateTool!.handler(
        {},
        { authInfo: { extra: { workspacePath: testWorkspacePath } } }
      );

      expect(mockDispatcher.operations.hibernate).toHaveBeenCalled();
      const intent = mockDispatcher.operations.hibernate!.mock.calls[0]![0].intent as Intent;
      expect(intent.type).toBe(INTENT_HIBERNATE_WORKSPACE);
      expect((intent.payload as { workspacePath: string }).workspacePath).toBe(testWorkspacePath);
      expect(result).toEqual({
        content: [{ type: "text", text: JSON.stringify({ started: true }) }],
      });
    });

    it("workspace_wake tool dispatches a single wake intent and returns the workspace", async () => {
      await sendInitialize(port);

      const tools = mockMcpSdk.getRegisteredTools();
      const wakeTool = tools.find((t) => t.name === "workspace_wake");
      expect(wakeTool).toBeDefined();

      const result = await wakeTool!.handler(
        {},
        { authInfo: { extra: { workspacePath: testWorkspacePath } } }
      );

      // Single dispatch: wake now reopens internally, so the tool does not
      // dispatch resolve/get-metadata/open itself.
      expect(mockDispatcher.operations.wake).toHaveBeenCalled();
      expect(mockDispatcher.operations.openWorkspace).not.toHaveBeenCalled();
      expect(mockDispatcher.operations.resolveWorkspace).not.toHaveBeenCalled();

      const wakeIntent = mockDispatcher.operations.wake!.mock.calls[0]![0].intent as Intent;
      expect(wakeIntent.type).toBe(INTENT_WAKE_WORKSPACE);
      const payload = wakeIntent.payload as {
        workspacePath: string;
        stealFocus?: boolean;
        source?: string;
      };
      expect(payload.workspacePath).toBe(testWorkspacePath);
      expect(payload.stealFocus).toBe(false);
      expect(payload.source).toBe("mcp");

      // Returns the reopened workspace.
      const parsed = JSON.parse(
        (result as { content: Array<{ text: string }> }).content[0]!.text
      ) as { name: string };
      expect(parsed.name).toBe("test");
    });

    it("workspace_hibernate targets an explicit workspacePath argument", async () => {
      await sendInitialize(port);

      const tools = mockMcpSdk.getRegisteredTools();
      const hibernateTool = tools.find((t) => t.name === "workspace_hibernate");
      const otherWorkspacePath = "/home/user/projects/my-app/.worktrees/other-branch";

      await hibernateTool!.handler(
        { workspacePath: otherWorkspacePath },
        { authInfo: { extra: { workspacePath: testWorkspacePath } } }
      );

      const intent = mockDispatcher.operations.hibernate!.mock.calls[0]![0].intent as Intent;
      expect((intent.payload as { workspacePath: string }).workspacePath).toBe(otherWorkspacePath);
    });

    it("workspace_wake targets an explicit workspacePath argument", async () => {
      await sendInitialize(port);

      const tools = mockMcpSdk.getRegisteredTools();
      const wakeTool = tools.find((t) => t.name === "workspace_wake");
      const otherWorkspacePath = "/home/user/projects/my-app/.worktrees/other-branch";

      await wakeTool!.handler(
        { workspacePath: otherWorkspacePath },
        { authInfo: { extra: { workspacePath: testWorkspacePath } } }
      );

      const intent = mockDispatcher.operations.wake!.mock.calls[0]![0].intent as Intent;
      expect((intent.payload as { workspacePath: string }).workspacePath).toBe(otherWorkspacePath);
    });

    it("workspace_delete deletes the session workspace and reports success", async () => {
      await sendInitialize(port);

      const tools = mockMcpSdk.getRegisteredTools();
      const deleteTool = tools.find((t) => t.name === "workspace_delete");
      expect(deleteTool).toBeDefined();

      const result = await deleteTool!.handler(
        {},
        { authInfo: { extra: { workspacePath: testWorkspacePath } } }
      );

      const intent = mockDispatcher.operations.deleteWorkspace!.mock.calls[0]![0].intent as Intent;
      expect(intent.type).toBe(INTENT_DELETE_WORKSPACE);
      const payload = intent.payload as {
        workspacePath: string;
        force: boolean;
        removeWorktree: boolean;
      };
      expect(payload.workspacePath).toBe(testWorkspacePath);
      expect(payload.force).toBe(false);
      expect(payload.removeWorktree).toBe(true);
      expect(result).toEqual({
        content: [{ type: "text", text: JSON.stringify({ started: true }) }],
      });
    });

    it("workspace_delete targets an explicit workspacePath argument", async () => {
      await sendInitialize(port);

      const tools = mockMcpSdk.getRegisteredTools();
      const deleteTool = tools.find((t) => t.name === "workspace_delete");
      const otherWorkspacePath = "/home/user/projects/my-app/.worktrees/other-branch";

      const result = await deleteTool!.handler(
        { workspacePath: otherWorkspacePath },
        { authInfo: { extra: { workspacePath: testWorkspacePath } } }
      );

      const intent = mockDispatcher.operations.deleteWorkspace!.mock.calls[0]![0].intent as Intent;
      expect((intent.payload as { workspacePath: string }).workspacePath).toBe(otherWorkspacePath);
      expect(result).toEqual({
        content: [{ type: "text", text: JSON.stringify({ started: true }) }],
      });
    });

    it("workspace_delete forwards keepBranch and ignoreWarnings", async () => {
      await sendInitialize(port);

      const tools = mockMcpSdk.getRegisteredTools();
      const deleteTool = tools.find((t) => t.name === "workspace_delete");

      await deleteTool!.handler(
        { keepBranch: true, ignoreWarnings: true },
        { authInfo: { extra: { workspacePath: testWorkspacePath } } }
      );

      const intent = mockDispatcher.operations.deleteWorkspace!.mock.calls[0]![0].intent as Intent;
      const payload = intent.payload as { keepBranch: boolean; ignoreWarnings: boolean };
      expect(payload.keepBranch).toBe(true);
      expect(payload.ignoreWarnings).toBe(true);
    });

    it("workspace_delete reports a blocked delete as an error", async () => {
      mockDispatcher.deleteControl.mode = "blocked";
      mockDispatcher.deleteControl.blockingProcesses = [{ pid: 1234, name: "node" }];
      await sendInitialize(port);

      const tools = mockMcpSdk.getRegisteredTools();
      const deleteTool = tools.find((t) => t.name === "workspace_delete");

      const result = (await deleteTool!.handler(
        {},
        { authInfo: { extra: { workspacePath: testWorkspacePath } } }
      )) as { content: Array<{ text: string }>; isError?: true };

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0]!.text) as { error: { message: string } };
      expect(parsed.error.message).toContain("blocked by 1 process");
      expect(parsed.error.message).toContain("pid 1234 (node)");
    });

    it("workspace_delete surfaces a preflight failure as an error", async () => {
      mockDispatcher.deleteControl.mode = "reject";
      await sendInitialize(port);

      const tools = mockMcpSdk.getRegisteredTools();
      const deleteTool = tools.find((t) => t.name === "workspace_delete");

      const result = (await deleteTool!.handler(
        {},
        { authInfo: { extra: { workspacePath: testWorkspacePath } } }
      )) as { content: Array<{ text: string }>; isError?: true };

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0]!.text) as { error: { message: string } };
      expect(parsed.error.message).toContain("Preflight check failed");
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
    expect(SERVER_INSTRUCTIONS).toContain("default mode");
    expect(SERVER_INSTRUCTIONS).toContain("agentName");
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

  it("accepts object with prompt and agentName", () => {
    const result = initialPromptSchema.safeParse({
      prompt: "Implement the feature",
      agentName: "build",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ prompt: "Implement the feature", agentName: "build" });
    }
  });

  it("accepts object with prompt and permissionMode", () => {
    const result = initialPromptSchema.safeParse({
      prompt: "Investigate the bug",
      permissionMode: "plan",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ prompt: "Investigate the bug", permissionMode: "plan" });
    }
  });
});
