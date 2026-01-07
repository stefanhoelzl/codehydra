// @vitest-environment node
/**
 * Integration tests for ClaudeCodeServerManager.
 *
 * Tests the core functionality:
 * - Hook -> status mapping
 * - Multi-workspace routing
 * - Server lifecycle (start first workspace, stop last workspace)
 * - Config file generation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ClaudeCodeServerManager } from "./server-manager";
import {
  createPortManagerMock,
  type MockPortManager,
} from "../../services/platform/network.test-utils";
import { createMockPathProvider } from "../../services/platform/path-provider.test-utils";
import { createFileSystemMock, directory } from "../../services/platform/filesystem.state-mock";
import { SILENT_LOGGER } from "../../services/logging";
import type { PathProvider } from "../../services/platform/path-provider";
import type { MockFileSystemLayer } from "../../services/platform/filesystem.state-mock";
import type { AgentStatus } from "../types";

/**
 * Send a hook to the bridge server.
 */
async function sendHook(
  port: number,
  hookName: string,
  payload: Record<string, unknown>
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/hook/${hookName}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

describe("ClaudeCodeServerManager integration", () => {
  let serverManager: ClaudeCodeServerManager;
  let mockPortManager: MockPortManager;
  let mockPathProvider: PathProvider;
  let mockFileSystem: MockFileSystemLayer;

  beforeEach(() => {
    vi.clearAllMocks();

    // Provide enough ports for tests
    mockPortManager = createPortManagerMock([15001, 15002, 15003, 15004, 15005]);
    mockPathProvider = createMockPathProvider();
    mockFileSystem = createFileSystemMock({
      entries: {
        "/app-data": directory(),
        "/app-data/claude-code": directory(),
        "/app-data/claude-code/configs": directory(),
      },
    });

    serverManager = new ClaudeCodeServerManager({
      portManager: mockPortManager,
      pathProvider: mockPathProvider,
      fileSystem: mockFileSystem,
      logger: SILENT_LOGGER,
      config: {
        hookHandlerPath: "/mock/hook-handler.js",
      },
    });
  });

  afterEach(async () => {
    await serverManager.dispose();
  });

  describe("workspace lifecycle", () => {
    it("starts server on first workspace, returns same port for subsequent", async () => {
      const port1 = await serverManager.startServer("/workspace/feature-a");
      const port2 = await serverManager.startServer("/workspace/feature-b");

      // Both should get the same port (single server for all workspaces)
      expect(port1).toBe(15001);
      expect(port2).toBe(15001);
      expect(serverManager.getPort("/workspace/feature-a")).toBe(15001);
      expect(serverManager.getPort("/workspace/feature-b")).toBe(15001);
    });

    it("returns existing port when starting same workspace twice", async () => {
      const port1 = await serverManager.startServer("/workspace/feature-a");
      const port2 = await serverManager.startServer("/workspace/feature-a");

      expect(port1).toBe(port2);
      expect(port1).toBe(15001);
    });

    it("server stops only when last workspace is removed", async () => {
      await serverManager.startServer("/workspace/feature-a");
      await serverManager.startServer("/workspace/feature-b");

      // Stop first workspace - server should still be running
      await serverManager.stopServer("/workspace/feature-a");
      expect(serverManager.getPort("/workspace/feature-a")).toBeUndefined();
      expect(serverManager.getPort("/workspace/feature-b")).toBe(15001);

      // Stop second workspace - server should stop
      await serverManager.stopServer("/workspace/feature-b");
      expect(serverManager.getPort("/workspace/feature-b")).toBeUndefined();
    });

    it("isRunning reflects workspace registration", async () => {
      expect(serverManager.isRunning("/workspace/feature-a")).toBe(false);

      await serverManager.startServer("/workspace/feature-a");
      expect(serverManager.isRunning("/workspace/feature-a")).toBe(true);

      await serverManager.stopServer("/workspace/feature-a");
      expect(serverManager.isRunning("/workspace/feature-a")).toBe(false);
    });
  });

  describe("callback wiring", () => {
    it("onServerStarted fires for each workspace", async () => {
      const startedCallback = vi.fn();
      serverManager.onServerStarted(startedCallback);

      await serverManager.startServer("/workspace/feature-a");
      await serverManager.startServer("/workspace/feature-b");

      expect(startedCallback).toHaveBeenCalledTimes(2);
      expect(startedCallback).toHaveBeenCalledWith("/workspace/feature-a", 15001);
      expect(startedCallback).toHaveBeenCalledWith("/workspace/feature-b", 15001);
    });

    it("onServerStopped fires for each workspace", async () => {
      const stoppedCallback = vi.fn();
      serverManager.onServerStopped(stoppedCallback);

      await serverManager.startServer("/workspace/feature-a");
      await serverManager.startServer("/workspace/feature-b");
      await serverManager.stopServer("/workspace/feature-a");
      await serverManager.stopServer("/workspace/feature-b");

      expect(stoppedCallback).toHaveBeenCalledTimes(2);
      expect(stoppedCallback).toHaveBeenCalledWith("/workspace/feature-a", false);
      expect(stoppedCallback).toHaveBeenCalledWith("/workspace/feature-b", false);
    });

    it("unsubscribe works", async () => {
      const startedCallback = vi.fn();
      const unsubscribe = serverManager.onServerStarted(startedCallback);

      await serverManager.startServer("/workspace/feature-a");
      expect(startedCallback).toHaveBeenCalledTimes(1);

      unsubscribe();
      await serverManager.startServer("/workspace/feature-b");
      expect(startedCallback).toHaveBeenCalledTimes(1);
    });
  });

  describe("hook handling", () => {
    it("routes hooks to correct workspace based on workspacePath", async () => {
      const port = await serverManager.startServer("/workspace/feature-a");
      await serverManager.startServer("/workspace/feature-b");

      const statusChangesA: AgentStatus[] = [];
      const statusChangesB: AgentStatus[] = [];

      serverManager.onStatusChange("/workspace/feature-a", (status) => {
        statusChangesA.push(status);
      });
      serverManager.onStatusChange("/workspace/feature-b", (status) => {
        statusChangesB.push(status);
      });

      // Send SessionStart to workspace A
      await sendHook(port, "SessionStart", {
        workspacePath: "/workspace/feature-a",
        session_id: "session-a",
      });

      // Send UserPromptSubmit to workspace B
      await sendHook(port, "UserPromptSubmit", {
        workspacePath: "/workspace/feature-b",
      });

      expect(statusChangesA).toEqual(["idle"]);
      expect(statusChangesB).toEqual(["busy"]);
    });

    it("SessionStart -> idle", async () => {
      const port = await serverManager.startServer("/workspace/feature-a");
      const statusChanges: AgentStatus[] = [];
      serverManager.onStatusChange("/workspace/feature-a", (status) => {
        statusChanges.push(status);
      });

      await sendHook(port, "SessionStart", {
        workspacePath: "/workspace/feature-a",
        session_id: "test-session",
      });

      expect(statusChanges).toEqual(["idle"]);
      expect(serverManager.getStatus("/workspace/feature-a")).toBe("idle");
      expect(serverManager.getSessionId("/workspace/feature-a")).toBe("test-session");
    });

    it("UserPromptSubmit -> busy", async () => {
      const port = await serverManager.startServer("/workspace/feature-a");
      const statusChanges: AgentStatus[] = [];
      serverManager.onStatusChange("/workspace/feature-a", (status) => {
        statusChanges.push(status);
      });

      // First make idle
      await sendHook(port, "SessionStart", { workspacePath: "/workspace/feature-a" });
      // Then submit prompt
      await sendHook(port, "UserPromptSubmit", { workspacePath: "/workspace/feature-a" });

      expect(statusChanges).toEqual(["idle", "busy"]);
      expect(serverManager.getStatus("/workspace/feature-a")).toBe("busy");
    });

    it("PermissionRequest -> idle", async () => {
      const port = await serverManager.startServer("/workspace/feature-a");
      const statusChanges: AgentStatus[] = [];
      serverManager.onStatusChange("/workspace/feature-a", (status) => {
        statusChanges.push(status);
      });

      // Start session and make busy
      await sendHook(port, "SessionStart", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "UserPromptSubmit", { workspacePath: "/workspace/feature-a" });
      // Permission request while busy
      await sendHook(port, "PermissionRequest", { workspacePath: "/workspace/feature-a" });

      expect(statusChanges).toEqual(["idle", "busy", "idle"]);
      expect(serverManager.getStatus("/workspace/feature-a")).toBe("idle");
    });

    it("Stop -> idle", async () => {
      const port = await serverManager.startServer("/workspace/feature-a");
      const statusChanges: AgentStatus[] = [];
      serverManager.onStatusChange("/workspace/feature-a", (status) => {
        statusChanges.push(status);
      });

      // Start session and make busy
      await sendHook(port, "SessionStart", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "UserPromptSubmit", { workspacePath: "/workspace/feature-a" });
      // Stop
      await sendHook(port, "Stop", { workspacePath: "/workspace/feature-a" });

      expect(statusChanges).toEqual(["idle", "busy", "idle"]);
    });

    it("SessionEnd -> none", async () => {
      const port = await serverManager.startServer("/workspace/feature-a");
      const statusChanges: AgentStatus[] = [];
      serverManager.onStatusChange("/workspace/feature-a", (status) => {
        statusChanges.push(status);
      });

      // Start and end session
      await sendHook(port, "SessionStart", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "SessionEnd", { workspacePath: "/workspace/feature-a" });

      expect(statusChanges).toEqual(["idle", "none"]);
      expect(serverManager.getStatus("/workspace/feature-a")).toBe("none");
    });

    it("PreToolUse/PostToolUse do not change status", async () => {
      const port = await serverManager.startServer("/workspace/feature-a");
      const statusChanges: AgentStatus[] = [];
      serverManager.onStatusChange("/workspace/feature-a", (status) => {
        statusChanges.push(status);
      });

      // Make busy
      await sendHook(port, "SessionStart", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "UserPromptSubmit", { workspacePath: "/workspace/feature-a" });

      // Tool use hooks should not change status
      await sendHook(port, "PreToolUse", {
        workspacePath: "/workspace/feature-a",
        tool_name: "bash",
      });
      await sendHook(port, "PostToolUse", {
        workspacePath: "/workspace/feature-a",
        tool_name: "bash",
      });

      // Status should remain busy
      expect(statusChanges).toEqual(["idle", "busy"]);
      expect(serverManager.getStatus("/workspace/feature-a")).toBe("busy");
    });

    it("ignores hooks for unknown workspaces", async () => {
      const port = await serverManager.startServer("/workspace/feature-a");

      // Send hook for unknown workspace - should not throw
      const response = await sendHook(port, "SessionStart", {
        workspacePath: "/unknown/workspace",
      });

      expect(response.ok).toBe(true);
    });

    it("returns 400 for invalid hook name", async () => {
      const port = await serverManager.startServer("/workspace/feature-a");

      const response = await sendHook(port, "InvalidHook", {
        workspacePath: "/workspace/feature-a",
      });

      expect(response.status).toBe(400);
    });

    it("returns 400 for invalid JSON body", async () => {
      const port = await serverManager.startServer("/workspace/feature-a");

      const response = await fetch(`http://127.0.0.1:${port}/hook/SessionStart`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });

      expect(response.status).toBe(400);
    });

    it("returns 405 for non-POST requests", async () => {
      const port = await serverManager.startServer("/workspace/feature-a");

      const response = await fetch(`http://127.0.0.1:${port}/hook/SessionStart`, {
        method: "GET",
      });

      expect(response.status).toBe(405);
    });
  });

  describe("project close cleanup", () => {
    it("stops all workspaces for a project", async () => {
      await serverManager.startServer("/project/.worktrees/feature-a");
      await serverManager.startServer("/project/.worktrees/feature-b");
      await serverManager.startServer("/other-project/feature-c");

      // All should be registered
      expect(serverManager.isRunning("/project/.worktrees/feature-a")).toBe(true);
      expect(serverManager.isRunning("/project/.worktrees/feature-b")).toBe(true);
      expect(serverManager.isRunning("/other-project/feature-c")).toBe(true);

      // Stop all for /project
      await serverManager.stopAllForProject("/project");

      // Project workspaces should be stopped
      expect(serverManager.isRunning("/project/.worktrees/feature-a")).toBe(false);
      expect(serverManager.isRunning("/project/.worktrees/feature-b")).toBe(false);
      // Other project should still be running
      expect(serverManager.isRunning("/other-project/feature-c")).toBe(true);
    });
  });

  describe("restartServer", () => {
    it("restarts workspace and preserves port", async () => {
      const port = await serverManager.startServer("/workspace/feature-a");

      const result = await serverManager.restartServer("/workspace/feature-a");

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.port).toBe(port);
      }
    });

    it("fires stop and start callbacks during restart", async () => {
      const startedCallback = vi.fn();
      const stoppedCallback = vi.fn();
      const callOrder: string[] = [];

      serverManager.onServerStarted(() => {
        callOrder.push("started");
        startedCallback();
      });
      serverManager.onServerStopped(() => {
        callOrder.push("stopped");
        stoppedCallback();
      });

      await serverManager.startServer("/workspace/feature-a");
      callOrder.length = 0; // Reset for restart test

      await serverManager.restartServer("/workspace/feature-a");

      expect(stoppedCallback).toHaveBeenCalled();
      expect(startedCallback).toHaveBeenCalledTimes(2); // Initial + restart
      expect(callOrder).toEqual(["stopped", "started"]);
    });

    it("stopped callback has isRestart=true during restart", async () => {
      const stoppedCallback = vi.fn();
      serverManager.onServerStopped(stoppedCallback);

      await serverManager.startServer("/workspace/feature-a");
      await serverManager.restartServer("/workspace/feature-a");

      expect(stoppedCallback).toHaveBeenCalledWith("/workspace/feature-a", true);
    });

    it("fails for unregistered workspace", async () => {
      const result = await serverManager.restartServer("/unknown/workspace");

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("not registered");
        expect(result.serverStopped).toBe(false);
      }
    });

    it("resets status and preserves callbacks", async () => {
      const port = await serverManager.startServer("/workspace/feature-a");
      const statusChanges: AgentStatus[] = [];
      serverManager.onStatusChange("/workspace/feature-a", (status) => {
        statusChanges.push(status);
      });

      // Make busy
      await sendHook(port, "SessionStart", { workspacePath: "/workspace/feature-a" });
      await sendHook(port, "UserPromptSubmit", { workspacePath: "/workspace/feature-a" });
      expect(serverManager.getStatus("/workspace/feature-a")).toBe("busy");

      // Restart
      await serverManager.restartServer("/workspace/feature-a");

      // Status should be reset to none
      expect(serverManager.getStatus("/workspace/feature-a")).toBe("none");

      // But callback should still work
      await sendHook(port, "SessionStart", { workspacePath: "/workspace/feature-a" });
      expect(statusChanges).toContain("idle");
    });
  });

  describe("config file generation", () => {
    it("generates hooks config file", async () => {
      await serverManager.startServer("/workspace/feature-a");

      // Find the generated config file
      const entries = [...mockFileSystem.$.entries.entries()];
      const hooksConfig = entries.find(([path]) => path.includes("codehydra-hooks.json"));

      expect(hooksConfig).toBeDefined();
      if (hooksConfig) {
        const [, entry] = hooksConfig;
        expect(entry.type).toBe("file");
        if (entry.type === "file") {
          const content =
            typeof entry.content === "string" ? entry.content : entry.content.toString();
          // Should contain hook handler path
          expect(content).toContain("/mock/hook-handler.js");
          // Should contain hook definitions
          expect(content).toContain("SessionStart");
          expect(content).toContain("UserPromptSubmit");
        }
      }
    });

    it("generates MCP config file", async () => {
      serverManager.setMcpConfig({ port: 9999 });
      await serverManager.startServer("/workspace/feature-a");

      // Find the generated config file
      const entries = [...mockFileSystem.$.entries.entries()];
      const mcpConfig = entries.find(([path]) => path.includes("codehydra-mcp.json"));

      expect(mcpConfig).toBeDefined();
      if (mcpConfig) {
        const [, entry] = mcpConfig;
        expect(entry.type).toBe("file");
        if (entry.type === "file") {
          const content =
            typeof entry.content === "string" ? entry.content : entry.content.toString();
          // Should contain MCP port
          expect(content).toContain("9999");
          // Should contain workspace path
          expect(content).toContain("/workspace/feature-a");
        }
      }
    });
  });

  describe("config path getters", () => {
    it("returns consistent paths for hooks config", async () => {
      await serverManager.startServer("/workspace/feature-a");

      const path1 = serverManager.getHooksConfigPath("/workspace/feature-a");
      const path2 = serverManager.getHooksConfigPath("/workspace/feature-a");

      expect(path1.toString()).toBe(path2.toString());
      expect(path1.toString()).toContain("codehydra-hooks.json");
    });

    it("returns consistent paths for MCP config", async () => {
      await serverManager.startServer("/workspace/feature-a");

      const path1 = serverManager.getMcpConfigPath("/workspace/feature-a");
      const path2 = serverManager.getMcpConfigPath("/workspace/feature-a");

      expect(path1.toString()).toBe(path2.toString());
      expect(path1.toString()).toContain("codehydra-mcp.json");
    });

    it("returns different paths for different workspaces", async () => {
      await serverManager.startServer("/workspace/feature-a");
      await serverManager.startServer("/workspace/feature-b");

      const pathA = serverManager.getHooksConfigPath("/workspace/feature-a");
      const pathB = serverManager.getHooksConfigPath("/workspace/feature-b");

      expect(pathA.toString()).not.toBe(pathB.toString());
    });
  });

  describe("dispose", () => {
    it("stops all workspaces and server", async () => {
      await serverManager.startServer("/workspace/feature-a");
      await serverManager.startServer("/workspace/feature-b");

      await serverManager.dispose();

      expect(serverManager.isRunning("/workspace/feature-a")).toBe(false);
      expect(serverManager.isRunning("/workspace/feature-b")).toBe(false);
    });

    it("is safe to call multiple times", async () => {
      await serverManager.startServer("/workspace/feature-a");

      await serverManager.dispose();
      await serverManager.dispose(); // Should not throw
    });
  });
});
