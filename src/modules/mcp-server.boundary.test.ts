/**
 * Boundary tests for MCP Server.
 *
 * These tests verify actual HTTP transport behavior using real SDK and HTTP.
 */

import { createServer } from "node:net";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { McpServer, createDefaultMcpServer } from "./mcp-module";
import { createMockLogger } from "../boundaries/platform/logging";
import { delay } from "@shared/test-fixtures";
import { Dispatcher } from "../intents/lib/dispatcher";
import { createMockDispatcher as createBaseMockDispatcher } from "../intents/lib/dispatcher.test-utils";
import type { Intent } from "../intents/lib/types";
import type { OperationContext, Operation } from "../intents/lib/operation";
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
import {
  INTENT_RESOLVE_WORKSPACE,
  RESOLVE_WORKSPACE_OPERATION_ID,
} from "../intents/resolve-workspace";
import {
  INTENT_HIBERNATE_WORKSPACE,
  HIBERNATE_WORKSPACE_OPERATION_ID,
} from "../intents/hibernate-workspace";
import { INTENT_WAKE_WORKSPACE, WAKE_WORKSPACE_OPERATION_ID } from "../intents/wake-workspace";
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
 * Create a capturing operation that records intents and returns a mock result.
 */
function createCapturingOperation<TIntent extends Intent = Intent, TResult = void>(
  operationId: string,
  capturedIntents: Intent[],
  result: TResult
): Operation<TIntent, TResult> {
  return {
    id: operationId,
    async execute(ctx: OperationContext<TIntent>): Promise<TResult> {
      capturedIntents.push(ctx.intent);
      return result;
    },
  };
}

/**
 * Create a Dispatcher with mock operations registered for all MCP tool intents.
 * Returns the dispatcher and the captured intents array for assertions.
 */
function createMockDispatcher(): { dispatcher: Dispatcher; capturedIntents: Intent[] } {
  const dispatcher = createBaseMockDispatcher();
  const capturedIntents: Intent[] = [];

  dispatcher.registerOperation(
    INTENT_GET_WORKSPACE_STATUS,
    createCapturingOperation(GET_WORKSPACE_STATUS_OPERATION_ID, capturedIntents, {
      isDirty: false,
      unmergedCommits: 0,
      agent: { type: "none" as const },
    })
  );
  dispatcher.registerOperation(
    INTENT_GET_METADATA,
    createCapturingOperation(GET_METADATA_OPERATION_ID, capturedIntents, { base: "main" })
  );
  dispatcher.registerOperation(
    INTENT_SET_METADATA,
    createCapturingOperation(SET_METADATA_OPERATION_ID, capturedIntents, undefined as void)
  );
  dispatcher.registerOperation(
    INTENT_GET_AGENT_SESSION,
    createCapturingOperation(GET_AGENT_SESSION_OPERATION_ID, capturedIntents, null)
  );
  dispatcher.registerOperation(
    INTENT_RESTART_AGENT,
    createCapturingOperation(RESTART_AGENT_OPERATION_ID, capturedIntents, 14001)
  );
  dispatcher.registerOperation(
    INTENT_LIST_PROJECTS,
    createCapturingOperation(LIST_PROJECTS_OPERATION_ID, capturedIntents, [])
  );
  dispatcher.registerOperation(
    INTENT_OPEN_WORKSPACE,
    createCapturingOperation(OPEN_WORKSPACE_OPERATION_ID, capturedIntents, {
      name: "test",
      path: "/path",
    })
  );
  dispatcher.registerOperation(
    INTENT_DELETE_WORKSPACE,
    createCapturingOperation(DELETE_WORKSPACE_OPERATION_ID, capturedIntents, { started: true })
  );
  dispatcher.registerOperation(
    INTENT_RESOLVE_WORKSPACE,
    createCapturingOperation(RESOLVE_WORKSPACE_OPERATION_ID, capturedIntents, {
      projectPath: "/home/user/projects/my-app",
      workspaceName: "feature-branch",
      active: false,
    })
  );
  dispatcher.registerOperation(
    INTENT_HIBERNATE_WORKSPACE,
    createCapturingOperation(HIBERNATE_WORKSPACE_OPERATION_ID, capturedIntents, { started: true })
  );
  dispatcher.registerOperation(
    INTENT_WAKE_WORKSPACE,
    createCapturingOperation(WAKE_WORKSPACE_OPERATION_ID, capturedIntents, {
      name: "test",
      path: "/path",
      branch: "main",
      metadata: {},
    })
  );
  dispatcher.registerOperation(
    INTENT_VSCODE_COMMAND,
    createCapturingOperation(VSCODE_COMMAND_OPERATION_ID, capturedIntents, undefined)
  );
  dispatcher.registerOperation(
    INTENT_VSCODE_SHOW_MESSAGE,
    createCapturingOperation(VSCODE_SHOW_MESSAGE_OPERATION_ID, capturedIntents, null)
  );

  return { dispatcher, capturedIntents };
}

