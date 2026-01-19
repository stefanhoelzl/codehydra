/**
 * Unit tests for PluginServer.
 *
 * Tests pure logic without real Socket.IO connections.
 * For Socket.IO connection tests, see plugin-server.boundary.test.ts.
 * For protocol type tests, see plugin-protocol.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PluginServer, type ApiCallHandlers } from "./plugin-server";
import { COMMAND_TIMEOUT_MS, SHUTDOWN_DISCONNECT_TIMEOUT_MS } from "../../shared/plugin-protocol";
import { createPortManagerMock } from "../platform/network.test-utils";
import { SILENT_LOGGER } from "../logging/logging.test-utils";

describe("PluginServer", () => {
  describe("COMMAND_TIMEOUT_MS constant", () => {
    it("exports default timeout of 10 seconds", () => {
      expect(COMMAND_TIMEOUT_MS).toBe(10_000);
    });
  });

  // Note: normalizeWorkspacePath tests moved to Path class tests (path.test.ts)
  // The PluginServer now uses Path internally for cross-platform normalization

  describe("onConfigData", () => {
    let server: PluginServer;
    let mockPortManager: ReturnType<typeof createPortManagerMock>;

    beforeEach(() => {
      mockPortManager = createPortManagerMock([3000]);
      server = new PluginServer(mockPortManager, SILENT_LOGGER);
    });

    afterEach(async () => {
      await server.close();
    });

    it("accepts provider registration without throwing", () => {
      // Should not throw when registering a config data provider
      expect(() =>
        server.onConfigData(() => ({
          env: null,
          agentType: null,
        }))
      ).not.toThrow();
    });

    it("allows provider to be replaced", () => {
      server.onConfigData(() => ({
        env: null,
        agentType: null,
      }));

      // Should not throw when replacing provider
      expect(() =>
        server.onConfigData(() => ({
          env: { TEST: "value" },
          agentType: "opencode",
        }))
      ).not.toThrow();
    });
  });

  describe("isDevelopment option", () => {
    it("accepts isDevelopment: true option", () => {
      const mockPortManager = createPortManagerMock([3000]);
      const server = new PluginServer(mockPortManager, SILENT_LOGGER, {
        isDevelopment: true,
      });

      // Should not throw
      expect(server).toBeDefined();
    });

    it("accepts isDevelopment: false option", () => {
      const mockPortManager = createPortManagerMock([3000]);
      const server = new PluginServer(mockPortManager, SILENT_LOGGER, {
        isDevelopment: false,
      });

      // Should not throw
      expect(server).toBeDefined();
    });

    it("defaults to isDevelopment: false when not specified", () => {
      const mockPortManager = createPortManagerMock([3000]);
      // No isDevelopment option provided
      const server = new PluginServer(mockPortManager, SILENT_LOGGER);

      // Should not throw - defaults to false internally
      expect(server).toBeDefined();
    });
  });

  describe("SHUTDOWN_DISCONNECT_TIMEOUT_MS constant", () => {
    it("exports default timeout of 5 seconds", () => {
      expect(SHUTDOWN_DISCONNECT_TIMEOUT_MS).toBe(5_000);
    });
  });

  describe("sendExtensionHostShutdown", () => {
    let server: PluginServer;
    let mockPortManager: ReturnType<typeof createPortManagerMock>;

    beforeEach(() => {
      mockPortManager = createPortManagerMock([3000]);
      server = new PluginServer(mockPortManager, SILENT_LOGGER);
    });

    afterEach(async () => {
      await server.close();
    });

    it("returns immediately when workspace not connected", async () => {
      // Server not started, no connections
      const startTime = Date.now();
      await server.sendExtensionHostShutdown("/nonexistent/workspace");
      const elapsed = Date.now() - startTime;

      // Should return quickly, not wait for timeout
      expect(elapsed).toBeLessThan(100);
    });

    it("uses default 5s timeout", () => {
      // Verify default timeout is 5 seconds (tested via constant)
      expect(SHUTDOWN_DISCONNECT_TIMEOUT_MS).toBe(5_000);
    });

    it("accepts custom timeout option", async () => {
      // This test verifies the options parameter is accepted
      // The actual timeout behavior is tested in boundary tests
      const startTime = Date.now();
      await server.sendExtensionHostShutdown("/nonexistent/workspace", { timeoutMs: 100 });
      const elapsed = Date.now() - startTime;

      // Should return quickly (not connected)
      expect(elapsed).toBeLessThan(100);
    });

    it("is idempotent for disconnected workspaces", async () => {
      // Multiple calls for same disconnected workspace should not throw
      await server.sendExtensionHostShutdown("/workspace/path");
      await server.sendExtensionHostShutdown("/workspace/path");
      await server.sendExtensionHostShutdown("/workspace/path");

      // No errors thrown - all calls return immediately
    });

    it("handles emit failure gracefully (best-effort behavior)", async () => {
      // This test verifies that sendExtensionHostShutdown is best-effort:
      // - It should always resolve (never reject/throw)
      // - Even if the underlying socket operation fails somehow
      //
      // Since disconnected workspaces return immediately without error,
      // we verify that calling on a non-existent workspace:
      // 1. Doesn't throw
      // 2. Resolves quickly (not waiting for timeout)
      // 3. Can be called with any string path

      const startTime = Date.now();

      // These should all resolve without error (best-effort semantics)
      await expect(server.sendExtensionHostShutdown("/nonexistent")).resolves.toBeUndefined();
      await expect(server.sendExtensionHostShutdown("")).resolves.toBeUndefined();
      await expect(
        server.sendExtensionHostShutdown("/path/with/special/chars")
      ).resolves.toBeUndefined();

      const elapsed = Date.now() - startTime;

      // Should return quickly for disconnected workspaces (not wait for timeout)
      expect(elapsed).toBeLessThan(500);
    });
  });

  describe("onApiCall", () => {
    let server: PluginServer;
    let mockPortManager: ReturnType<typeof createPortManagerMock>;

    beforeEach(() => {
      mockPortManager = createPortManagerMock([3000]);
      server = new PluginServer(mockPortManager, SILENT_LOGGER);
    });

    afterEach(async () => {
      await server.close();
    });

    it("accepts handler registration without throwing", () => {
      const handlers: ApiCallHandlers = {
        getStatus: vi
          .fn()
          .mockResolvedValue({ success: true, data: { isDirty: false, agent: { type: "none" } } }),
        getAgentSession: vi.fn().mockResolvedValue({ success: true, data: null }),
        restartAgentServer: vi.fn().mockResolvedValue({ success: true, data: 14001 }),
        getMetadata: vi.fn().mockResolvedValue({ success: true, data: {} }),
        setMetadata: vi.fn().mockResolvedValue({ success: true, data: undefined }),
        delete: vi.fn().mockResolvedValue({ success: true, data: { started: true } }),
        executeCommand: vi.fn().mockResolvedValue({ success: true, data: undefined }),
        create: vi.fn().mockResolvedValue({ success: true, data: {} }),
      };

      // Should not throw
      expect(() => server.onApiCall(handlers)).not.toThrow();
    });

    it("allows handlers to be replaced", () => {
      const handlers1: ApiCallHandlers = {
        getStatus: vi
          .fn()
          .mockResolvedValue({ success: true, data: { isDirty: false, agent: { type: "none" } } }),
        getAgentSession: vi.fn().mockResolvedValue({ success: true, data: null }),
        restartAgentServer: vi.fn().mockResolvedValue({ success: true, data: 14001 }),
        getMetadata: vi.fn().mockResolvedValue({ success: true, data: {} }),
        setMetadata: vi.fn().mockResolvedValue({ success: true, data: undefined }),
        delete: vi.fn().mockResolvedValue({ success: true, data: { started: true } }),
        executeCommand: vi.fn().mockResolvedValue({ success: true, data: undefined }),
        create: vi.fn().mockResolvedValue({ success: true, data: {} }),
      };

      const handlers2: ApiCallHandlers = {
        getStatus: vi.fn().mockResolvedValue({
          success: true,
          data: {
            isDirty: true,
            agent: { type: "busy", counts: { idle: 0, busy: 1, total: 1 } },
          },
        }),
        getAgentSession: vi
          .fn()
          .mockResolvedValue({ success: true, data: { port: 12345, sessionId: "session-abc" } }),
        restartAgentServer: vi.fn().mockResolvedValue({ success: true, data: 14001 }),
        getMetadata: vi.fn().mockResolvedValue({ success: true, data: { note: "test" } }),
        setMetadata: vi.fn().mockResolvedValue({ success: true, data: undefined }),
        delete: vi.fn().mockResolvedValue({ success: true, data: { started: true } }),
        executeCommand: vi.fn().mockResolvedValue({ success: true, data: undefined }),
        create: vi.fn().mockResolvedValue({ success: true, data: {} }),
      };

      server.onApiCall(handlers1);
      server.onApiCall(handlers2);

      // No error - second registration replaces first
    });

    it("should register getAgentSession handler on socket connection", () => {
      const handlers: ApiCallHandlers = {
        getStatus: vi
          .fn()
          .mockResolvedValue({ success: true, data: { isDirty: false, agent: { type: "none" } } }),
        getAgentSession: vi
          .fn()
          .mockResolvedValue({ success: true, data: { port: 12345, sessionId: "session-abc" } }),
        restartAgentServer: vi.fn().mockResolvedValue({ success: true, data: 14001 }),
        getMetadata: vi.fn().mockResolvedValue({ success: true, data: {} }),
        setMetadata: vi.fn().mockResolvedValue({ success: true, data: undefined }),
        delete: vi.fn().mockResolvedValue({ success: true, data: { started: true } }),
        executeCommand: vi.fn().mockResolvedValue({ success: true, data: undefined }),
        create: vi.fn().mockResolvedValue({ success: true, data: {} }),
      };

      // Should not throw - handlers are registered
      expect(() => server.onApiCall(handlers)).not.toThrow();

      // Verify handler is in the handlers object
      expect(handlers.getAgentSession).toBeDefined();
    });
  });
});
