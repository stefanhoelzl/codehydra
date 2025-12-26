/**
 * Boundary tests for MCP Server.
 *
 * These tests verify actual HTTP transport behavior using real SDK and HTTP.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { McpServer, createDefaultMcpServer } from "./mcp-server";
import type { ICoreApi, IWorkspaceApi, IProjectApi } from "../../shared/api/interfaces";
import type { WorkspaceLookup } from "./workspace-resolver";
import type { ProjectId, WorkspaceName, WorkspaceStatus } from "../../shared/api/types";
import { createMockLogger } from "../logging";
import { vi } from "vitest";

/**
 * Create a mock ICoreApi for testing.
 */
function createMockCoreApi(overrides?: { workspaces?: Partial<IWorkspaceApi> }): ICoreApi {
  const defaultWorkspaces: IWorkspaceApi = {
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
    getStatus: vi.fn().mockResolvedValue({
      isDirty: false,
      agent: { type: "none" },
    } as WorkspaceStatus),
    getOpencodePort: vi.fn().mockResolvedValue(14001),
    setMetadata: vi.fn().mockResolvedValue(undefined),
    getMetadata: vi.fn().mockResolvedValue({ base: "main" }),
  };

  return {
    workspaces: { ...defaultWorkspaces, ...overrides?.workspaces },
    projects: {} as IProjectApi,
    on: vi.fn().mockReturnValue(() => {}),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Create a mock WorkspaceLookup that resolves specific workspaces.
 */
function createMockAppState(
  workspaces: { projectPath: string; workspacePath: string }[]
): WorkspaceLookup {
  return {
    findProjectForWorkspace(workspacePath: string) {
      const match = workspaces.find((w) => w.workspacePath === workspacePath);
      if (match) {
        return {
          path: match.projectPath,
          workspaces: [{ path: match.workspacePath }],
        };
      }
      return undefined;
    },
  };
}

/**
 * Find a free port for testing.
 */
async function findFreePort(): Promise<number> {
  const { createServer } = await import("node:net");
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

describe("McpServer Boundary Tests", () => {
  let server: McpServer;
  let port: number;
  let mockApi: ICoreApi;
  let mockAppState: WorkspaceLookup;
  let logger: ReturnType<typeof createMockLogger>;

  const testWorkspacePath = "/home/user/projects/my-app/.worktrees/feature-branch";
  const testProjectPath = "/home/user/projects/my-app";

  beforeEach(async () => {
    port = await findFreePort();
    mockApi = createMockCoreApi();
    mockAppState = createMockAppState([
      { projectPath: testProjectPath, workspacePath: testWorkspacePath },
    ]);
    logger = createMockLogger();

    server = new McpServer(mockApi, mockAppState, createDefaultMcpServer, logger);
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

      // Try to connect
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Workspace-Path": testWorkspacePath,
        },
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
    it("returns 400 for missing X-Workspace-Path header", async () => {
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/list",
          id: 1,
        }),
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain("X-Workspace-Path");
    });

    it("returns 404 for non-POST requests", async () => {
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "GET",
      });

      expect(response.status).toBe(404);
    });

    it("returns 404 for wrong path", async () => {
      const response = await fetch(`http://127.0.0.1:${port}/wrong-path`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Workspace-Path": testWorkspacePath,
        },
        body: "{}",
      });

      expect(response.status).toBe(404);
    });
  });

  describe("concurrent requests", () => {
    it("handles multiple concurrent requests", async () => {
      const requests = Array.from({ length: 5 }, (_, i) =>
        fetch(`http://127.0.0.1:${port}/mcp`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Workspace-Path": testWorkspacePath,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "tools/list",
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
      // Start a long-running request in the background
      const requestPromise = fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Workspace-Path": testWorkspacePath,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/list",
          id: 1,
        }),
      }).catch(() => null); // Ignore errors from aborted request

      // Give request time to start
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Stop should complete without hanging
      await server.stop();

      // Wait for request to complete or fail
      await requestPromise;

      expect(server.isRunning()).toBe(false);
    });
  });
});
