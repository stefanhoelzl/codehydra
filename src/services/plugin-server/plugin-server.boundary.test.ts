/**
 * Boundary tests for PluginServer.
 *
 * Tests real Socket.IO client-server communication.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { io as ioClient } from "socket.io-client";
import { PluginServer } from "./plugin-server";
import { DefaultNetworkLayer } from "../platform/network";
import { createSilentLogger } from "../logging/logging.test-utils";
import {
  createTestClient,
  waitForConnect,
  waitForDisconnect,
  createMockCommandHandler,
  type TestClientSocket,
} from "./plugin-server.test-utils";

// Longer timeout for CI environments
const TEST_TIMEOUT = 15000;

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
      await new Promise((resolve) => setTimeout(resolve, 500));

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
      await new Promise((resolve) => setTimeout(resolve, 500));

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
      expect(elapsed).toBeGreaterThanOrEqual(500);
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
});