/** Standard headers required by MCP SDK for requests. */
const mcpHeaders: Record<string, string> = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

/**
 * Send an MCP initialize request and extract the session ID from the response.
 */
async function initializeClient(
  port: number,
  workspacePath: string
): Promise<{ sessionId: string; response: Response }> {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      ...mcpHeaders,
      "X-Workspace-Path": workspacePath,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
      id: 1,
    }),
  });

  const sessionId = response.headers.get("mcp-session-id") ?? "";
  return { sessionId, response };
}

describe("McpServer Boundary Tests", () => {
  let server: McpServer;
  let port: number;
  let capturedIntents: Intent[];
  let logger: ReturnType<typeof createMockLogger>;

  const workspacePathA = "/home/user/projects/my-app/.worktrees/feature-branch";
  const workspacePathB = "/home/user/projects/my-app/.worktrees/bugfix-branch";

  beforeEach(async () => {
    port = await findFreePort();
    const mock = createMockDispatcher();
    capturedIntents = mock.capturedIntents;
    logger = createMockLogger();

    server = new McpServer(mock.dispatcher, createDefaultMcpServer, logger);
    await server.start(port);
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
  });

  describe("HTTP server lifecycle", () => {
    it("starts and accepts connections", async () => {
      expect(server.isRunning()).toBe(true);

      const { response } = await initializeClient(port, workspacePathA);

      // Server should respond (even if with an error - it's listening)
      expect(response.status).toBeLessThan(500);
    });

    it("stops and releases port", async () => {
      await server.stop();
      expect(server.isRunning()).toBe(false);

      // Try to connect - should fail
      try {
        await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        // If we get here, something is still listening
        expect.fail("Expected connection to fail");
      } catch (error) {
        // Expected - server is stopped
        expect(error).toBeDefined();
      }
    });
  });

  describe("request validation", () => {
    it("returns 400 for POST missing X-Workspace-Path header on initialize", async () => {
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: mcpHeaders,
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "test", version: "1.0.0" },
          },
          id: 1,
        }),
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain("X-Workspace-Path");
    });

    it("returns 404 for wrong path", async () => {
      const response = await fetch(`http://127.0.0.1:${port}/wrong-path`, {
        method: "POST",
        headers: mcpHeaders,
        body: "{}",
      });

      expect(response.status).toBe(404);
    });

    it("returns 400 for GET without session ID", async () => {
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "GET",
      });

      expect(response.status).toBe(400);
    });

    it("returns 404 for POST with invalid session ID", async () => {
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          ...mcpHeaders,
          "Mcp-Session-Id": "nonexistent-session-id",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/list",
          id: 1,
        }),
      });

      expect(response.status).toBe(404);
    });
  });

  describe("multi-session support", () => {
    it("two clients initialize independently with unique session IDs", async () => {
      const clientA = await initializeClient(port, workspacePathA);
      const clientB = await initializeClient(port, workspacePathB);

      expect(clientA.response.status).toBe(200);
      expect(clientB.response.status).toBe(200);

      expect(clientA.sessionId).toBeTruthy();
      expect(clientB.sessionId).toBeTruthy();
      expect(clientA.sessionId).not.toBe(clientB.sessionId);
    });

    it("routes tool calls to the correct workspace session", async () => {
      const { sessionId: sessionA } = await initializeClient(port, workspacePathA);
      const { sessionId: sessionB } = await initializeClient(port, workspacePathB);

      // Send initialized notification for client A (required by MCP protocol before tool calls)
      await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          ...mcpHeaders,
          "Mcp-Session-Id": sessionA,
          "Mcp-Protocol-Version": "2025-03-26",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }),
      });

      // Send a tool call through client A's session
      const responseA = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          ...mcpHeaders,
          "Mcp-Session-Id": sessionA,
          "Mcp-Protocol-Version": "2025-03-26",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/call",
          params: { name: "workspace_get_status", arguments: {} },
          id: 10,
        }),
      });

      expect(responseA.status).toBe(200);

      // Send initialized notification for client B
      await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          ...mcpHeaders,
          "Mcp-Session-Id": sessionB,
          "Mcp-Protocol-Version": "2025-03-26",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }),
      });

      // Send a tool call through client B's session
      const responseB = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          ...mcpHeaders,
          "Mcp-Session-Id": sessionB,
          "Mcp-Protocol-Version": "2025-03-26",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/call",
          params: { name: "workspace_get_status", arguments: {} },
          id: 20,
        }),
      });

      expect(responseB.status).toBe(200);

      // Both calls should have been handled — two get_workspace_status intents dispatched
      const statusIntents = capturedIntents.filter((i) => i.type === INTENT_GET_WORKSPACE_STATUS);
      expect(statusIntents).toHaveLength(2);
      // Verify each call received the correct workspace path
      expect(
        statusIntents.map((i) => (i.payload as { workspacePath: string }).workspacePath)
      ).toContain(workspacePathA);
      expect(
        statusIntents.map((i) => (i.payload as { workspacePath: string }).workspacePath)
      ).toContain(workspacePathB);
    });
  });

  describe("concurrent requests", () => {
    it("handles multiple concurrent requests within a session", async () => {
      const { sessionId } = await initializeClient(port, workspacePathA);

      // Send initialized notification
      await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          ...mcpHeaders,
          "Mcp-Session-Id": sessionId,
          "Mcp-Protocol-Version": "2025-03-26",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }),
      });

      const requests = Array.from({ length: 5 }, (_, i) =>
        fetch(`http://127.0.0.1:${port}/mcp`, {
          method: "POST",
          headers: {
            ...mcpHeaders,
            "Mcp-Session-Id": sessionId,
            "Mcp-Protocol-Version": "2025-03-26",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "tools/call",
            params: { name: "workspace_get_status", arguments: {} },
            id: i + 1,
          }),
        })
      );

      const responses = await Promise.all(requests);

      // All requests should get responses (status < 500)
      for (const response of responses) {
        expect(response.status).toBeLessThan(500);
      }
    });
  });

  describe("hibernation tools", () => {
    /** Initialize a session, send the initialized notification, and call a tool. */
    async function callTool(workspacePath: string, toolName: string): Promise<{ status: number }> {
      const { sessionId } = await initializeClient(port, workspacePath);
      const sessionHeaders = {
        ...mcpHeaders,
        "Mcp-Session-Id": sessionId,
        "Mcp-Protocol-Version": "2025-03-26",
      };
      await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: sessionHeaders,
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      });
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: sessionHeaders,
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/call",
          params: { name: toolName, arguments: {} },
          id: 30,
        }),
      });
      return { status: response.status };
    }

    it("workspace_hibernate dispatches the hibernate intent for the session workspace", async () => {
      const { status } = await callTool(workspacePathA, "workspace_hibernate");
      expect(status).toBe(200);

      const hibernateIntents = capturedIntents.filter((i) => i.type === INTENT_HIBERNATE_WORKSPACE);
      expect(hibernateIntents).toHaveLength(1);
      expect((hibernateIntents[0]!.payload as { workspacePath: string }).workspacePath).toBe(
        workspacePathA
      );
    });

    it("workspace_wake dispatches a single wake intent for the session workspace", async () => {
      const { status } = await callTool(workspacePathB, "workspace_wake");
      expect(status).toBe(200);

      const wakeIntents = capturedIntents.filter((i) => i.type === INTENT_WAKE_WORKSPACE);
      expect(wakeIntents).toHaveLength(1);
      const payload = wakeIntents[0]!.payload as {
        workspacePath: string;
        stealFocus?: boolean;
        source?: string;
      };
      expect(payload.workspacePath).toBe(workspacePathB);
      expect(payload.stealFocus).toBe(false);
      expect(payload.source).toBe("mcp");

      // The tool no longer dispatches open itself — wake reopens internally.
      const openIntents = capturedIntents.filter((i) => i.type === INTENT_OPEN_WORKSPACE);
      expect(openIntents).toHaveLength(0);
    });
  });

  describe("shutdown", () => {
    it("closes connections cleanly on stop", async () => {
      // Initialize a session
      await initializeClient(port, workspacePathA);

      // Give session time to establish
      await delay(50);

      // Stop should complete without hanging
      await server.stop();

      expect(server.isRunning()).toBe(false);
    });
  });
});
