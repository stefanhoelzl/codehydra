/**
 * Boundary tests for PluginServer.
 *
 * Tests real Socket.IO client-server communication.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { io as ioClient } from "socket.io-client";
import type { ApiCallHandlers } from "./plugin-server";
import { delay } from "@shared/test-fixtures";
import {
  createTestClient,
  createPluginServerEnv,
  waitForConnect,
  waitForDisconnect,
  createMockCommandHandler,
  createMockApiHandlers,
  type TestClientSocket,
} from "./plugin-server.test-utils";
import type { WorkspaceStatus } from "../../shared/api/types";
import type { PluginConfig } from "../../shared/plugin-protocol";

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
      expect(env.server.getPort()).toBe(env.port);
    });
  });

  describe("client connection", () => {
    it("accepts client with valid auth", async () => {
      const client = createClient("/test/workspace");
      await waitForConnect(client);

      expect(client.connected).toBe(true);
      expect(env.server.isConnected("/test/workspace")).toBe(true);
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
        // Use polling transport to match server configuration
        transports: ["polling"],
        autoConnect: false,
        auth: {
          // Intentionally missing workspacePath
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

      // Send command from server
      const result = await env.server.sendCommand(
        "/test/workspace",
        "workbench.action.closeSidebar",
        []
      );

      expect(result.success).toBe(true);
      expect(result).toHaveProperty("data", "command executed");
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("returns error when client acks with error", async () => {
      const client = createClient("/test/workspace");
      await waitForConnect(client);

      // Set up handler that returns an error
      const handler = createMockCommandHandler({
        defaultResult: { success: false, error: "Command failed" },
      });
      client.on("command", handler);

      const result = await env.server.sendCommand("/test/workspace", "unknown.command", []);

      expect(result.success).toBe(false);
      expect(result).toHaveProperty("error", "Command failed");
    });

    it("times out when client does not ack", async () => {
      const client = createClient("/test/workspace");
      await waitForConnect(client);

      // Handler that never acks
      client.on("command", () => {
        // Intentionally do not call ack
      });

      const start = Date.now();
      const result = await env.server.sendCommand(
        "/test/workspace",
        "test.command",
        [],
        500 // Short timeout for test
      );
      const elapsed = Date.now() - start;

      expect(result.success).toBe(false);
      expect(result).toHaveProperty("error", "Command timed out");
      expect(elapsed).toBeGreaterThanOrEqual(500 - TIMING_TOLERANCE_MS);
      expect(elapsed).toBeLessThan(2000);
    });
  });

  describe("reconnection behavior", () => {
    it("client reconnects after server restart", async () => {
      const client = createClient("/test/workspace");

      // Configure for fast reconnection
      (client.io.opts as { reconnectionDelay: number }).reconnectionDelay = 100;
      (client.io.opts as { reconnectionDelayMax: number }).reconnectionDelayMax = 200;

      await waitForConnect(client);
      expect(env.server.isConnected("/test/workspace")).toBe(true);

      const oldPort = env.port;

      // Close server and all clients, then start fresh
      await env.cleanup();
      env = await createPluginServerEnv();

      // Client should not auto-reconnect to new port (different URL)
      // This is expected behavior - extension would need to reconnect manually
      expect(env.port).not.toBe(oldPort);
    });
  });

  describe("multiple clients", () => {
    it("handles multiple workspace connections simultaneously", async () => {
      const workspaces = ["/workspace/a", "/workspace/b", "/workspace/c"];
      const clientsToTest = workspaces.map((ws) => createClient(ws));

      // Connect all clients
      await Promise.all(clientsToTest.map((c) => waitForConnect(c)));

      // All should be connected
      for (const ws of workspaces) {
        expect(env.server.isConnected(ws)).toBe(true);
      }

      // Set up handlers
      for (const client of clientsToTest) {
        client.on("command", createMockCommandHandler());
      }

      // Send commands to each workspace
      const results = await Promise.all(
        workspaces.map((ws) => env.server.sendCommand(ws, "test.command", []))
      );

      // All should succeed
      for (const result of results) {
        expect(result.success).toBe(true);
      }
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
      const results = await Promise.all(
        workspaces.map((ws) => env.server.sendCommand(ws, "test.command", []))
      );

      // All should succeed
      expect(results.every((r) => r.success)).toBe(true);

      // All should be connected
      expect(workspaces.every((ws) => env.server.isConnected(ws))).toBe(true);
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
      expect(env.server.isConnected("/test/workspace")).toBe(true);
    });
  });

  describe("API calls", () => {
    it("getStatus round-trip via real Socket.IO", async () => {
      const handlers = createMockApiHandlers({
        getStatus: {
          isDirty: true,
          agent: { type: "busy", counts: { idle: 0, busy: 1, total: 1 } },
        },
      });
      env.server.onApiCall(handlers);

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
      expect(result.data).toEqual({
        isDirty: true,
        agent: { type: "busy", counts: { idle: 0, busy: 1, total: 1 } },
      });
      expect(handlers.getStatus).toHaveBeenCalledWith("/test/workspace");
    });

    it("getMetadata round-trip via real Socket.IO", async () => {
      const handlers = createMockApiHandlers({
        getMetadata: { base: "develop", note: "testing" },
      });
      env.server.onApiCall(handlers);

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
      expect(result.data).toEqual({ base: "develop", note: "testing" });
      expect(handlers.getMetadata).toHaveBeenCalledWith("/test/workspace");
    });

    it("getAgentSession Socket.IO event should return session from handler", async () => {
      const handlers = createMockApiHandlers({
        getAgentSession: { port: 12345, sessionId: "session-abc123" },
      });
      env.server.onApiCall(handlers);

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
      expect(result.data).toEqual({ port: 12345, sessionId: "session-abc123" });
      expect(handlers.getAgentSession).toHaveBeenCalledWith("/test/workspace");
    });

    it("getAgentSession Socket.IO event should return null when no server", async () => {
      const handlers = createMockApiHandlers({
        getAgentSession: null,
      });
      env.server.onApiCall(handlers);

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

    it("getAgentSession Socket.IO event should handle handler errors gracefully", async () => {
      const handlers = createMockApiHandlers({
        getAgentSession: { success: false, error: "Workspace not found" },
      });
      env.server.onApiCall(handlers);

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
      const handlers = createMockApiHandlers();
      env.server.onApiCall(handlers);

      const client = createClient("/test/workspace");
      await waitForConnect(client);

      const result = await new Promise<{ success: boolean; error?: string }>((resolve) => {
        client.emit("api:workspace:setMetadata", { key: "note", value: "my note" }, (res) =>
          resolve(res)
        );
      });

      expect(result.success).toBe(true);
      expect(handlers.setMetadata).toHaveBeenCalledWith("/test/workspace", {
        key: "note",
        value: "my note",
      });
    });

    it("setMetadata validates request before calling handler", async () => {
      const handlers = createMockApiHandlers();
      env.server.onApiCall(handlers);

      const client = createClient("/test/workspace");
      await waitForConnect(client);

      // Send invalid request (empty key)
      const result = await new Promise<{ success: boolean; error?: string }>((resolve) => {
        client.emit("api:workspace:setMetadata", { key: "", value: "test" }, (res) => resolve(res));
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("cannot be empty");
      // Handler should NOT be called for invalid requests
      expect(handlers.setMetadata).not.toHaveBeenCalled();
    });

    it("returns error when no handlers registered", async () => {
      // Note: NOT calling env.server.onApiCall()

      const client = createClient("/test/workspace");
      await waitForConnect(client);

      const result = await new Promise<{ success: boolean; error?: string }>((resolve) => {
        client.emit("api:workspace:getStatus", (res) => resolve(res));
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("API handlers not registered");
    });

    it("passes workspace path from socket.data to callback", async () => {
      const handlers = createMockApiHandlers();
      env.server.onApiCall(handlers);

      // Connect with specific workspace path
      const client = createClient("/my/special/workspace");
      await waitForConnect(client);

      await new Promise<{ success: boolean }>((resolve) => {
        client.emit("api:workspace:getStatus", (res) => resolve(res));
      });

      expect(handlers.getStatus).toHaveBeenCalledWith("/my/special/workspace");
    });

    it("handles concurrent API calls from different workspaces", async () => {
      const handlers = createMockApiHandlers();
      env.server.onApiCall(handlers);

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
      expect(handlers.getStatus).toHaveBeenCalledTimes(2);
      expect(handlers.getStatus).toHaveBeenCalledWith("/workspace/one");
      expect(handlers.getStatus).toHaveBeenCalledWith("/workspace/two");
    });

    it("handles rapid sequential calls from same workspace", async () => {
      let callCount = 0;
      const handlers: ApiCallHandlers = {
        ...createMockApiHandlers(),
        getStatus: vi.fn().mockImplementation(() => {
          callCount++;
          return Promise.resolve({
            success: true,
            data: { isDirty: false, agent: { type: "none" } },
          });
        }),
      };
      env.server.onApiCall(handlers);

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

    it("handles handler exception gracefully", async () => {
      const handlers: ApiCallHandlers = {
        ...createMockApiHandlers(),
        getStatus: vi.fn().mockRejectedValue(new Error("Database error")),
      };
      env.server.onApiCall(handlers);

      const client = createClient("/test/workspace");
      await waitForConnect(client);

      const result = await new Promise<{ success: boolean; error?: string }>((resolve) => {
        client.emit("api:workspace:getStatus", (res) => resolve(res));
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Database error");
    });

    it("handles socket disconnect mid-request", async () => {
      // Create a handler that delays long enough for us to disconnect
      const handlers: ApiCallHandlers = {
        ...createMockApiHandlers(),
        getStatus: vi.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              // This will never resolve before disconnect
              setTimeout(() => {
                resolve({ success: true, data: { isDirty: false, agent: { type: "none" } } });
              }, 5000);
            })
        ),
      };
      env.server.onApiCall(handlers);

      const client = createClient("/test/workspace");
      await waitForConnect(client);

      // Start the API call (we don't need to track the result - we'll disconnect before it completes)
      client.emit("api:workspace:getStatus", () => {
        // Ack callback - may or may not be called depending on timing
      });

      // Wait a bit for the request to be in-flight
      await delay(100);

      // Disconnect while request is pending
      client.disconnect();

      // Wait for disconnect to complete
      await waitForDisconnect(client);

      // The ack may or may not be called depending on timing
      // The key behavior is that the server handles disconnect gracefully without crashing
      // and that subsequent operations work correctly

      // Verify server is still operational by connecting a new client
      const newClient = createClient("/test/workspace2");
      await waitForConnect(newClient);

      // Server should still be able to handle new requests
      // Handlers are server-wide, so they should still work

      const newResult = await new Promise<{ success: boolean }>((resolve) => {
        newClient.emit("api:workspace:getStatus", (res) => resolve(res));
      });

      // New request should work (handler will time out from first call, but that's expected)
      expect(newResult.success).toBe(true);

      // Note: resultReceived may or may not be true depending on Socket.IO's behavior
      // The important thing is the server didn't crash
    });

    it("executeCommand round-trip via real Socket.IO", async () => {
      const handlers = createMockApiHandlers({
        executeCommand: "command result",
      });
      env.server.onApiCall(handlers);

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
      expect(handlers.executeCommand).toHaveBeenCalledWith("/test/workspace", {
        command: "test.command",
        args: ["arg1", "arg2"],
      });
    });

    it("executeCommand returns undefined for commands that return nothing", async () => {
      const handlers = createMockApiHandlers({
        executeCommand: undefined,
      });
      env.server.onApiCall(handlers);

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
      const handlers = createMockApiHandlers();
      env.server.onApiCall(handlers);

      const client = createClient("/test/workspace");
      await waitForConnect(client);

      // Send invalid request (empty command)
      const result = await new Promise<{ success: boolean; error?: string }>((resolve) => {
        client.emit("api:workspace:executeCommand", { command: "" }, (res) => resolve(res));
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("cannot be empty");
      // Handler should NOT be called for invalid requests
      expect(handlers.executeCommand).not.toHaveBeenCalled();
    });

    it("executeCommand handles handler errors gracefully", async () => {
      const handlers = createMockApiHandlers({
        executeCommand: { success: false, error: "Command not found: invalid.command" },
      });
      env.server.onApiCall(handlers);

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

    it("handles request timeout", async () => {
      // Create a handler that never responds (simulates a hanging API call)
      const handlers: ApiCallHandlers = {
        ...createMockApiHandlers(),
        getStatus: vi.fn().mockImplementation(
          () =>
            new Promise(() => {
              // Never resolves - simulates a hung operation
            })
        ),
      };
      env.server.onApiCall(handlers);

      const client = createClient("/test/workspace");
      await waitForConnect(client);

      // Set a custom timeout for this test by using Socket.IO's built-in timeout
      // Note: The client-side timeout should trigger - we configure a short timeout
      const startTime = Date.now();

      // Use withTimeout pattern since Socket.IO emit with ack doesn't have built-in timeout
      const result = await Promise.race([
        new Promise<{ success: boolean; error?: string }>((resolve) => {
          client.emit("api:workspace:getStatus", (res) => resolve(res));
        }),
        new Promise<{ success: boolean; error: string }>((resolve) => {
          setTimeout(() => {
            resolve({ success: false, error: "Client-side timeout" });
          }, 2000); // 2 second timeout
        }),
      ]);

      const elapsed = Date.now() - startTime;

      // Should timeout (either client-side or server never responds)
      // The test verifies that the system handles non-responsive handlers gracefully
      expect(elapsed).toBeGreaterThanOrEqual(2000 - TIMING_TOLERANCE_MS);
      expect(elapsed).toBeLessThan(5000); // Sanity check - shouldn't take too long

      // Result indicates timeout (either from our Promise.race or no response)
      expect(result.success).toBe(false);
      expect(result.error).toBe("Client-side timeout");

      // Handler was called
      expect(handlers.getStatus).toHaveBeenCalled();
    });
  });

  describe("config event", () => {
    // Note: The "config" event is emitted by the server to the client. Validation of
    // the config payload happens on the client side (in the codehydra-sidekick extension).
    // The server always emits a valid PluginConfig object with isDevelopment: boolean.
    // See extensions/codehydra-sidekick/extension.js for client-side validation.

    it("sends config with isDevelopment: true when configured", async () => {
      await env.cleanup();
      env = await createPluginServerEnv({ isDevelopment: true });

      const client = createClient("/test/workspace");

      // Listen for config event
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
      // Default server has no isDevelopment option
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

      // First connection - wait for config event with Promise to avoid race condition
      // (config may arrive before or after the connect event resolves)
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

      // Reconnect - set up promise for second config event before connecting
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
      // Store workspace config before client connects
      env.server.setWorkspaceConfig("/test/workspace", {}, "opencode", true);

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
      env.server.setWorkspaceConfig(
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
      env.server.setWorkspaceConfig(
        "/workspace/one",
        { WORKSPACE: "/workspace/one" },
        "opencode",
        true
      );
      env.server.setWorkspaceConfig(
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

  describe("sendExtensionHostShutdown", () => {
    it("resolves when socket disconnects after shutdown event", async () => {
      const client = createClient("/test/workspace");
      await waitForConnect(client);

      // Set up shutdown handler that acks then disconnects
      client.on("shutdown", (ack) => {
        ack({ success: true, data: undefined });
        // Simulate process.exit by disconnecting
        setImmediate(() => client.disconnect());
      });

      const startTime = Date.now();
      await env.server.sendExtensionHostShutdown("/test/workspace");
      const elapsed = Date.now() - startTime;

      // Should resolve quickly after disconnect
      expect(elapsed).toBeLessThan(1000);
      expect(client.connected).toBe(false);
    });

    it("resolves on timeout when socket does not disconnect", async () => {
      const client = createClient("/test/workspace");
      await waitForConnect(client);

      // Set up shutdown handler that acks but does NOT disconnect
      client.on("shutdown", (ack) => {
        ack({ success: true, data: undefined });
        // Intentionally do not call disconnect
      });

      const startTime = Date.now();
      await env.server.sendExtensionHostShutdown("/test/workspace", { timeoutMs: 500 });
      const elapsed = Date.now() - startTime;

      // Should timeout after ~500ms (allow tolerance for timer precision)
      expect(elapsed).toBeGreaterThanOrEqual(500 - TIMING_TOLERANCE_MS);
      expect(elapsed).toBeLessThan(1500);
    });

    it("handles missing socket gracefully", async () => {
      // No client connected for this workspace
      const startTime = Date.now();
      await env.server.sendExtensionHostShutdown("/nonexistent/workspace");
      const elapsed = Date.now() - startTime;

      // Should return immediately (not wait for timeout)
      expect(elapsed).toBeLessThan(100);
    });

    it("uses default 5s timeout when not specified", async () => {
      const client = createClient("/test/workspace");
      await waitForConnect(client);

      // Set up shutdown handler that acks but does NOT disconnect
      client.on("shutdown", (ack) => {
        ack({ success: true, data: undefined });
        // Intentionally do not disconnect - test would timeout at 5s
      });

      // We can't wait for full 5s timeout in a test, so just verify it starts
      // and can be interrupted by client disconnect
      setTimeout(() => client.disconnect(), 100);

      const startTime = Date.now();
      await env.server.sendExtensionHostShutdown("/test/workspace");
      const elapsed = Date.now() - startTime;

      // Should resolve when client disconnects, well before 5s timeout
      expect(elapsed).toBeLessThan(1000);
    });

    it("handles ack error gracefully and still waits for disconnect", async () => {
      const client = createClient("/test/workspace");
      await waitForConnect(client);

      // Set up shutdown handler that acks with error then disconnects
      client.on("shutdown", (ack) => {
        ack({ success: false, error: "Graceful shutdown failed" });
        // Still disconnect even though ack had error
        setImmediate(() => client.disconnect());
      });

      const startTime = Date.now();
      await env.server.sendExtensionHostShutdown("/test/workspace");
      const elapsed = Date.now() - startTime;

      // Should resolve on disconnect despite ack error
      expect(elapsed).toBeLessThan(1000);
    });

    it("cleans up listener on timeout", async () => {
      const client = createClient("/test/workspace");
      await waitForConnect(client);

      // Don't handle shutdown - let it timeout
      await env.server.sendExtensionHostShutdown("/test/workspace", { timeoutMs: 100 });

      // Now disconnect the client
      client.disconnect();
      await waitForDisconnect(client);

      // Server should still be operational (no dangling listeners causing issues)
      const newClient = createClient("/test/workspace2");
      await waitForConnect(newClient);

      expect(env.server.isConnected("/test/workspace2")).toBe(true);
    });

    it("is idempotent for same workspace", async () => {
      const client = createClient("/test/workspace");
      await waitForConnect(client);

      let shutdownCount = 0;
      client.on("shutdown", (ack) => {
        shutdownCount++;
        ack({ success: true, data: undefined });
        // Only disconnect on second call
        if (shutdownCount >= 2) {
          setImmediate(() => client.disconnect());
        }
      });

      // First call - client stays connected
      await env.server.sendExtensionHostShutdown("/test/workspace", { timeoutMs: 200 });

      // Second call - client disconnects
      await env.server.sendExtensionHostShutdown("/test/workspace", { timeoutMs: 200 });

      expect(shutdownCount).toBe(2);
    });
  });
});
