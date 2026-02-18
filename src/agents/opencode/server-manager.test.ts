// @vitest-environment node
/**
 * Tests for OpenCodeServerManager.
 *
 * Tests the managed OpenCode server lifecycle:
 * - startServer: allocates port, spawns process, health check, stores port in memory
 * - stopServer: graceful shutdown, cleanup
 * - stopAllForProject: bulk cleanup
 * - dispose: full cleanup on shutdown
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenCodeServerManager } from "./server-manager";
import {
  createMockProcessRunner,
  type MockProcessRunner,
} from "../../services/platform/process.state-mock";
import { createMockPathProvider } from "../../services/platform/path-provider.test-utils";
import {
  createPortManagerMock,
  type MockPortManager,
} from "../../services/platform/network.test-utils";
import { SILENT_LOGGER } from "../../services/logging";
import type { HttpClient } from "../../services/platform/network";
import type { PathProvider } from "../../services/platform/path-provider";

/**
 * Create a mock HttpClient with vitest spies.
 */
function createTestHttpClient(options?: {
  error?: Error;
  response?: Response;
}): HttpClient & { fetch: ReturnType<typeof vi.fn> } {
  const defaultResponse = new Response(JSON.stringify({ status: "ok" }), { status: 200 });
  return {
    fetch: options?.error
      ? vi.fn().mockRejectedValue(options.error)
      : vi.fn().mockResolvedValue(options?.response ?? defaultResponse),
  };
}

/**
 * Create a mock PathProvider for testing.
 * Uses the standard createMockPathProvider which returns Path objects.
 */
function createTestPathProvider(): PathProvider {
  return createMockPathProvider();
}

