/**
 * Boundary tests for the plugin server module.
 *
 * Tests real Socket.IO client-server communication through the module's hooks.
 * API call tests verify that client-emitted events dispatch correct intents
 * through the mock dispatcher and return results via Socket.IO acks.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { io as ioClient } from "socket.io-client";
import { IntentHandle } from "../intents/infrastructure/dispatcher";
import type { Intent } from "../intents/infrastructure/types";
import { delay } from "@shared/test-fixtures";
import {
  createTestClient,
  createPluginServerEnv,
  waitForConnect,
  waitForDisconnect,
  createMockCommandHandler,
  type TestClientSocket,
} from "./plugin-server.test-utils";
import type { WorkspaceStatus } from "../../shared/api/types";
import type { PluginConfig } from "../../shared/plugin-protocol";
import { INTENT_GET_WORKSPACE_STATUS } from "../operations/get-workspace-status";
import { INTENT_GET_AGENT_SESSION } from "../operations/get-agent-session";
import { INTENT_SET_METADATA } from "../operations/set-metadata";
import { INTENT_DELETE_WORKSPACE } from "../operations/delete-workspace";
import { INTENT_VSCODE_COMMAND } from "../operations/vscode-command";
import { INTENT_RESOLVE_WORKSPACE } from "../operations/resolve-workspace";
import { INTENT_OPEN_WORKSPACE } from "../operations/open-workspace";

// Longer timeout for CI environments
const TEST_TIMEOUT = 15000;

// Tolerance for timing assertions (timers can fire slightly early due to system scheduling)
const TIMING_TOLERANCE_MS = 10;

describe("PluginServer (boundary)", { timeout: TEST_TIMEOUT }, () => {
  let env: Awaited<ReturnType<typeof createPluginServerEnv>>;
  beforeEach(async () => {
    env = await createPluginServerEnv();
  });
  afterEach(() => env.cleanup());
  function createClient(workspacePath: string) {
    return env.createClient(workspacePath);
  }

  describe("server startup", () => {
    it("starts on dynamic port", async () => {
      expect(env.port).toBeGreaterThan(0);
      expect(env.port).toBeLessThan(65536);
    });
  });

  describe("client connection", () => {
    it("accepts client with valid auth", async () => {
      const client = createClient("/test/workspace");
      await waitForConnect(client);

      expect(client.connected).toBe(true);
    });

    it("rejects client with invalid auth", async () => {
      // Client with empty workspace path
      const client = createTestClient(env.port, { workspacePath: "" });

      let rejected = false;
      client.on("disconnect", () => {
        rejected = true;
      });
      client.on("connect_error", () => {
        rejected = true;
      });

      client.connect();

      // Wait for rejection
      await delay(500);

      expect(rejected || !client.connected).toBe(true);
      client.disconnect();
    });

    it("rejects client with missing workspacePath property", async () => {
      // Client with auth object that has no workspacePath property at all
      const client = ioClient(`http://127.0.0.1:${env.port}`, {
        transports: ["polling"],
        autoConnect: false,
        auth: {
          otherProp: "someValue",
        },
      }) as TestClientSocket;

      let rejected = false;
      client.on("disconnect", () => {
        rejected = true;
      });
      client.on("connect_error", () => {
        rejected = true;
      });

      client.connect();

      // Wait for rejection
      await delay(500);

      expect(rejected || !client.connected).toBe(true);
      client.disconnect();
    });
  });

  describe("command round-trip", () => {
    it("sends command and receives acknowledgment", async () => {
      const client = createClient("/test/workspace");
      await waitForConnect(client);

      // Set up command handler on client
      const handler = createMockCommandHandler({
        defaultResult: { success: true, data: "command executed" },
      });
      client.on("command", handler);

      // Send command from server via vscode-command hook
      const result = await env.sendCommand("/test/workspace", "workbench.action.closeSidebar", []);

      expect(result).toBe("command executed");
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("throws when client acks with error", async () => {
      const client = createClient("/test/workspace");
      await waitForConnect(client);

      // Set up handler that returns an error
      const handler = createMockCommandHandler({
        defaultResult: { success: false, error: "Command failed" },
      });
      client.on("command", handler);

      await expect(env.sendCommand("/test/workspace", "unknown.command", [])).rejects.toThrow(
        "Command failed"
      );
    });

    it("times out when client does not ack", async () => {
      const client = createClient("/test/workspace");
      await waitForConnect(client);

      // Handler that never acks
      client.on("command", () => {
        // Intentionally do not call ack
      });

      const start = Date.now();
      await expect(env.sendCommand("/test/workspace", "test.command", [])).rejects.toThrow(
        "Command timed out"
      );
      const elapsed = Date.now() - start;

      // Should time out at COMMAND_TIMEOUT_MS (10s default)
      expect(elapsed).toBeGreaterThanOrEqual(10000 - TIMING_TOLERANCE_MS);
    });
  });

  describe("reconnection behavior", () => {
    it("client reconnects after server restart", async () => {
      const client = createClient("/test/workspace");

      // Configure for fast reconnection
      (client.io.opts as { reconnectionDelay: number }).reconnectionDelay = 100;
      (client.io.opts as { reconnectionDelayMax: number }).reconnectionDelayMax = 200;

      await waitForConnect(client);
      const oldPort = env.port;

      // Close server and all clients, then start fresh
      await env.cleanup();
      env = await createPluginServerEnv();

      // Client should not auto-reconnect to new port (different URL)
      expect(env.port).not.toBe(oldPort);
    });
  });

  describe("multiple clients", () => {
    it("handles multiple workspace connections simultaneously", async () => {
      const workspaces = ["/workspace/a", "/workspace/b", "/workspace/c"];
      const clientsToTest = workspaces.map((ws) => createClient(ws));

      // Connect all clients
      await Promise.all(clientsToTest.map((c) => waitForConnect(c)));

      // Set up handlers
      for (const client of clientsToTest) {
        client.on("command", createMockCommandHandler());
      }

      // Send commands to each workspace via hooks
      const results = await Promise.all(
        workspaces.map((ws) => env.sendCommand(ws, "test.command", []))
      );

      // All should succeed (return undefined from default handler)
      expect(results).toHaveLength(3);
    });

    it("handles 10 concurrent workspace connections (stress test)", async () => {
      const workspaces = Array.from({ length: 10 }, (_, i) => `/workspace/${i}`);
      const clientsToTest = workspaces.map((ws) => createClient(ws));

      // Connect all clients in parallel
      await Promise.all(clientsToTest.map((c) => waitForConnect(c)));

      // Set up handlers on all clients
      for (const client of clientsToTest) {
        client.on("command", createMockCommandHandler());
      }

      // Send commands to all workspaces in parallel
      const results = await Promise.allSettled(
        workspaces.map((ws) => env.sendCommand(ws, "test.command", []))
      );

      // All should succeed
      expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    });
  });

  describe("port reuse", () => {
    it("can restart on new port after close", async () => {
      await env.cleanup();
      env = await createPluginServerEnv();

      // Port should be valid
      expect(env.port).toBeGreaterThan(0);
      expect(env.port).toBeLessThan(65536);

      // Verify we can connect
      const client = createClient("/test/workspace");
      await waitForConnect(client);
    });
  });

  describe("API calls", () => {
    it("getStatus round-trip via real Socket.IO", async () => {
      const status = {
        isDirty: true,
        unmergedCommits: 0,
        agent: { type: "busy" as const, counts: { idle: 0, busy: 1, total: 1 } },
      };
      env.mockDispatch.mockImplementation(() => {
        const handle = new IntentHandle();
        handle.signalAccepted(true);
        handle.resolve(status);
        return handle;
      });

      const client = createClient("/test/workspace");
      await waitForConnect(client);

      // Emit API call and wait for response
      const result = await new Promise<{
        success: boolean;
        data?: WorkspaceStatus;
        error?: string;
      }>((resolve) => {
        client.emit("api:workspace:getStatus", (res) => resolve(res));
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(status);
      expect(env.mockDispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: INTENT_GET_WORKSPACE_STATUS,
          payload: { workspacePath: "/test/workspace" },
        })
      );
    });

    it("getMetadata round-trip via real Socket.IO", async () => {
      const metadata = { base: "develop", note: "testing" };
      env.mockDispatch.mockImplementation(() => {
        const handle = new IntentHandle();
        handle.signalAccepted(true);
        handle.resolve(metadata);
        return handle;
      });

      const client = createClient("/test/workspace");
      await waitForConnect(client);

      const result = await new Promise<{
        success: boolean;
        data?: Record<string, string>;
        error?: string;
      }>((resolve) => {
        client.emit("api:workspace:getMetadata", (res) => resolve(res));
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(metadata);
    });

    it("getAgentSession Socket.IO event should return session from handler", async () => {
      const session = { port: 12345, sessionId: "session-abc123" };
      env.mockDispatch.mockImplementation(() => {
        const handle = new IntentHandle();
        handle.signalAccepted(true);
        handle.resolve(session);
        return handle;
      });

      const client = createClient("/test/workspace");
      await waitForConnect(client);

      const result = await new Promise<{
        success: boolean;
        data?: { port: number; sessionId: string } | null;
        error?: string;
      }>((resolve) => {
        client.emit("api:workspace:getAgentSession", (res) => resolve(res));
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(session);
      expect(env.mockDispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: INTENT_GET_AGENT_SESSION,
          payload: { workspacePath: "/test/workspace" },
        })
      );
    });

    it("getAgentSession Socket.IO event should return null when no server", async () => {
      env.mockDispatch.mockImplementation(() => {
        const handle = new IntentHandle();
        handle.signalAccepted(true);
        handle.resolve(null);
        return handle;
      });

      const client = createClient("/test/workspace");
      await waitForConnect(client);

      const result = await new Promise<{
        success: boolean;
        data?: { port: number; sessionId: string } | null;
        error?: string;
      }>((resolve) => {
        client.emit("api:workspace:getAgentSession", (res) => resolve(res));
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeNull();
    });

    it("getAgentSession Socket.IO event should handle dispatch errors gracefully", async () => {
      env.mockDispatch.mockImplementation(() => {
        const handle = new IntentHandle();
        handle.signalAccepted(true);
        handle.reject(new Error("Workspace not found"));
        return handle;
      });

      const client = createClient("/test/workspace");
      await waitForConnect(client);

      const result = await new Promise<{
        success: boolean;
        data?: { port: number; sessionId: string } | null;
        error?: string;
      }>((resolve) => {
        client.emit("api:workspace:getAgentSession", (res) => resolve(res));
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Workspace not found");
    });

    it("setMetadata round-trip via real Socket.IO", async () => {
      env.mockDispatch.mockImplementation(() => {
        const handle = new IntentHandle();
        handle.signalAccepted(true);
        handle.resolve(undefined);
        return handle;
      });

      const client = createClient("/test/workspace");
      await waitForConnect(client);

      const result = await new Promise<{ success: boolean; error?: string }>((resolve) => {
        client.emit("api:workspace:setMetadata", { key: "note", value: "my note" }, (res) =>
          resolve(res)
        );
      });

      expect(result.success).toBe(true);
      expect(env.mockDispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: INTENT_SET_METADATA,
          payload: { workspacePath: "/test/workspace", key: "note", value: "my note" },
        })
      );
    });

    it("setMetadata validates request before calling handler", async () => {
      const client = createClient("/test/workspace");
      await waitForConnect(client);

      // Send invalid request (empty key)
      const result = await new Promise<{ success: boolean; error?: string }>((resolve) => {
        client.emit("api:workspace:setMetadata", { key: "", value: "test" }, (res) => resolve(res));
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("cannot be empty");
      // Dispatcher should NOT be called for invalid requests
      expect(env.mockDispatch).not.toHaveBeenCalled();
    });

    it("passes workspace path from socket.data to callback", async () => {
      env.mockDispatch.mockImplementation(() => {
        const handle = new IntentHandle();
        handle.signalAccepted(true);
        handle.resolve({ isDirty: false, unmergedCommits: 0, agent: { type: "none" } });
        return handle;
      });

      // Connect with specific workspace path
      const client = createClient("/my/special/workspace");
      await waitForConnect(client);

      await new Promise<{ success: boolean }>((resolve) => {
        client.emit("api:workspace:getStatus", (res) => resolve(res));
      });

      expect(env.mockDispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: INTENT_GET_WORKSPACE_STATUS,
          payload: { workspacePath: "/my/special/workspace" },
        })
      );
    });

    it("handles concurrent API calls from different workspaces", async () => {
      env.mockDispatch.mockImplementation(() => {
        const handle = new IntentHandle();
        handle.signalAccepted(true);
        handle.resolve({ isDirty: false, unmergedCommits: 0, agent: { type: "none" } });
        return handle;
      });

      const client1 = createClient("/workspace/one");
      const client2 = createClient("/workspace/two");

      await Promise.all([waitForConnect(client1), waitForConnect(client2)]);

      // Make concurrent calls
      const [result1, result2] = await Promise.all([
        new Promise<{ success: boolean }>((resolve) => {
          client1.emit("api:workspace:getStatus", (res) => resolve(res));
        }),
        new Promise<{ success: boolean }>((resolve) => {
          client2.emit("api:workspace:getStatus", (res) => resolve(res));
        }),
      ]);

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      expect(env.mockDispatch).toHaveBeenCalledTimes(2);
    });

    it("handles rapid sequential calls from same workspace", async () => {
      let callCount = 0;
      env.mockDispatch.mockImplementation(() => {
        callCount++;
        const handle = new IntentHandle();
        handle.signalAccepted(true);
        handle.resolve({ isDirty: false, unmergedCommits: 0, agent: { type: "none" } });
        return handle;
      });

      const client = createClient("/test/workspace");
      await waitForConnect(client);

      // Make rapid sequential calls
      const results = await Promise.all([
        new Promise<{ success: boolean }>((resolve) => {
          client.emit("api:workspace:getStatus", (res) => resolve(res));
        }),
        new Promise<{ success: boolean }>((resolve) => {
          client.emit("api:workspace:getStatus", (res) => resolve(res));
        }),
        new Promise<{ success: boolean }>((resolve) => {
          client.emit("api:workspace:getStatus", (res) => resolve(res));
        }),
      ]);

      expect(results.every((r) => r.success)).toBe(true);
      expect(callCount).toBe(3);
    });

    it("handles dispatch exception gracefully", async () => {
      env.mockDispatch.mockImplementation(() => {
        const handle = new IntentHandle();
        handle.signalAccepted(true);
        handle.reject(new Error("Database error"));
        return handle;
      });

      const client = createClient("/test/workspace");
      await waitForConnect(client);

      const result = await new Promise<{ success: boolean; error?: string }>((resolve) => {
        client.emit("api:workspace:getStatus", (res) => resolve(res));
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Database error");
    });

    it("executeCommand round-trip via real Socket.IO", async () => {
      env.mockDispatch.mockImplementation(() => {
        const handle = new IntentHandle();
        handle.signalAccepted(true);
        handle.resolve("command result");
        return handle;
      });

      const client = createClient("/test/workspace");
      await waitForConnect(client);

      const result = await new Promise<{
        success: boolean;
        data?: unknown;
        error?: string;
      }>((resolve) => {
        client.emit(
          "api:workspace:executeCommand",
          { command: "test.command", args: ["arg1", "arg2"] },
          (res) => resolve(res)
        );
      });

      expect(result.success).toBe(true);
      expect(result.data).toBe("command result");
      expect(env.mockDispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: INTENT_VSCODE_COMMAND,
          payload: expect.objectContaining({
            workspacePath: "/test/workspace",
            command: "test.command",
          }),
        })
      );
    });

    it("executeCommand returns undefined for commands that return nothing", async () => {
      env.mockDispatch.mockImplementation(() => {
        const handle = new IntentHandle();
        handle.signalAccepted(true);
        handle.resolve(undefined);
        return handle;
      });

      const client = createClient("/test/workspace");
      await waitForConnect(client);

      const result = await new Promise<{
        success: boolean;
        data?: unknown;
        error?: string;
      }>((resolve) => {
        client.emit(
          "api:workspace:executeCommand",
          { command: "workbench.action.files.saveAll" },
          (res) => resolve(res)
        );
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeUndefined();
    });

    it("executeCommand validates request before calling handler", async () => {
      const client = createClient("/test/workspace");
      await waitForConnect(client);

      // Send invalid request (empty command)
      const result = await new Promise<{ success: boolean; error?: string }>((resolve) => {
        client.emit("api:workspace:executeCommand", { command: "" }, (res) => resolve(res));
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("cannot be empty");
      // Dispatcher should NOT be called for invalid requests
      expect(env.mockDispatch).not.toHaveBeenCalled();
    });

    it("executeCommand handles dispatch errors gracefully", async () => {
      env.mockDispatch.mockImplementation(() => {
        const handle = new IntentHandle();
        handle.signalAccepted(true);
        handle.reject(new Error("Command not found: invalid.command"));
        return handle;
      });

      const client = createClient("/test/workspace");
      await waitForConnect(client);

      const result = await new Promise<{
        success: boolean;
        data?: unknown;
        error?: string;
      }>((resolve) => {
        client.emit("api:workspace:executeCommand", { command: "invalid.command" }, (res) =>
          resolve(res)
        );
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Command not found: invalid.command");
    });

    it("delete returns started:true when accepted", async () => {
      env.mockDispatch.mockImplementation(() => {
        const handle = new IntentHandle();
        handle.signalAccepted(true);
        handle.resolve(undefined);
        return handle;
      });

      const client = createClient("/test/workspace");
      await waitForConnect(client);

      const result = await new Promise<{
        success: boolean;
        data?: { started: boolean };
        error?: string;
      }>((resolve) => {
        client.emit("api:workspace:delete", {}, (res) => resolve(res));
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ started: true });
      }
      expect(env.mockDispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: INTENT_DELETE_WORKSPACE,
          payload: expect.objectContaining({
            workspacePath: "/test/workspace",
            keepBranch: true,
            force: false,
            removeWorktree: true,
          }),
        })
      );
    });

    it("delete returns started:false when rejected by interceptor", async () => {
      env.mockDispatch.mockImplementation(() => {
        const handle = new IntentHandle();
        handle.signalAccepted(false);
        handle.resolve(undefined);
        return handle;
      });

      const client = createClient("/test/workspace");
      await waitForConnect(client);

      const result = await new Promise<{
        success: boolean;
        data?: { started: boolean };
        error?: string;
      }>((resolve) => {
        client.emit("api:workspace:delete", {}, (res) => resolve(res));
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ started: false });
      }
    });

    it("create dispatches correct intent with optional fields", async () => {
      const workspace = {
        projectId: "proj-1",
        name: "my-ws",
        branch: "my-ws",
        metadata: {},
        path: "/workspaces/my-ws",
      };
      const resolvedProject = { projectPath: "/project/path", workspaceName: "caller-ws" };
      env.mockDispatch.mockImplementation((intent: Intent) => {
        const handle = new IntentHandle();
        handle.signalAccepted(true);
        if (intent.type === INTENT_RESOLVE_WORKSPACE) {
          handle.resolve(resolvedProject);
        } else {
          handle.resolve(workspace);
        }
        return handle;
      });

      const client = createClient("/test/workspace");
      await waitForConnect(client);

      const result = await new Promise<{
        success: boolean;
        data?: unknown;
        error?: string;
      }>((resolve) => {
        client.emit(
          "api:workspace:create",
          {
            name: "my-ws",
            base: "main",
            initialPrompt: "Do something",
            stealFocus: false,
          },
          (res) => resolve(res)
        );
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(workspace);
      }
      expect(env.mockDispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: INTENT_OPEN_WORKSPACE,
          payload: expect.objectContaining({
            projectPath: "/project/path",
            workspaceName: "my-ws",
            base: "main",
            initialPrompt: "Do something",
            stealFocus: false,
          }),
        })
      );
    });
  });

  describe("config event", () => {
    it("sends config with isDevelopment: true when configured", async () => {
      await env.cleanup();
      env = await createPluginServerEnv({ isDevelopment: true });

      const client = createClient("/test/workspace");

      const configPromise = new Promise<{ isDevelopment: boolean }>((resolve) => {
        client.on("config", (config) => {
          resolve(config);
        });
      });

      await waitForConnect(client);
      const config = await configPromise;

      expect(config.isDevelopment).toBe(true);
    });

    it("sends config with isDevelopment: false when configured", async () => {
      await env.cleanup();
      env = await createPluginServerEnv({ isDevelopment: false });

      const client = createClient("/test/workspace");

      const configPromise = new Promise<{ isDevelopment: boolean }>((resolve) => {
        client.on("config", (config) => {
          resolve(config);
        });
      });

      await waitForConnect(client);
      const config = await configPromise;

      expect(config.isDevelopment).toBe(false);
    });

    it("sends config with isDevelopment: false by default", async () => {
      const client = createClient("/test/workspace");

      const configPromise = new Promise<{ isDevelopment: boolean }>((resolve) => {
        client.on("config", (config) => {
          resolve(config);
        });
      });

      await waitForConnect(client);
      const config = await configPromise;

      expect(config.isDevelopment).toBe(false);
    });

    it("sends config event on reconnection", async () => {
      await env.cleanup();
      env = await createPluginServerEnv({ isDevelopment: true });

      const client = createClient("/test/workspace");

      let configCount = 0;
      const firstConfigPromise = new Promise<void>((resolve) => {
        client.once("config", () => {
          configCount++;
          resolve();
        });
      });

      await waitForConnect(client);
      await firstConfigPromise;
      expect(configCount).toBe(1);

      // Disconnect and reconnect
      client.disconnect();
      await waitForDisconnect(client);

      const secondConfigPromise = new Promise<void>((resolve) => {
        client.once("config", () => {
          configCount++;
          resolve();
        });
      });

      client.connect();
      await secondConfigPromise;

      expect(configCount).toBe(2);
    });

    it("sends config with agent type when client connects", async () => {
      // Store workspace config via the finalize hook
      await env.setWorkspaceConfig("/test/workspace", {}, "opencode", true);

      const client = createClient("/test/workspace");
      const configPromise = new Promise<PluginConfig>((resolve) => {
        client.on("config", (config) => resolve(config));
      });

      await waitForConnect(client);
      const config = await configPromise;

      expect(config.isDevelopment).toBe(false);
      expect(config.agentType).toBe("opencode");
    });

    it("sends config with environment variables", async () => {
      await env.setWorkspaceConfig(
        "/test/workspace",
        { TEST_VAR: "test-value", ANOTHER_VAR: "another" },
        "opencode",
        true
      );

      const client = createClient("/test/workspace");
      const configPromise = new Promise<PluginConfig>((resolve) => {
        client.on("config", (config) => resolve(config));
      });

      await waitForConnect(client);
      const config = await configPromise;

      expect(config.env).toEqual({ TEST_VAR: "test-value", ANOTHER_VAR: "another" });
    });

    it("sends config with null env when no config stored", async () => {
      const client = createClient("/test/workspace");
      const configPromise = new Promise<PluginConfig>((resolve) => {
        client.on("config", (config) => resolve(config));
      });

      await waitForConnect(client);
      const config = await configPromise;

      expect(config.env).toBeNull();
    });

    it("handles concurrent workspace connections independently", async () => {
      await env.setWorkspaceConfig(
        "/workspace/one",
        { WORKSPACE: "/workspace/one" },
        "opencode",
        true
      );
      await env.setWorkspaceConfig(
        "/workspace/two",
        { WORKSPACE: "/workspace/two" },
        "opencode",
        true
      );

      const client1 = createClient("/workspace/one");
      const client2 = createClient("/workspace/two");

      const config1Promise = new Promise<PluginConfig>((resolve) => {
        client1.on("config", (config) => resolve(config));
      });
      const config2Promise = new Promise<PluginConfig>((resolve) => {
        client2.on("config", (config) => resolve(config));
      });

      await Promise.all([waitForConnect(client1), waitForConnect(client2)]);
      const [config1, config2] = await Promise.all([config1Promise, config2Promise]);

      expect(config1.env).toEqual({ WORKSPACE: "/workspace/one" });
      expect(config2.env).toEqual({ WORKSPACE: "/workspace/two" });
    });
  });

  describe("UI events", () => {
    it("showNotification round-trip with action", async () => {
      const client = createClient("/test/workspace");
      await waitForConnect(client);

      client.on("ui:showNotification", (request, ack) => {
        expect(request.severity).toBe("info");
        expect(request.message).toBe("Continue?");
        expect(request.actions).toEqual(["Yes", "No"]);
        ack({ success: true, data: { action: "Yes" } });
      });

      const result = await env.showNotification("/test/workspace", {
        severity: "info",
        message: "Continue?",
        actions: ["Yes", "No"],
      });

      expect(result).toBe("Yes");
    });

    it("showNotification fire-and-forget without actions", async () => {
      const client = createClient("/test/workspace");
      await waitForConnect(client);

      client.on("ui:showNotification", (request, ack) => {
        expect(request.severity).toBe("warning");
        expect(request.message).toBe("Something happened");
        expect(request.actions).toBeUndefined();
        ack({ success: true, data: { action: null } });
      });

      const result = await env.showNotification("/test/workspace", {
        severity: "warning",
        message: "Something happened",
      });

      expect(result).toBeNull();
    });

    it("showNotification throws when workspace not connected", async () => {
      await expect(
        env.showNotification("/nonexistent", {
          severity: "info",
          message: "test",
        })
      ).rejects.toThrow("Workspace not connected");
    });

    it("updateStatusBar round-trip", async () => {
      const client = createClient("/test/workspace");
      await waitForConnect(client);

      client.on("ui:statusBarUpdate", (request, ack) => {
        expect(request.id).toBe("mcp");
        expect(request.text).toBe("$(sync~spin) Building...");
        expect(request.tooltip).toBe("Build in progress");
        ack({ success: true, data: undefined });
      });

      const result = await env.updateStatusBar("/test/workspace", {
        text: "$(sync~spin) Building...",
        tooltip: "Build in progress",
      });

      expect(result).toBeNull();
    });

    it("disposeStatusBar round-trip", async () => {
      const client = createClient("/test/workspace");
      await waitForConnect(client);

      client.on("ui:statusBarDispose", (request, ack) => {
        expect(request.id).toBe("mcp");
        ack({ success: true, data: undefined });
      });

      const result = await env.disposeStatusBar("/test/workspace");

      expect(result).toBeNull();
    });

    it("showQuickPick round-trip with selection", async () => {
      const client = createClient("/test/workspace");
      await waitForConnect(client);

      client.on("ui:showQuickPick", (request, ack) => {
        expect(request.items).toEqual([{ label: "Option A" }, { label: "Option B" }]);
        expect(request.placeholder).toBe("Select an option...");
        ack({ success: true, data: { selected: "Option A" } });
      });

      const result = await env.showQuickPick("/test/workspace", {
        items: [{ label: "Option A" }, { label: "Option B" }],
        placeholder: "Select an option...",
      });

      expect(result).toBe("Option A");
    });

    it("showInputBox round-trip with value", async () => {
      const client = createClient("/test/workspace");
      await waitForConnect(client);

      client.on("ui:showInputBox", (request, ack) => {
        expect(request.prompt).toBe("Workspace name");
        expect(request.placeholder).toBe("my-workspace");
        ack({ success: true, data: { value: "user-input" } });
      });

      const result = await env.showInputBox("/test/workspace", {
        prompt: "Workspace name",
        placeholder: "my-workspace",
      });

      expect(result).toBe("user-input");
    });

    it("showNotification times out when client does not ack", async () => {
      const client = createClient("/test/workspace");
      await waitForConnect(client);

      // Handler that never acks
      client.on("ui:showNotification", () => {
        // Intentionally do not call ack
      });

      const start = Date.now();
      await expect(
        env.showNotification(
          "/test/workspace",
          { severity: "info", message: "test", actions: ["OK"] },
          500
        )
      ).rejects.toThrow("UI event timed out");
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(500 - TIMING_TOLERANCE_MS);
      expect(elapsed).toBeLessThan(2000);
    });
  });
});
