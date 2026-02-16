/**
 * Integration tests for MCP Server Manager.
 *
 * Tests the first-request detection flow using real HTTP transport.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { McpServerManager } from "./mcp-server-manager";
import type { PortManager } from "../platform/network";
import type { PathProvider } from "../platform/path-provider";
import type { ICoreApi, IWorkspaceApi, IProjectApi } from "../../shared/api/interfaces";
import { createMockLogger } from "../logging";
import { createMockPathProvider } from "../platform/path-provider.test-utils";
import { generateProjectId, extractWorkspaceName } from "../../shared/api/id-utils";

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

/**
 * Check if a port is available for binding.
 */
async function isPortAvailable(port: number): Promise<boolean> {
  const { createServer } = await import("node:net");
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * Create a real port manager that finds free ports.
 */
function createRealPortManager(): PortManager {
  return {
    findFreePort,
    isPortAvailable,
  };
}

/**
 * Create a mock ICoreApi.
 */
function createMockCoreApi(): ICoreApi {
  return {
    workspaces: {
      create: vi.fn(),
      remove: vi.fn(),
      get: vi.fn(),
      getStatus: vi.fn(),
      getOpencodePort: vi.fn(),
      setMetadata: vi.fn(),
      getMetadata: vi.fn(),
      executeCommand: vi.fn(),
    } as unknown as IWorkspaceApi,
    projects: {} as IProjectApi,
    on: vi.fn().mockReturnValue(() => {}),
    dispose: vi.fn(),
  };
}

/**
 * Send an MCP request to the server.
 */
async function sendMcpRequest(port: number, workspacePath: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Workspace-Path": workspacePath,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/list",
      id: 1,
    }),
  });
}

