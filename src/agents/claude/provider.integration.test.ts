// @vitest-environment node
/**
 * Integration tests for ClaudeCodeProvider.
 *
 * Tests the provider functionality:
 * - Connect/disconnect/reconnect
 * - Status change forwarding from ServerManager
 * - getSession()
 * - getEnvironmentVariables()
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ClaudeCodeProvider } from "./provider";
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

describe("ClaudeCodeProvider integration", () => {
  let serverManager: ClaudeCodeServerManager;
  let provider: ClaudeCodeProvider;
  let mockPortManager: MockPortManager;
  let mockPathProvider: PathProvider;
  let mockFileSystem: MockFileSystemLayer;

  const workspacePath = "/workspace/feature-a";

  beforeEach(() => {
    vi.clearAllMocks();

    mockPortManager = createPortManagerMock([16001, 16002, 16003]);
    mockPathProvider = createMockPathProvider();
    mockFileSystem = createFileSystemMock({
      entries: {
        "/app-data": directory(),
        "/app-data/claude": directory(),
        "/app-data/claude/configs": directory(),
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

    // Set MCP config for environment variables
    serverManager.setMcpConfig({ port: 9999 });

    provider = new ClaudeCodeProvider({
      serverManager,
      workspacePath,
      logger: SILENT_LOGGER,
    });
  });

  afterEach(async () => {
    provider.dispose();
    await serverManager.dispose();
  });

  describe("connect/disconnect/reconnect", () => {
    it("connect subscribes to status changes", async () => {
      const port = await serverManager.startServer(workspacePath);
      await provider.connect(port);

      const statusChanges: AgentStatus[] = [];
      provider.onStatusChange((status) => statusChanges.push(status));

      // Send hooks to trigger status changes
      await sendHook(port, "SessionStart", {
        workspacePath,
        session_id: "test-session",
      });

      expect(statusChanges).toEqual(["idle"]);
    });

    it("disconnect stops receiving status changes", async () => {
      const port = await serverManager.startServer(workspacePath);
      await provider.connect(port);

      const statusChanges: AgentStatus[] = [];
      provider.onStatusChange((status) => statusChanges.push(status));

      // Disconnect
      provider.disconnect();

      // Send hook after disconnect
      await sendHook(port, "SessionStart", { workspacePath });

      // Should not receive status change
      expect(statusChanges).toEqual([]);
    });

    it("reconnect resubscribes to status changes", async () => {
      const port = await serverManager.startServer(workspacePath);
      await provider.connect(port);

      const statusChanges: AgentStatus[] = [];
      provider.onStatusChange((status) => statusChanges.push(status));

      // Disconnect and reconnect
      provider.disconnect();
      await provider.reconnect();

      // Send hook after reconnect
      await sendHook(port, "SessionStart", { workspacePath });

      expect(statusChanges).toEqual(["idle"]);
    });

    it("connect is idempotent", async () => {
      const port = await serverManager.startServer(workspacePath);

      await provider.connect(port);
      await provider.connect(port); // Second call should be no-op

      const statusChanges: AgentStatus[] = [];
      provider.onStatusChange((status) => statusChanges.push(status));

      // Should still work normally
      await sendHook(port, "SessionStart", { workspacePath });
      expect(statusChanges).toEqual(["idle"]);
    });

    it("reconnect without prior connect does nothing", async () => {
      // No connect called
      await provider.reconnect();

      // Should not throw, just warn
      expect(true).toBe(true);
    });
  });

  describe("status change forwarding", () => {
    it("forwards status changes from ServerManager", async () => {
      const port = await serverManager.startServer(workspacePath);
      await provider.connect(port);

      const statusChanges: AgentStatus[] = [];
      provider.onStatusChange((status) => statusChanges.push(status));

      // Full status cycle
      await sendHook(port, "SessionStart", { workspacePath });
      await sendHook(port, "UserPromptSubmit", { workspacePath });
      await sendHook(port, "Stop", { workspacePath });
      await sendHook(port, "SessionEnd", { workspacePath });

      expect(statusChanges).toEqual(["idle", "busy", "idle", "none"]);
    });

    // TODO: Fix HTTP server isolation issue - socket closed before request completes
    it.skip("multiple subscribers receive changes", async () => {
      const port = await serverManager.startServer(workspacePath);
      await provider.connect(port);

      const statusChanges1: AgentStatus[] = [];
      const statusChanges2: AgentStatus[] = [];
      provider.onStatusChange((status) => statusChanges1.push(status));
      provider.onStatusChange((status) => statusChanges2.push(status));

      await sendHook(port, "SessionStart", { workspacePath });

      expect(statusChanges1).toEqual(["idle"]);
      expect(statusChanges2).toEqual(["idle"]);
    });

    // TODO: Fix HTTP server isolation issue - socket closed before request completes
    it.skip("unsubscribe stops notifications", async () => {
      const port = await serverManager.startServer(workspacePath);
      await provider.connect(port);

      const statusChanges: AgentStatus[] = [];
      const unsubscribe = provider.onStatusChange((status) => statusChanges.push(status));

      await sendHook(port, "SessionStart", { workspacePath });
      expect(statusChanges).toEqual(["idle"]);

      unsubscribe();

      await sendHook(port, "UserPromptSubmit", { workspacePath });
      expect(statusChanges).toEqual(["idle"]); // No new changes
    });
  });

  describe("getSession", () => {
    it("returns null before connect", () => {
      expect(provider.getSession()).toBeNull();
    });

    it("returns null before session starts", async () => {
      const port = await serverManager.startServer(workspacePath);
      await provider.connect(port);

      expect(provider.getSession()).toBeNull();
    });

    // TODO: Fix HTTP server isolation issue - socket closed before request completes
    it.skip("returns session info after SessionStart hook", async () => {
      const port = await serverManager.startServer(workspacePath);
      await provider.connect(port);

      await sendHook(port, "SessionStart", {
        workspacePath,
        session_id: "test-session-123",
      });

      const session = provider.getSession();
      expect(session).not.toBeNull();
      expect(session?.port).toBe(port);
      expect(session?.sessionId).toBe("test-session-123");
    });
  });

  describe("getEnvironmentVariables", () => {
    it("returns empty object before connect", () => {
      expect(provider.getEnvironmentVariables()).toEqual({});
    });

    it("returns environment variables after connect", async () => {
      const port = await serverManager.startServer(workspacePath);
      await provider.connect(port);

      const env = provider.getEnvironmentVariables();

      expect(env).toHaveProperty("CODEHYDRA_CLAUDE_SETTINGS");
      expect(env).toHaveProperty("CODEHYDRA_CLAUDE_MCP_CONFIG");
      expect(env).toHaveProperty("CODEHYDRA_BRIDGE_PORT");
      expect(env).toHaveProperty("CODEHYDRA_MCP_PORT");
      expect(env).toHaveProperty("CODEHYDRA_WORKSPACE_PATH");

      // Check values
      expect(env.CODEHYDRA_BRIDGE_PORT).toBe(String(port));
      expect(env.CODEHYDRA_MCP_PORT).toBe("9999");
      expect(env.CODEHYDRA_WORKSPACE_PATH).toBe(workspacePath);
      expect(env.CODEHYDRA_CLAUDE_SETTINGS).toContain("codehydra-hooks.json");
      expect(env.CODEHYDRA_CLAUDE_MCP_CONFIG).toContain("codehydra-mcp.json");
    });

    it("returns empty MCP port if not configured", async () => {
      // Create server manager without MCP config
      const serverManagerNoMcp = new ClaudeCodeServerManager({
        portManager: createPortManagerMock([17001]),
        pathProvider: mockPathProvider,
        fileSystem: mockFileSystem,
        logger: SILENT_LOGGER,
        config: { hookHandlerPath: "/mock/hook-handler.js" },
      });

      const providerNoMcp = new ClaudeCodeProvider({
        serverManager: serverManagerNoMcp,
        workspacePath,
        logger: SILENT_LOGGER,
      });

      const port = await serverManagerNoMcp.startServer(workspacePath);
      await providerNoMcp.connect(port);

      const env = providerNoMcp.getEnvironmentVariables();
      expect(env.CODEHYDRA_MCP_PORT).toBe("");

      providerNoMcp.dispose();
      await serverManagerNoMcp.dispose();
    });

    it("includes initial prompt file path when prompt is set", async () => {
      const port = await serverManager.startServer(workspacePath);

      // Set initial prompt before connecting
      await serverManager.setInitialPrompt(workspacePath, { prompt: "Hello!" });

      await provider.connect(port);

      const env = provider.getEnvironmentVariables();
      expect(env).toHaveProperty("CODEHYDRA_INITIAL_PROMPT_FILE");
      expect(env.CODEHYDRA_INITIAL_PROMPT_FILE).toContain("initial-prompt.json");
    });

    it("omits initial prompt file path when no prompt is set", async () => {
      const port = await serverManager.startServer(workspacePath);
      await provider.connect(port);

      const env = provider.getEnvironmentVariables();
      expect(env).not.toHaveProperty("CODEHYDRA_INITIAL_PROMPT_FILE");
    });
  });

  describe("markActive", () => {
    it("can be called multiple times safely", async () => {
      const port = await serverManager.startServer(workspacePath);
      await provider.connect(port);

      // Should not throw
      provider.markActive();
      provider.markActive();
      provider.markActive();
    });
  });

  describe("dispose", () => {
    // TODO: Fix HTTP server isolation issue - socket closed before request completes
    it.skip("clears all state", async () => {
      const port = await serverManager.startServer(workspacePath);
      await provider.connect(port);

      const statusChanges: AgentStatus[] = [];
      provider.onStatusChange((status) => statusChanges.push(status));

      provider.dispose();

      // Session should be cleared
      expect(provider.getSession()).toBeNull();

      // Environment variables should be empty
      expect(provider.getEnvironmentVariables()).toEqual({});

      // Status changes should not be received
      await sendHook(port, "SessionStart", { workspacePath });
      expect(statusChanges).toEqual([]);
    });

    it("is safe to call multiple times", () => {
      provider.dispose();
      provider.dispose();
      // Should not throw
    });
  });
});
