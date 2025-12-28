/**
 * Boundary tests for sendShutdownCommand.
 *
 * Tests real Socket.IO client-server communication for shutdown commands.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PluginServer } from "./plugin-server";
import { sendShutdownCommand, SHUTDOWN_COMMAND } from "./shutdown-commands";
import { DefaultNetworkLayer } from "../platform/network";
import { createSilentLogger, createMockLogger } from "../logging/logging.test-utils";
import {
  createTestClient,
  waitForConnect,
  createMockCommandHandler,
  type TestClientSocket,
} from "./plugin-server.test-utils";

// Longer timeout for CI environments
const TEST_TIMEOUT = 15000;

// Tolerance for timing assertions (timers can fire slightly early due to system scheduling)
const TIMING_TOLERANCE_MS = 10;

describe("sendShutdownCommand (boundary)", { timeout: TEST_TIMEOUT }, () => {
  let server: PluginServer;
  let networkLayer: DefaultNetworkLayer;
  let port: number;
  let clients: TestClientSocket[] = [];

  beforeEach(async () => {
    networkLayer = new DefaultNetworkLayer(createSilentLogger());
    // Use polling transport in tests - websocket transport doesn't work in vitest
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

  describe("sendShutdownCommand real socket", () => {
    it("sends shutdown command via real Socket.IO connection", async () => {
      const client = createClient("/test/workspace");
      await waitForConnect(client);

      // Set up command handler on client
      const handler = createMockCommandHandler({
        defaultResult: { success: true, data: undefined },
      });
      client.on("command", handler);

      const logger = createMockLogger();

      // Send shutdown command
      await sendShutdownCommand(server, "/test/workspace", logger);

      // Verify command was sent correctly
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          command: SHUTDOWN_COMMAND,
          args: [],
        }),
        expect.any(Function) // ack callback
      );

      // Verify debug log
      expect(logger.debug).toHaveBeenCalledWith("Shutdown command executed", {
        workspace: "/test/workspace",
        command: SHUTDOWN_COMMAND,
      });
    });

    it("handles client acknowledgment via real connection", async () => {
      const client = createClient("/test/workspace");
      await waitForConnect(client);

      // Set up handler that succeeds
      const handler = createMockCommandHandler({
        defaultResult: { success: true, data: "terminals killed" },
      });
      client.on("command", handler);

      const logger = createMockLogger();

      // Should complete without throwing
      await expect(sendShutdownCommand(server, "/test/workspace", logger)).resolves.not.toThrow();

      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("handles client error response via real connection", async () => {
      const client = createClient("/test/workspace");
      await waitForConnect(client);

      // Set up handler that returns error
      const handler = createMockCommandHandler({
        defaultResult: { success: false, error: "No terminals to kill" },
      });
      client.on("command", handler);

      const logger = createMockLogger();

      // Should complete without throwing (best-effort)
      await expect(sendShutdownCommand(server, "/test/workspace", logger)).resolves.not.toThrow();

      // Should log warning
      expect(logger.warn).toHaveBeenCalledWith("Shutdown command failed", {
        workspace: "/test/workspace",
        command: SHUTDOWN_COMMAND,
        error: "No terminals to kill",
      });
    });
  });

  describe("sendShutdownCommand real timeout", () => {
    it("times out when client does not acknowledge", async () => {
      const client = createClient("/test/workspace");
      await waitForConnect(client);

      // Handler that never acks
      client.on("command", () => {
        // Intentionally do not call ack
      });

      const logger = createMockLogger();

      // Should complete (after timeout) without throwing
      const start = Date.now();
      await expect(sendShutdownCommand(server, "/test/workspace", logger)).resolves.not.toThrow();
      const elapsed = Date.now() - start;

      // Should have taken at least the timeout period (5000ms)
      // Allow tolerance for timer precision and some test margin
      expect(elapsed).toBeGreaterThanOrEqual(5000 - TIMING_TOLERANCE_MS - 500);

      // Should log warning about timeout
      expect(logger.warn).toHaveBeenCalledWith("Shutdown command failed", {
        workspace: "/test/workspace",
        command: SHUTDOWN_COMMAND,
        error: "Command timed out",
      });
    });
  });

  describe("sendShutdownCommand not connected", () => {
    it("skips command when workspace not connected", async () => {
      // Don't connect any client
      const logger = createMockLogger();

      // Should complete immediately without error
      await expect(
        sendShutdownCommand(server, "/nonexistent/workspace", logger)
      ).resolves.not.toThrow();

      // Should log debug (not warning)
      expect(logger.debug).toHaveBeenCalledWith(
        "Shutdown command skipped: workspace not connected",
        { workspace: "/nonexistent/workspace" }
      );
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });
});