describe("OpenCodeServerManager", () => {
  // Common dependencies
  let mockProcessRunner: MockProcessRunner;
  let mockPortManager: MockPortManager;
  let mockHttpClient: ReturnType<typeof createTestHttpClient>;
  let mockPathProvider: PathProvider;
  let manager: OpenCodeServerManager;

  beforeEach(() => {
    vi.clearAllMocks();

    // Create mock process runner with default behavior
    mockProcessRunner = createMockProcessRunner({
      onSpawn: () => ({
        pid: 12345,
        killResult: { success: true, reason: "SIGTERM" },
      }),
    });

    mockPortManager = createPortManagerMock([14001]);
    mockHttpClient = createTestHttpClient();
    mockPathProvider = createTestPathProvider();

    manager = new OpenCodeServerManager(
      mockProcessRunner,
      mockPortManager,
      mockHttpClient,
      mockPathProvider,
      SILENT_LOGGER
    );
  });

  afterEach(async () => {
    await manager.dispose();
  });

  describe("startServer", () => {
    it("allocates port and spawns process", async () => {
      const port = await manager.startServer("/workspace/feature-a");

      expect(port).toBe(14001);
      expect(mockProcessRunner).toHaveSpawned([
        {
          command: expect.stringContaining("opencode") as string,
          args: expect.arrayContaining(["serve", "--port", "14001"]) as unknown as string[],
          cwd: "/workspace/feature-a",
        },
      ]);
    });

    it("stores port in memory after health check passes", async () => {
      await manager.startServer("/workspace/feature-a");

      expect(manager.getPort("/workspace/feature-a")).toBe(14001);
    });

    it("fires onServerStarted callback with path, port, and undefined pending prompt", async () => {
      const callback = vi.fn();
      manager.onServerStarted(callback);

      await manager.startServer("/workspace/feature-a");

      expect(callback).toHaveBeenCalledWith("/workspace/feature-a", 14001, undefined);
    });

    it("throws when port allocation fails", async () => {
      // Empty port list causes "No ports available" error on first call
      const failingPortManager = createPortManagerMock([]);
      manager = new OpenCodeServerManager(
        mockProcessRunner,
        failingPortManager,
        mockHttpClient,
        mockPathProvider,
        SILENT_LOGGER
      );

      await expect(manager.startServer("/workspace/feature-a")).rejects.toThrow(
        "No ports available"
      );
    });

    it("throws when opencode binary not found (ENOENT)", async () => {
      mockProcessRunner = createMockProcessRunner({
        onSpawn: () => ({
          pid: undefined, // spawn failure
          stderr: "spawn ENOENT",
        }),
      });
      manager = new OpenCodeServerManager(
        mockProcessRunner,
        mockPortManager,
        mockHttpClient,
        mockPathProvider,
        SILENT_LOGGER
      );

      await expect(manager.startServer("/workspace/feature-a")).rejects.toThrow();
    });

    it("cleans up on spawn failure", async () => {
      mockProcessRunner = createMockProcessRunner({
        onSpawn: () => ({
          pid: undefined, // spawn failure
          stderr: "spawn ENOENT",
        }),
      });
      manager = new OpenCodeServerManager(
        mockProcessRunner,
        mockPortManager,
        mockHttpClient,
        mockPathProvider,
        SILENT_LOGGER
      );

      try {
        await manager.startServer("/workspace/feature-a");
      } catch {
        // Expected to throw
      }

      // getPort should return undefined
      expect(manager.getPort("/workspace/feature-a")).toBeUndefined();
    });

    it("cleans up on health check timeout", async () => {
      // Make health check fail (timeout)
      mockHttpClient = createTestHttpClient({ error: new Error("Connection refused") });
      manager = new OpenCodeServerManager(
        mockProcessRunner,
        mockPortManager,
        mockHttpClient,
        mockPathProvider,
        SILENT_LOGGER,
        { healthCheckTimeoutMs: 100 } // Short timeout for testing
      );

      await expect(manager.startServer("/workspace/feature-a")).rejects.toThrow();

      // Process should have been killed
      expect(mockProcessRunner.$.spawned(0)).toHaveBeenKilled();
    });

    it("does not start duplicate server for same workspace", async () => {
      await manager.startServer("/workspace/feature-a");
      const port2 = await manager.startServer("/workspace/feature-a");

      // Should return same port, not spawn another
      expect(port2).toBe(14001);
      expect(mockProcessRunner).toHaveSpawned([
        { command: expect.stringContaining("opencode") as string },
      ]);
    });
  });

  describe("stopServer", () => {
    it("kills process gracefully (SIGTERM then SIGKILL)", async () => {
      await manager.startServer("/workspace/feature-a");

      await manager.stopServer("/workspace/feature-a");

      expect(mockProcessRunner.$.spawned(0)).toHaveBeenKilled();
    });

    it("removes port from memory", async () => {
      await manager.startServer("/workspace/feature-a");

      await manager.stopServer("/workspace/feature-a");

      expect(manager.getPort("/workspace/feature-a")).toBeUndefined();
    });

    it("fires onServerStopped callback", async () => {
      const callback = vi.fn();
      manager.onServerStopped(callback);

      await manager.startServer("/workspace/feature-a");
      await manager.stopServer("/workspace/feature-a");

      expect(callback).toHaveBeenCalledWith("/workspace/feature-a", false);
    });

    it("awaits pending startServer before killing", async () => {
      // Start a slow server
      let resolveHealthCheck: () => void;
      const slowHealthCheck = new Promise<Response>((resolve) => {
        resolveHealthCheck = () => resolve(new Response(JSON.stringify({ status: "ok" })));
      });

      mockHttpClient.fetch.mockImplementation(async () => slowHealthCheck);

      // Start in background
      const startPromise = manager.startServer("/workspace/feature-a");

      // Immediately try to stop
      const stopPromise = manager.stopServer("/workspace/feature-a");

      // Resolve health check
      resolveHealthCheck!();

      // Both should complete
      await startPromise;
      await stopPromise;

      // Stop should have been called
      expect(mockProcessRunner.$.spawned(0)).toHaveBeenKilled();
    });

    it("handles already-dead processes gracefully", async () => {
      await manager.startServer("/workspace/feature-a");

      // Should not throw
      await expect(manager.stopServer("/workspace/feature-a")).resolves.not.toThrow();
    });

    it("handles stopping non-existent server gracefully", async () => {
      // Should not throw and return success (nothing to stop)
      const result = (await manager.stopServer("/workspace/nonexistent")) as unknown as {
        success: boolean;
      };
      expect(result).toEqual({ success: true });
    });

    it("returns success when kill succeeds", async () => {
      await manager.startServer("/workspace/feature-a");

      const result = (await manager.stopServer("/workspace/feature-a")) as unknown as {
        success: boolean;
      };

      expect(result).toEqual({ success: true });
    });

    it("returns failure with error when kill fails", async () => {
      // Create a process that fails to kill
      mockProcessRunner = createMockProcessRunner({
        onSpawn: () => ({
          pid: 12345,
          killResult: { success: false },
        }),
      });
      manager = new OpenCodeServerManager(
        mockProcessRunner,
        mockPortManager,
        mockHttpClient,
        mockPathProvider,
        SILENT_LOGGER
      );

      await manager.startServer("/workspace/feature-a");

      const result = (await manager.stopServer("/workspace/feature-a")) as unknown as {
        success: boolean;
        error?: string;
      };

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("logs warning when kill fails", async () => {
      // Create a mock logger to verify logging
      const loggerWithSpy = {
        ...SILENT_LOGGER,
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
        silly: vi.fn(),
      };

      mockProcessRunner = createMockProcessRunner({
        onSpawn: () => ({
          pid: 12345,
          killResult: { success: false },
        }),
      });
      manager = new OpenCodeServerManager(
        mockProcessRunner,
        mockPortManager,
        mockHttpClient,
        mockPathProvider,
        loggerWithSpy
      );

      await manager.startServer("/workspace/feature-a");
      await manager.stopServer("/workspace/feature-a");

      expect(loggerWithSpy.warn).toHaveBeenCalledWith(
        expect.stringContaining("Failed to kill"),
        expect.any(Object)
      );
    });

    it("uses 1000ms timeouts", async () => {
      await manager.startServer("/workspace/feature-a");
      await manager.stopServer("/workspace/feature-a");

      // Verify kill was called with 1000ms timeouts
      expect(mockProcessRunner.$.spawned(0)).toHaveBeenKilledWith(1000, 1000);
    });
  });

  describe("stopAllForProject", () => {
    it("kills all workspace servers for project", async () => {
      let processCount = 0;
      mockProcessRunner = createMockProcessRunner({
        onSpawn: () => ({
          pid: 1001 + processCount++,
          killResult: { success: true, reason: "SIGTERM" },
        }),
      });

      // Create manager with multiple ports
      const multiPortManager = createPortManagerMock([14001, 14002]);
      const testManager = new OpenCodeServerManager(
        mockProcessRunner,
        multiPortManager,
        mockHttpClient,
        mockPathProvider,
        SILENT_LOGGER
      );

      await testManager.startServer("/project/.worktrees/feature-a");
      await testManager.startServer("/project/.worktrees/feature-b");

      await testManager.stopAllForProject("/project");

      expect(mockProcessRunner.$.spawned(0)).toHaveBeenKilled();
      expect(mockProcessRunner.$.spawned(1)).toHaveBeenKilled();
    });
  });

  describe("concurrent starts", () => {
    it("get unique ports", async () => {
      // Create manager with multiple ports for concurrent starts
      const multiPortManager = createPortManagerMock([14001, 14002]);

      let processCount = 0;
      mockProcessRunner = createMockProcessRunner({
        onSpawn: () => ({
          pid: 1000 + processCount++,
          killResult: { success: true, reason: "SIGTERM" },
        }),
      });

      const testManager = new OpenCodeServerManager(
        mockProcessRunner,
        multiPortManager,
        mockHttpClient,
        mockPathProvider,
        SILENT_LOGGER
      );

      const [port1, port2] = await Promise.all([
        testManager.startServer("/workspace/feature-a"),
        testManager.startServer("/workspace/feature-b"),
      ]);

      expect(port1).not.toBe(port2);
    });
  });

  describe("getPort", () => {
    it("returns correct port for workspace", async () => {
      await manager.startServer("/workspace/feature-a");

      expect(manager.getPort("/workspace/feature-a")).toBe(14001);
    });

    it("returns undefined for unknown workspace", () => {
      expect(manager.getPort("/workspace/unknown")).toBeUndefined();
    });
  });

  describe("dispose", () => {
    it("stops all servers", async () => {
      let processCount = 0;
      mockProcessRunner = createMockProcessRunner({
        onSpawn: () => ({
          pid: 1000 + processCount++,
          killResult: { success: true, reason: "SIGTERM" },
        }),
      });

      // Create manager with multiple ports
      const multiPortManager = createPortManagerMock([14001, 14002]);
      const testManager = new OpenCodeServerManager(
        mockProcessRunner,
        multiPortManager,
        mockHttpClient,
        mockPathProvider,
        SILENT_LOGGER
      );

      await testManager.startServer("/workspace/feature-a");
      await testManager.startServer("/workspace/feature-b");

      await testManager.dispose();

      expect(mockProcessRunner.$.spawned(0)).toHaveBeenKilled();
      expect(mockProcessRunner.$.spawned(1)).toHaveBeenKilled();
    });
  });

  describe("callback ordering", () => {
    it("fires callback before startServer returns", async () => {
      const events: string[] = [];

      manager.onServerStarted(() => {
        events.push("callback");
      });

      await manager.startServer("/workspace/feature-a");
      events.push("returned");

      expect(events).toEqual(["callback", "returned"]);
    });

    it("fires callback after process terminated", async () => {
      const events: string[] = [];

      await manager.startServer("/workspace/feature-a");

      manager.onServerStopped(() => {
        events.push("callback");
      });

      await manager.stopServer("/workspace/feature-a");
      events.push("stopped");

      // Callback should have been called before stopServer returns
      expect(events).toContain("callback");
      expect(events.indexOf("callback")).toBeLessThan(events.indexOf("stopped"));
    });
  });

  describe("MCP configuration", () => {
    it("setMcpConfig stores configuration", () => {
      manager.setMcpConfig({
        port: 12345,
      });

      const config = manager.getMcpConfig();
      expect(config).toEqual({
        port: 12345,
      });
    });

    it("getMcpConfig returns null before setMcpConfig", () => {
      expect(manager.getMcpConfig()).toBeNull();
    });

    it("passes OPENCODE_CONFIG_CONTENT env var when config is set", async () => {
      manager.setMcpConfig({
        port: 12345,
      });

      await manager.startServer("/workspace/feature-a");

      const spawned = mockProcessRunner.$.spawned(0);
      const configContent = spawned.$.env?.OPENCODE_CONFIG_CONTENT;
      expect(configContent).toBeDefined();

      const parsed = JSON.parse(configContent!) as {
        mcp: {
          codehydra: {
            type: string;
            url: string;
            headers: Record<string, string>;
            enabled: boolean;
          };
        };
      };
      expect(parsed.mcp.codehydra.type).toBe("remote");
      expect(parsed.mcp.codehydra.url).toBe("http://127.0.0.1:12345/mcp");
      expect(parsed.mcp.codehydra.headers["X-Workspace-Path"]).toBe("/workspace/feature-a");
      expect(parsed.mcp.codehydra.enabled).toBe(true);
    });

    it("does not pass env when MCP config not set", async () => {
      await manager.startServer("/workspace/feature-a");

      const spawned = mockProcessRunner.$.spawned(0);
      expect(spawned.$.env?.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    });
  });
});
