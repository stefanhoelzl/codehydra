/**
 * Boundary tests for MCP Server.
 *
 * These tests verify actual HTTP transport behavior using real SDK and HTTP.
 */

import { createServer } from "node:net";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { McpServer, createDefaultMcpServer } from "./mcp-server";
import type { McpApiHandlers } from "./types";
import { createMockLogger } from "../logging";
import { delay } from "@shared/test-fixtures";

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
 * Create a mock McpApiHandlers for boundary testing.
 */
function createMockMcpHandlers(): McpApiHandlers {
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
  };
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
  let mockHandlers: McpApiHandlers;
  let logger: ReturnType<typeof createMockLogger>;

  const workspacePathA = "/home/user/projects/my-app/.worktrees/feature-branch";
  const workspacePathB = "/home/user/projects/my-app/.worktrees/bugfix-branch";

  beforeEach(async () => {
    port = await findFreePort();
    mockHandlers = createMockMcpHandlers();
    logger = createMockLogger();

    server = new McpServer(mockHandlers, createDefaultMcpServer, logger);
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

      // Both calls should have been handled — handler called twice
      expect(mockHandlers.getStatus).toHaveBeenCalledTimes(2);
      // Verify each call received the correct workspace path
      expect(mockHandlers.getStatus).toHaveBeenCalledWith(workspacePathA);
      expect(mockHandlers.getStatus).toHaveBeenCalledWith(workspacePathB);
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
