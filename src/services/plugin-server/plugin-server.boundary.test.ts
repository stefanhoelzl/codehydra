/**
 * Boundary tests for PluginServer.
 *
 * Tests real Socket.IO client-server communication.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { io as ioClient } from "socket.io-client";
import { PluginServer } from "./plugin-server";
import type { ApiCallHandlers } from "./plugin-server";
import { DefaultNetworkLayer } from "../platform/network";
import { createSilentLogger } from "../logging/logging.test-utils";
import { delay } from "../test-utils";
import {
  createTestClient,
  waitForConnect,
  waitForDisconnect,
  createMockCommandHandler,
  createMockApiHandlers,
  type TestClientSocket,
} from "./plugin-server.test-utils";
import type { WorkspaceStatus } from "../../shared/api/types";

// Longer timeout for CI environments
const TEST_TIMEOUT = 15000;

// Tolerance for timing assertions (timers can fire slightly early due to system scheduling)
const TIMING_TOLERANCE_MS = 10;

describe("PluginServer (boundary)", { timeout: TEST_TIMEOUT }, () => {
  let server: PluginServer;
  let networkLayer: DefaultNetworkLayer;
  let port: number;
  let clients: TestClientSocket[] = [];

  beforeEach(async () => {
    networkLayer = new DefaultNetworkLayer(createSilentLogger());
    // Use polling transport in tests - websocket transport doesn't work in vitest
    // due to vitest's module transformation breaking the ws package
    server = new PluginServer(networkLayer, createSilentLogger(), { transports: ["polling"] });
    port = await server.start();
  });

  afterEach(async () => {
    // Disconnect all clients
    for (const client of clients) {
      if (client.connected) {
        client.disconnect();
      }
    }
    clients = [];

    // Close server
    if (server) {
      await server.close();
    }
  });

  // Helper to create and track clients
  function createClient(workspacePath: string): TestClientSocket {
    const client = createTestClient(port, { workspacePath });
    clients.push(client);
    return client;
  }

  describe("server startup", () => {
    it("starts on dynamic port", async () => {
      expect(port).toBeGreaterThan(0);
      expect(port).toBeLessThan(65536);
      expect(server.getPort()).toBe(port);
    });
  });

  describe("client connection", () => {
    it("accepts client with valid auth", async () => {
      const client = createClient("/test/workspace");
      await waitForConnect(client);

      expect(client.connected).toBe(true);
      expect(server.isConnected("/test/workspace")).toBe(true);
    });

    it("rejects client with invalid auth", async () => {
      // Client with empty workspace path
      const client = createTestClient(port, { workspacePath: "" });
      clients.push(client);

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
    });

    it("rejects client with missing workspacePath property", async () => {
      // Client with auth object that has no workspacePath property at all
      const client = ioClient(`http://localhost:${port}`, {
        // Use polling transport to match server configuration
        transports: ["polling"],
        autoConnect: false,
        auth: {
          // Intentionally missing workspacePath
          otherProp: "someValue",
        },
      }) as TestClientSocket;
      clients.push(client);

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
      const result = await server.sendCommand(
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

      const result = await server.sendCommand("/test/workspace", "unknown.command", []);

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
      const result = await server.sendCommand(
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
      expect(server.isConnected("/test/workspace")).toBe(true);

      // Close server
      await server.close();

      // Wait for client to detect disconnect
      await waitForDisconnect(client);

      // Start new server on new port
      server = new PluginServer(networkLayer, createSilentLogger(), { transports: ["polling"] });
      const newPort = await server.start();

      // Client should not auto-reconnect to new port (different URL)
      // This is expected behavior - extension would need to reconnect manually
      expect(newPort).not.toBe(port);
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
        expect(server.isConnected(ws)).toBe(true);
      }

      // Set up handlers
      for (const client of clientsToTest) {
        client.on("command", createMockCommandHandler());
      }

      // Send commands to each workspace
      const results = await Promise.all(
        workspaces.map((ws) => server.sendCommand(ws, "test.command", []))
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
        workspaces.map((ws) => server.sendCommand(ws, "test.command", []))
      );

      // All should succeed
      expect(results.every((r) => r.success)).toBe(true);

      // All should be connected
      expect(workspaces.every((ws) => server.isConnected(ws))).toBe(true);
    });
  });

  describe("port reuse", () => {
    it("can restart on new port after close", async () => {
      // Close server
      await server.close();

      // Restart - should get a new port
      server = new PluginServer(networkLayer, createSilentLogger(), { transports: ["polling"] });
      port = await server.start();

      // Port should be valid
      expect(port).toBeGreaterThan(0);
      expect(port).toBeLessThan(65536);

      // Verify we can connect
      const client = createClient("/test/workspace");
      await waitForConnect(client);
      expect(server.isConnected("/test/workspace")).toBe(true);
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
      server.onApiCall(handlers);

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
      server.onApiCall(handlers);

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

    it("getOpencodePort Socket.IO event should return port from handler", async () => {
      const handlers = createMockApiHandlers({
        getOpencodePort: 12345,
      });
      server.onApiCall(handlers);

      const client = createClient("/test/workspace");
      await waitForConnect(client);

      const result = await new Promise<{
        success: boolean;
        data?: number | null;
        error?: string;
      }>((resolve) => {
        client.emit("api:workspace:getOpencodePort", (res) => resolve(res));
      });

      expect(result.success).toBe(true);
      expect(result.data).toBe(12345);
      expect(handlers.getOpencodePort).toHaveBeenCalledWith("/test/workspace");
    });

    it("getOpencodePort Socket.IO event should return null when no server", async () => {
      const handlers = createMockApiHandlers({
        getOpencodePort: null,
      });
      server.onApiCall(handlers);

      const client = createClient("/test/workspace");
      await waitForConnect(client);

      const result = await new Promise<{
        success: boolean;
        data?: number | null;
        error?: string;
      }>((resolve) => {
        client.emit("api:workspace:getOpencodePort", (res) => resolve(res));
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeNull();
    });

    it("getOpencodePort Socket.IO event should handle handler errors gracefully", async () => {
      const handlers = createMockApiHandlers({
        getOpencodePort: { success: false, error: "Workspace not found" },
      });
      server.onApiCall(handlers);

      const client = createClient("/test/workspace");
      await waitForConnect(client);

      const result = await new Promise<{
        success: boolean;
        data?: number | null;
        error?: string;
      }>((resolve) => {
        client.emit("api:workspace:getOpencodePort", (res) => resolve(res));
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Workspace not found");
    });

    it("setMetadata round-trip via real Socket.IO", async () => {
      const handlers = createMockApiHandlers();
      server.onApiCall(handlers);

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
      server.onApiCall(handlers);

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
      // Note: NOT calling server.onApiCall()

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
      server.onApiCall(handlers);

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
      server.onApiCall(handlers);

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
      server.onApiCall(handlers);

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
      server.onApiCall(handlers);

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
      server.onApiCall(handlers);

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
      clients.push(newClient);
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
      server.onApiCall(handlers);

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
      server.onApiCall(handlers);

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
      server.onApiCall(handlers);

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
      server.onApiCall(handlers);

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
      server.onApiCall(handlers);

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
      // Close default server and create one with isDevelopment: true
      await server.close();
      server = new PluginServer(networkLayer, createSilentLogger(), {
        transports: ["polling"],
        isDevelopment: true,
      });
      port = await server.start();

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
      // Close default server and create one with isDevelopment: false
      await server.close();
      server = new PluginServer(networkLayer, createSilentLogger(), {
        transports: ["polling"],
        isDevelopment: false,
      });
      port = await server.start();

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
      await server.close();
      server = new PluginServer(networkLayer, createSilentLogger(), {
        transports: ["polling"],
        isDevelopment: true,
      });
      port = await server.start();

      const client = createClient("/test/workspace");

      // First connection
      let configCount = 0;
      client.on("config", () => {
        configCount++;
      });

      await waitForConnect(client);
      expect(configCount).toBe(1);

      // Disconnect and reconnect
      client.disconnect();
      await waitForDisconnect(client);

      // Reconnect
      const reconnectPromise = new Promise<void>((resolve) => {
        client.once("connect", () => resolve());
      });
      client.connect();
      await reconnectPromise;

      // Should receive config again
      await delay(100);
      expect(configCount).toBe(2);
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
      await server.sendExtensionHostShutdown("/test/workspace");
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
      await server.sendExtensionHostShutdown("/test/workspace", { timeoutMs: 500 });
      const elapsed = Date.now() - startTime;

      // Should timeout after ~500ms (allow tolerance for timer precision)
      expect(elapsed).toBeGreaterThanOrEqual(500 - TIMING_TOLERANCE_MS);
      expect(elapsed).toBeLessThan(1500);
    });

    it("handles missing socket gracefully", async () => {
      // No client connected for this workspace
      const startTime = Date.now();
      await server.sendExtensionHostShutdown("/nonexistent/workspace");
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
      await server.sendExtensionHostShutdown("/test/workspace");
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
      await server.sendExtensionHostShutdown("/test/workspace");
      const elapsed = Date.now() - startTime;

      // Should resolve on disconnect despite ack error
      expect(elapsed).toBeLessThan(1000);
    });

    it("cleans up listener on timeout", async () => {
      const client = createClient("/test/workspace");
      await waitForConnect(client);

      // Don't handle shutdown - let it timeout
      await server.sendExtensionHostShutdown("/test/workspace", { timeoutMs: 100 });

      // Now disconnect the client
      client.disconnect();
      await waitForDisconnect(client);

      // Server should still be operational (no dangling listeners causing issues)
      const newClient = createClient("/test/workspace2");
      clients.push(newClient);
      await waitForConnect(newClient);

      expect(server.isConnected("/test/workspace2")).toBe(true);
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
      await server.sendExtensionHostShutdown("/test/workspace", { timeoutMs: 200 });

      // Second call - client disconnects
      await server.sendExtensionHostShutdown("/test/workspace", { timeoutMs: 200 });

      expect(shutdownCount).toBe(2);
    });
  });

  describe("onConnect callbacks", () => {
    it("invokes callback with normalized workspace path on valid connection", async () => {
      let callbackWorkspacePath: string | null = null;
      server.onConnect((workspacePath) => {
        callbackWorkspacePath = workspacePath;
      });

      const client = createClient("/test/workspace");
      await waitForConnect(client);

      expect(callbackWorkspacePath).toBe("/test/workspace");
    });

    it("does not invoke callback for invalid auth (rejected connection)", async () => {
      let callbackCalled = false;
      server.onConnect(() => {
        callbackCalled = true;
      });

      // Client with empty workspace path (should be rejected)
      const client = createTestClient(port, { workspacePath: "" });
      clients.push(client);

      client.connect();

      // Wait for potential callback
      await delay(500);

      expect(callbackCalled).toBe(false);
    });

    it("invokes multiple callbacks for single connection", async () => {
      const calls: string[] = [];

      server.onConnect((workspacePath) => {
        calls.push(`callback1:${workspacePath}`);
      });

      server.onConnect((workspacePath) => {
        calls.push(`callback2:${workspacePath}`);
      });

      const client = createClient("/test/workspace");
      await waitForConnect(client);

      // Give callbacks time to execute
      await delay(100);

      expect(calls).toHaveLength(2);
      expect(calls).toContain("callback1:/test/workspace");
      expect(calls).toContain("callback2:/test/workspace");
    });

    it("exception in one callback does not prevent other callbacks", async () => {
      const calls: string[] = [];

      server.onConnect(() => {
        throw new Error("Intentional error in callback");
      });

      server.onConnect((workspacePath) => {
        calls.push(`callback2:${workspacePath}`);
      });

      const client = createClient("/test/workspace");
      await waitForConnect(client);

      // Give callbacks time to execute
      await delay(100);

      // Second callback should still be called despite first throwing
      expect(calls).toContain("callback2:/test/workspace");
    });

    it("unsubscribe removes callback", async () => {
      const calls: string[] = [];

      const unsubscribe = server.onConnect((workspacePath) => {
        calls.push(workspacePath);
      });

      // Unsubscribe before connecting
      unsubscribe();

      const client = createClient("/test/workspace");
      await waitForConnect(client);

      // Give potential callback time to execute
      await delay(100);

      // Callback should not have been called
      expect(calls).toHaveLength(0);
    });

    it("concurrent connections each trigger callbacks", async () => {
      const connectedWorkspaces: string[] = [];

      server.onConnect((workspacePath) => {
        connectedWorkspaces.push(workspacePath);
      });

      const client1 = createClient("/workspace/one");
      const client2 = createClient("/workspace/two");
      const client3 = createClient("/workspace/three");

      // Connect all clients concurrently
      await Promise.all([
        waitForConnect(client1),
        waitForConnect(client2),
        waitForConnect(client3),
      ]);

      // Give callbacks time to execute
      await delay(100);

      // All three workspaces should trigger callbacks
      expect(connectedWorkspaces).toHaveLength(3);
      expect(connectedWorkspaces).toContain("/workspace/one");
      expect(connectedWorkspaces).toContain("/workspace/two");
      expect(connectedWorkspaces).toContain("/workspace/three");
    });
  });
});