describe("McpServerManager Integration Tests", () => {
  let portManager: PortManager;
  let pathProvider: PathProvider;
  let api: ICoreApi;
  let logger: ReturnType<typeof createMockLogger>;
  let activeManager: McpServerManager | null = null;

  const testWorkspacePath = "/home/user/projects/my-app/.worktrees/feature-branch";
  const testProjectPath = "/home/user/projects/my-app";

  beforeEach(() => {
    portManager = createRealPortManager();
    pathProvider = createMockPathProvider({ dataRootDir: "/tmp/test-data" });
    api = createMockCoreApi();
    logger = createMockLogger();
    activeManager = null;
  });

  afterEach(async () => {
    if (activeManager) {
      await activeManager.stop();
      activeManager = null;
    }
  });

  /**
   * Helper to register test workspace with the manager.
   */
  function registerTestWorkspace(
    manager: McpServerManager,
    workspacePath: string,
    projectPath: string
  ): void {
    manager.registerWorkspace({
      projectId: generateProjectId(projectPath),
      workspaceName: extractWorkspaceName(workspacePath),
      workspacePath,
    });
  }

  describe("first request detection", () => {
    it("calls callback on first MCP request for a workspace", async () => {
      activeManager = new McpServerManager(portManager, pathProvider, api, logger);
      registerTestWorkspace(activeManager, testWorkspacePath, testProjectPath);
      const callback = vi.fn();
      activeManager.onFirstRequest(callback);

      const port = await activeManager.start();
      await sendMcpRequest(port, testWorkspacePath);

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(testWorkspacePath);
    });

    it("does not call callback on second request for same workspace", async () => {
      activeManager = new McpServerManager(portManager, pathProvider, api, logger);
      registerTestWorkspace(activeManager, testWorkspacePath, testProjectPath);
      const callback = vi.fn();
      activeManager.onFirstRequest(callback);

      const port = await activeManager.start();
      await sendMcpRequest(port, testWorkspacePath);
      await sendMcpRequest(port, testWorkspacePath);
      await sendMcpRequest(port, testWorkspacePath);

      expect(callback).toHaveBeenCalledTimes(1);
    });

    it("calls callback once per workspace", async () => {
      const workspace2Path = "/home/user/projects/my-app/.worktrees/another-branch";

      activeManager = new McpServerManager(portManager, pathProvider, api, logger);
      registerTestWorkspace(activeManager, testWorkspacePath, testProjectPath);
      registerTestWorkspace(activeManager, workspace2Path, testProjectPath);
      const callback = vi.fn();
      activeManager.onFirstRequest(callback);

      const port = await activeManager.start();

      // First request for workspace 1
      await sendMcpRequest(port, testWorkspacePath);
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenNthCalledWith(1, testWorkspacePath);

      // Second request for workspace 1 - no callback
      await sendMcpRequest(port, testWorkspacePath);
      expect(callback).toHaveBeenCalledTimes(1);

      // First request for workspace 2
      await sendMcpRequest(port, workspace2Path);
      expect(callback).toHaveBeenCalledTimes(2);
      expect(callback).toHaveBeenNthCalledWith(2, workspace2Path);
    });

    it("handles unknown workspace path gracefully", async () => {
      activeManager = new McpServerManager(portManager, pathProvider, api, logger);
      const callback = vi.fn();
      activeManager.onFirstRequest(callback);

      const port = await activeManager.start();

      // Request for unknown workspace - still triggers callback (path normalization happens)
      const unknownPath = "/unknown/workspace/path";
      await sendMcpRequest(port, unknownPath);

      // Callback should be called (first request filtering happens regardless of workspace validity)
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it("normalizes workspace paths for deduplication", async () => {
      activeManager = new McpServerManager(portManager, pathProvider, api, logger);
      const callback = vi.fn();
      activeManager.onFirstRequest(callback);

      const port = await activeManager.start();

      // Request with path using forward slashes
      await sendMcpRequest(port, "/home/user/projects/my-app");
      expect(callback).toHaveBeenCalledTimes(1);

      // Request with same path but different format (trailing slash) - should not trigger
      // Note: Path normalization removes trailing slashes
      await sendMcpRequest(port, "/home/user/projects/my-app/");
      // This should NOT trigger a second callback because normalized paths are equal
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it("unsubscribed callback is not called", async () => {
      activeManager = new McpServerManager(portManager, pathProvider, api, logger);
      const callback = vi.fn();
      const unsubscribe = activeManager.onFirstRequest(callback);

      // Unsubscribe before starting
      unsubscribe();

      const port = await activeManager.start();
      await sendMcpRequest(port, testWorkspacePath);

      expect(callback).not.toHaveBeenCalled();
    });

    it("clears seen workspaces on stop", async () => {
      activeManager = new McpServerManager(portManager, pathProvider, api, logger);
      registerTestWorkspace(activeManager, testWorkspacePath, testProjectPath);
      const callback = vi.fn();
      activeManager.onFirstRequest(callback);

      // First run
      let port = await activeManager.start();
      await sendMcpRequest(port, testWorkspacePath);
      expect(callback).toHaveBeenCalledTimes(1);

      // Stop clears state
      await activeManager.stop();

      // Re-subscribe (old subscription was cleared by stop)
      activeManager.onFirstRequest(callback);
      // Re-register workspace (cleared by stop)
      registerTestWorkspace(activeManager, testWorkspacePath, testProjectPath);

      // Second run - workspace should be "first" again
      port = await activeManager.start();
      await sendMcpRequest(port, testWorkspacePath);
      expect(callback).toHaveBeenCalledTimes(2);
    });

    it("clearFirstRequestTracking allows onFirstRequest to fire again for recreated workspace", async () => {
      activeManager = new McpServerManager(portManager, pathProvider, api, logger);
      registerTestWorkspace(activeManager, testWorkspacePath, testProjectPath);
      const callback = vi.fn();
      activeManager.onFirstRequest(callback);

      const port = await activeManager.start();

      // First request triggers callback
      await sendMcpRequest(port, testWorkspacePath);
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(testWorkspacePath);

      // Clear first-request tracking (simulates agent server restart)
      activeManager.clearFirstRequestTracking(testWorkspacePath);

      // Next request for same workspace triggers callback again (proves clearing worked)
      await sendMcpRequest(port, testWorkspacePath);
      expect(callback).toHaveBeenCalledTimes(2);
      expect(callback).toHaveBeenNthCalledWith(2, testWorkspacePath);
    });

    it("handles callback errors gracefully and continues to other callbacks", async () => {
      activeManager = new McpServerManager(portManager, pathProvider, api, logger);

      const errorCallback = vi.fn(() => {
        throw new Error("Callback error");
      });
      const successCallback = vi.fn();

      // Register both callbacks
      activeManager.onFirstRequest(errorCallback);
      activeManager.onFirstRequest(successCallback);

      const port = await activeManager.start();
      await sendMcpRequest(port, testWorkspacePath);

      // Both callbacks should have been called despite the first one throwing
      expect(errorCallback).toHaveBeenCalledTimes(1);
      expect(successCallback).toHaveBeenCalledTimes(1);

      // Error should have been logged
      expect(logger.error).toHaveBeenCalledWith("First request callback error", {
        error: "Callback error",
      });
    });
  });

  describe("ViewManager integration scenarios", () => {
    /**
     * Mock ViewManager that simulates loading state tracking.
     */
    function createMockViewManager() {
      const loadingWorkspaces = new Map<string, NodeJS.Timeout>();

      return {
        loadingWorkspaces,
        isWorkspaceLoading: (path: string) => loadingWorkspaces.has(path),
        setWorkspaceLoaded: vi.fn((path: string) => {
          const timeout = loadingWorkspaces.get(path);
          if (timeout !== undefined) {
            clearTimeout(timeout);
          }
          loadingWorkspaces.delete(path);
        }),
        createWorkspaceView: (path: string, timeoutMs: number) => {
          const timeout = setTimeout(() => {
            loadingWorkspaces.delete(path);
          }, timeoutMs);
          loadingWorkspaces.set(path, timeout);
        },
        destroyWorkspaceView: (path: string) => {
          const timeout = loadingWorkspaces.get(path);
          if (timeout !== undefined) {
            clearTimeout(timeout);
          }
          loadingWorkspaces.delete(path);
        },
      };
    }

    it("MCP request marks workspace as loaded", async () => {
      // Create mock ViewManager
      const mockViewManager = createMockViewManager();

      // Create McpServerManager
      activeManager = new McpServerManager(portManager, pathProvider, api, logger);
      registerTestWorkspace(activeManager, testWorkspacePath, testProjectPath);

      // Wire the callback like index.ts does
      activeManager.onFirstRequest((workspacePath) => {
        mockViewManager.setWorkspaceLoaded(workspacePath);
      });

      // Simulate createWorkspaceView (sets loading state)
      mockViewManager.createWorkspaceView(testWorkspacePath, 10000);
      expect(mockViewManager.isWorkspaceLoading(testWorkspacePath)).toBe(true);

      // Start server and send MCP request
      const port = await activeManager.start();
      await sendMcpRequest(port, testWorkspacePath);

      // Verify workspace is no longer loading
      expect(mockViewManager.setWorkspaceLoaded).toHaveBeenCalledWith(testWorkspacePath);
      expect(mockViewManager.isWorkspaceLoading(testWorkspacePath)).toBe(false);
    });

    it("MCP request before createWorkspaceView does not cause errors", async () => {
      vi.useFakeTimers();

      // Create mock ViewManager (no workspace created yet)
      const mockViewManager = createMockViewManager();

      // Create McpServerManager
      activeManager = new McpServerManager(portManager, pathProvider, api, logger);

      // Wire the callback - setWorkspaceLoaded is idempotent, should handle unknown workspace
      activeManager.onFirstRequest((workspacePath) => {
        // This simulates what setWorkspaceLoaded does - guard for non-loading workspace
        if (mockViewManager.loadingWorkspaces.has(workspacePath)) {
          mockViewManager.setWorkspaceLoaded(workspacePath);
        }
      });

      // Start server
      const port = await activeManager.start();

      // Send MCP request BEFORE workspace is created - should not error
      await sendMcpRequest(port, testWorkspacePath);

      // Now create the workspace (this would happen slightly after in real scenario)
      mockViewManager.createWorkspaceView(testWorkspacePath, 10000);
      expect(mockViewManager.isWorkspaceLoading(testWorkspacePath)).toBe(true);

      // Advance timers past the timeout
      await vi.advanceTimersByTimeAsync(11000);

      // Workspace should eventually become loaded (via timeout)
      expect(mockViewManager.isWorkspaceLoading(testWorkspacePath)).toBe(false);

      vi.useRealTimers();
    });

    it("MCP request after timeout already fired does not cause errors", async () => {
      vi.useFakeTimers();

      // Create mock ViewManager
      const mockViewManager = createMockViewManager();

      // Create McpServerManager
      activeManager = new McpServerManager(portManager, pathProvider, api, logger);
      registerTestWorkspace(activeManager, testWorkspacePath, testProjectPath);

      // Wire the callback
      activeManager.onFirstRequest((workspacePath) => {
        mockViewManager.setWorkspaceLoaded(workspacePath);
      });

      // Create workspace with short timeout
      mockViewManager.createWorkspaceView(testWorkspacePath, 10000);
      expect(mockViewManager.isWorkspaceLoading(testWorkspacePath)).toBe(true);

      // Start server
      const port = await activeManager.start();

      // Advance past the timeout - workspace should become loaded
      await vi.advanceTimersByTimeAsync(11000);
      expect(mockViewManager.isWorkspaceLoading(testWorkspacePath)).toBe(false);

      // Now send MCP request after timeout already fired - should not error
      // setWorkspaceLoaded is idempotent (guards internally)
      await sendMcpRequest(port, testWorkspacePath);

      // Verify setWorkspaceLoaded was called (and is idempotent)
      expect(mockViewManager.setWorkspaceLoaded).toHaveBeenCalledWith(testWorkspacePath);
      // Workspace still not loading (already handled by timeout)
      expect(mockViewManager.isWorkspaceLoading(testWorkspacePath)).toBe(false);

      vi.useRealTimers();
    });

    it("workspace deleted while MCP callback pending does not cause errors", async () => {
      // Create mock ViewManager
      const mockViewManager = createMockViewManager();

      // Create McpServerManager
      activeManager = new McpServerManager(portManager, pathProvider, api, logger);
      registerTestWorkspace(activeManager, testWorkspacePath, testProjectPath);

      // Wire the callback - should handle deleted workspace gracefully
      activeManager.onFirstRequest((workspacePath) => {
        // setWorkspaceLoaded checks if workspace is loading, if not it's a no-op
        mockViewManager.setWorkspaceLoaded(workspacePath);
      });

      // Create workspace
      mockViewManager.createWorkspaceView(testWorkspacePath, 10000);
      expect(mockViewManager.isWorkspaceLoading(testWorkspacePath)).toBe(true);

      // Start server
      const port = await activeManager.start();

      // Delete workspace BEFORE MCP request arrives
      mockViewManager.destroyWorkspaceView(testWorkspacePath);
      expect(mockViewManager.isWorkspaceLoading(testWorkspacePath)).toBe(false);

      // Now send MCP request for deleted workspace - should not error
      await sendMcpRequest(port, testWorkspacePath);

      // setWorkspaceLoaded should have been called but it's a no-op for non-loading workspace
      expect(mockViewManager.setWorkspaceLoaded).toHaveBeenCalledWith(testWorkspacePath);
      // No errors should have occurred
      expect(logger.error).not.toHaveBeenCalled();
    });
  });
});
