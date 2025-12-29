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
import { OpenCodeServerManager } from "./opencode-server-manager";
import { createMockProcessRunner, createMockSpawnedProcess } from "../platform/process.test-utils";
import { createMockPathProvider } from "../platform/path-provider.test-utils";
import { SILENT_LOGGER } from "../logging";
import type { MockSpawnedProcess, MockProcessRunner } from "../platform/process.test-utils";
import type { PortManager, HttpClient } from "../platform/network";
import type { PathProvider } from "../platform/path-provider";

/**
 * Create a mock PortManager with vitest spies.
 */
function createTestPortManager(
  port = 14001
): PortManager & { findFreePort: ReturnType<typeof vi.fn> } {
  return {
    findFreePort: vi.fn().mockResolvedValue(port),
  };
}

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
  let mockPortManager: ReturnType<typeof createTestPortManager>;
  let mockHttpClient: ReturnType<typeof createTestHttpClient>;
  let mockPathProvider: PathProvider;
  let manager: OpenCodeServerManager;
  let mockProcess: MockSpawnedProcess;

  beforeEach(() => {
    vi.clearAllMocks();

    // Create mock spawned process
    mockProcess = createMockSpawnedProcess({
      pid: 12345,
      waitResult: { exitCode: 0, stdout: "", stderr: "" },
      killResult: { success: true, reason: "SIGTERM" },
    });

    mockProcessRunner = createMockProcessRunner(mockProcess);
    mockPortManager = createTestPortManager(14001);
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
      expect(mockPortManager.findFreePort).toHaveBeenCalled();
      expect(mockProcessRunner.run).toHaveBeenCalledWith(
        expect.stringContaining("opencode"),
        expect.arrayContaining(["serve", "--port", "14001"]),
        expect.objectContaining({ cwd: "/workspace/feature-a" })
      );
    });

    it("stores port in memory after health check passes", async () => {
      await manager.startServer("/workspace/feature-a");

      expect(manager.getPort("/workspace/feature-a")).toBe(14001);
    });

    it("fires onServerStarted callback with path and port", async () => {
      const callback = vi.fn();
      manager.onServerStarted(callback);

      await manager.startServer("/workspace/feature-a");

      expect(callback).toHaveBeenCalledWith("/workspace/feature-a", 14001);
    });

    it("throws when port allocation fails", async () => {
      mockPortManager.findFreePort.mockRejectedValue(new Error("No ports available"));

      await expect(manager.startServer("/workspace/feature-a")).rejects.toThrow(
        "No ports available"
      );
    });

    it("throws when opencode binary not found (ENOENT)", async () => {
      const failedProcess = createMockSpawnedProcess({
        pid: null, // spawn failure
        waitResult: { exitCode: null, stdout: "", stderr: "spawn ENOENT" },
      });
      mockProcessRunner = createMockProcessRunner(failedProcess);
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
      const failedProcess = createMockSpawnedProcess({
        pid: null, // spawn failure
        waitResult: { exitCode: null, stdout: "", stderr: "spawn ENOENT" },
      });
      mockProcessRunner = createMockProcessRunner(failedProcess);
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
      expect(mockProcess.kill).toHaveBeenCalled();
    });

    it("does not start duplicate server for same workspace", async () => {
      await manager.startServer("/workspace/feature-a");
      const port2 = await manager.startServer("/workspace/feature-a");

      // Should return same port, not spawn another
      expect(port2).toBe(14001);
      expect(mockProcessRunner.run).toHaveBeenCalledTimes(1);
    });
  });

  describe("stopServer", () => {
    it("kills process gracefully (SIGTERM then SIGKILL)", async () => {
      await manager.startServer("/workspace/feature-a");

      await manager.stopServer("/workspace/feature-a");

      expect(mockProcess.kill).toHaveBeenCalled();
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

      expect(callback).toHaveBeenCalledWith("/workspace/feature-a");
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
      expect(mockProcess.kill).toHaveBeenCalled();
    });

    it("handles already-dead processes gracefully", async () => {
      const deadProcess = createMockSpawnedProcess({
        pid: 12345,
        waitResult: { exitCode: 0, stdout: "", stderr: "" },
        killResult: { success: true, reason: "SIGTERM" },
      });
      mockProcessRunner = createMockProcessRunner(deadProcess);
      manager = new OpenCodeServerManager(
        mockProcessRunner,
        mockPortManager,
        mockHttpClient,
        mockPathProvider,
        SILENT_LOGGER
      );

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
      const failingProcess = createMockSpawnedProcess({
        pid: 12345,
        waitResult: { exitCode: 0, stdout: "", stderr: "" },
        killResult: { success: false },
      });
      mockProcessRunner = createMockProcessRunner(failingProcess);
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

      const failingProcess = createMockSpawnedProcess({
        pid: 12345,
        waitResult: { exitCode: 0, stdout: "", stderr: "" },
        killResult: { success: false },
      });
      mockProcessRunner = createMockProcessRunner(failingProcess);
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
      expect(mockProcess.kill).toHaveBeenCalledWith(1000, 1000);
    });
  });

  describe("stopAllForProject", () => {
    it("kills all workspace servers for project", async () => {
      // Start multiple servers for same project
      const mockProcess1 = createMockSpawnedProcess({ pid: 1001 });
      const mockProcess2 = createMockSpawnedProcess({ pid: 1002 });
      let callCount = 0;
      mockProcessRunner.run.mockImplementation(() => {
        callCount++;
        return callCount === 1 ? mockProcess1 : mockProcess2;
      });

      // Return unique ports
      let portCount = 14001;
      mockPortManager.findFreePort.mockImplementation(async () => portCount++);

      await manager.startServer("/project/.worktrees/feature-a");
      await manager.startServer("/project/.worktrees/feature-b");

      await manager.stopAllForProject("/project");

      expect(mockProcess1.kill).toHaveBeenCalled();
      expect(mockProcess2.kill).toHaveBeenCalled();
    });
  });

  describe("concurrent starts", () => {
    it("get unique ports", async () => {
      let portCounter = 14001;
      mockPortManager.findFreePort.mockImplementation(async () => portCounter++);

      let processCount = 0;
      mockProcessRunner.run.mockImplementation(() => {
        processCount++;
        return createMockSpawnedProcess({ pid: 1000 + processCount });
      });

      const [port1, port2] = await Promise.all([
        manager.startServer("/workspace/feature-a"),
        manager.startServer("/workspace/feature-b"),
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
      const processes: MockSpawnedProcess[] = [];
      let processCount = 0;
      mockProcessRunner.run.mockImplementation(() => {
        processCount++;
        const proc = createMockSpawnedProcess({ pid: 1000 + processCount });
        processes.push(proc);
        return proc;
      });

      let portCounter = 14001;
      mockPortManager.findFreePort.mockImplementation(async () => portCounter++);

      await manager.startServer("/workspace/feature-a");
      await manager.startServer("/workspace/feature-b");

      await manager.dispose();

      for (const proc of processes) {
        expect(proc.kill).toHaveBeenCalled();
      }
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

      mockProcess.kill.mockImplementation(async () => {
        events.push("killed");
        return { success: true, reason: "SIGTERM" };
      });

      manager.onServerStopped(() => {
        events.push("callback");
      });

      await manager.stopServer("/workspace/feature-a");

      expect(events).toContain("killed");
      expect(events).toContain("callback");
      expect(events.indexOf("killed")).toBeLessThan(events.indexOf("callback"));
    });
  });

  describe("MCP configuration", () => {
    it("setMcpConfig stores configuration", () => {
      manager.setMcpConfig({
        configPath: "/test/mcp-config.json",
        port: 12345,
      });

      const config = manager.getMcpConfig();
      expect(config).toEqual({
        configPath: "/test/mcp-config.json",
        port: 12345,
      });
    });

    it("getMcpConfig returns null before setMcpConfig", () => {
      expect(manager.getMcpConfig()).toBeNull();
    });

    it("passes MCP env vars when config is set", async () => {
      manager.setMcpConfig({
        configPath: "/test/mcp-config.json",
        port: 12345,
      });

      await manager.startServer("/workspace/feature-a");

      expect(mockProcessRunner.run).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({
          cwd: "/workspace/feature-a",
          env: expect.objectContaining({
            OPENCODE_CONFIG: "/test/mcp-config.json",
            CODEHYDRA_WORKSPACE_PATH: "/workspace/feature-a",
            CODEHYDRA_MCP_PORT: "12345",
          }),
        })
      );
    });

    it("does not pass env when MCP config not set", async () => {
      await manager.startServer("/workspace/feature-a");

      expect(mockProcessRunner.run).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({
          cwd: "/workspace/feature-a",
        })
      );

      // Verify no env property (or env without MCP vars)
      const call = mockProcessRunner.run.mock.calls[0];
      const options = call?.[2] as { env?: NodeJS.ProcessEnv };
      if (options?.env) {
        expect(options.env.OPENCODE_CONFIG).toBeUndefined();
        expect(options.env.CODEHYDRA_WORKSPACE_PATH).toBeUndefined();
        expect(options.env.CODEHYDRA_MCP_PORT).toBeUndefined();
      }
    });
  });
});
