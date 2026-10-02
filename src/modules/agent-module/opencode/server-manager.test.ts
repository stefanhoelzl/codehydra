// @vitest-environment node
/**
 * Tests for OpenCodeServerManager.
 *
 * Tests the managed OpenCode server lifecycle:
 * - startServer: allocates port, spawns process, health check, stores port in memory
 * - stopServer: graceful shutdown, cleanup
 * - dispose: full cleanup on shutdown
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenCodeServerManager } from "./server-manager";
import {
  createMockProcessRunner,
  type MockProcessRunner,
} from "../../../boundaries/platform/process.state-mock";
import { createMockPathProvider } from "../../../boundaries/platform/path-provider.test-utils";
import {
  createPortManagerMock,
  type MockPortManager,
} from "../../../boundaries/platform/network.test-utils";
import { SILENT_LOGGER, createMockLogger } from "../../../boundaries/platform/logging";
import type { HttpClient } from "../../../boundaries/platform/network";
import type { PathProvider } from "../../../boundaries/platform/path-provider";
import type { ResolvedAgentBinary } from "../binary-resolver";
import { Path } from "../../../utils/path/path";
import { testWorkspaceRef as refOf } from "../../../shared/test-fixtures";

/** The ref the feature-a workspace is started with. */
const TEST_WORKSPACE_REF = refOf("/workspace/feature-a");

/** The `opencode` every server in these tests runs. */
const TEST_BINARY: ResolvedAgentBinary = {
  path: "/bundles/opencode/1.0.223/opencode",
  source: "download",
  version: "1.0.223",
};

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
    mockPathProvider = createMockPathProvider();

    manager = new OpenCodeServerManager(
      mockProcessRunner,
      mockPortManager,
      mockHttpClient,
      mockPathProvider,
      SILENT_LOGGER,
      "linux"
    );
  });

  afterEach(async () => {
    await manager.dispose();
  });

  describe("startServer", () => {
    it("allocates port and spawns process", async () => {
      const port = await manager.startServer(
        refOf("/workspace/feature-a"),
        new Path("/workspace/feature-a"),
        { binary: TEST_BINARY }
      );

      expect(port).toBe(14001);
      expect(mockProcessRunner).toHaveSpawned([
        {
          command: expect.stringContaining("opencode") as string,
          args: expect.arrayContaining(["serve", "--port", "14001"]) as unknown as string[],
          cwd: "/workspace/feature-a",
        },
      ]);
    });

    it("fires onServerStarted callback with ref, port, and undefined pending prompt", async () => {
      const callback = vi.fn();
      manager.onServerStarted(callback);

      await manager.startServer(refOf("/workspace/feature-a"), new Path("/workspace/feature-a"), {
        binary: TEST_BINARY,
      });

      expect(callback).toHaveBeenCalledWith(refOf("/workspace/feature-a"), 14001, undefined);
    });

    it("throws when port allocation fails", async () => {
      // Empty port list causes "No ports available" error on first call
      const failingPortManager = createPortManagerMock([]);
      manager = new OpenCodeServerManager(
        mockProcessRunner,
        failingPortManager,
        mockHttpClient,
        mockPathProvider,
        SILENT_LOGGER,
        "linux"
      );

      await expect(
        manager.startServer(refOf("/workspace/feature-a"), new Path("/workspace/feature-a"), {
          binary: TEST_BINARY,
        })
      ).rejects.toThrow("No ports available");
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
        SILENT_LOGGER,
        "linux"
      );

      await expect(
        manager.startServer(refOf("/workspace/feature-a"), new Path("/workspace/feature-a"), {
          binary: TEST_BINARY,
        })
      ).rejects.toThrow();
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
        createPortManagerMock([14001, 14002]),
        mockHttpClient,
        mockPathProvider,
        SILENT_LOGGER,
        "linux"
      );

      try {
        await manager.startServer(refOf("/workspace/feature-a"), new Path("/workspace/feature-a"), {
          binary: TEST_BINARY,
        });
      } catch {
        // Expected to throw
      }

      // Entry was cleaned up — a retry attempts a fresh spawn instead of
      // returning the stale failed entry
      await expect(
        manager.startServer(refOf("/workspace/feature-a"), new Path("/workspace/feature-a"), {
          binary: TEST_BINARY,
        })
      ).rejects.toThrow();
      expect(mockProcessRunner.$.spawnedCount).toBe(2);
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
        "linux",
        { healthCheckTimeoutMs: 100 } // Short timeout for testing
      );

      await expect(
        manager.startServer(refOf("/workspace/feature-a"), new Path("/workspace/feature-a"), {
          binary: TEST_BINARY,
        })
      ).rejects.toThrow();

      // Process should have been killed
      expect(mockProcessRunner.$.spawned(0)).toHaveBeenKilled();
    });

    it("does not start duplicate server for same workspace", async () => {
      await manager.startServer(refOf("/workspace/feature-a"), new Path("/workspace/feature-a"), {
        binary: TEST_BINARY,
      });
      const port2 = await manager.startServer(
        refOf("/workspace/feature-a"),
        new Path("/workspace/feature-a"),
        { binary: TEST_BINARY }
      );

      // Should return same port, not spawn another
      expect(port2).toBe(14001);
      expect(mockProcessRunner).toHaveSpawned([
        { command: expect.stringContaining("opencode") as string },
      ]);
    });
  });

  describe("stopServer", () => {
    it("kills process gracefully (SIGTERM then SIGKILL)", async () => {
      await manager.startServer(refOf("/workspace/feature-a"), new Path("/workspace/feature-a"), {
        binary: TEST_BINARY,
      });

      await manager.stopServer(refOf("/workspace/feature-a"));

      expect(mockProcessRunner.$.spawned(0)).toHaveBeenKilled();
    });

    it("removes server entry on stop", async () => {
      await manager.startServer(refOf("/workspace/feature-a"), new Path("/workspace/feature-a"), {
        binary: TEST_BINARY,
      });

      await manager.stopServer(refOf("/workspace/feature-a"));

      // Entry is gone — restart reports "not running"
      const result = await manager.restartServer(refOf("/workspace/feature-a"));
      expect(result).toEqual({ success: false, error: "Server not running" });
    });

    it("fires onServerStopped callback", async () => {
      const callback = vi.fn();
      manager.onServerStopped(callback);

      await manager.startServer(refOf("/workspace/feature-a"), new Path("/workspace/feature-a"), {
        binary: TEST_BINARY,
      });
      await manager.stopServer(refOf("/workspace/feature-a"));

      expect(callback).toHaveBeenCalledWith(refOf("/workspace/feature-a"), false);
    });

    it("awaits pending startServer before killing", async () => {
      // Start a slow server
      let resolveHealthCheck: () => void;
      const slowHealthCheck = new Promise<Response>((resolve) => {
        resolveHealthCheck = () => resolve(new Response(JSON.stringify({ status: "ok" })));
      });

      mockHttpClient.fetch.mockImplementation(async () => slowHealthCheck);

      // Start in background
      const startPromise = manager.startServer(
        refOf("/workspace/feature-a"),
        new Path("/workspace/feature-a"),
        { binary: TEST_BINARY }
      );

      // Immediately try to stop
      const stopPromise = manager.stopServer(refOf("/workspace/feature-a"));

      // Resolve health check
      resolveHealthCheck!();

      // Both should complete
      await startPromise;
      await stopPromise;

      // Stop should have been called
      expect(mockProcessRunner.$.spawned(0)).toHaveBeenKilled();
    });

    it("handles already-dead processes gracefully", async () => {
      await manager.startServer(refOf("/workspace/feature-a"), new Path("/workspace/feature-a"), {
        binary: TEST_BINARY,
      });

      // Should not throw
      await expect(manager.stopServer(refOf("/workspace/feature-a"))).resolves.not.toThrow();
    });

    it("handles stopping non-existent server gracefully", async () => {
      // Should not throw and return success (nothing to stop)
      const result = (await manager.stopServer(refOf("/workspace/nonexistent"))) as unknown as {
        success: boolean;
      };
      expect(result).toEqual({ success: true });
    });

    it("returns success when kill succeeds", async () => {
      await manager.startServer(refOf("/workspace/feature-a"), new Path("/workspace/feature-a"), {
        binary: TEST_BINARY,
      });

      const result = (await manager.stopServer(refOf("/workspace/feature-a"))) as unknown as {
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
        SILENT_LOGGER,
        "linux"
      );

      await manager.startServer(refOf("/workspace/feature-a"), new Path("/workspace/feature-a"), {
        binary: TEST_BINARY,
      });

      const result = (await manager.stopServer(refOf("/workspace/feature-a"))) as unknown as {
        success: boolean;
        error?: string;
      };

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("logs warning when kill fails", async () => {
      // Create a mock logger to verify logging
      const loggerWithSpy = createMockLogger();

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
        loggerWithSpy,
        "linux"
      );

      await manager.startServer(refOf("/workspace/feature-a"), new Path("/workspace/feature-a"), {
        binary: TEST_BINARY,
      });
      await manager.stopServer(refOf("/workspace/feature-a"));

      expect(loggerWithSpy.warn).toHaveBeenCalledWith(
        expect.stringContaining("Failed to kill"),
        expect.any(Object)
      );
    });

    it("uses 1000ms timeouts", async () => {
      await manager.startServer(refOf("/workspace/feature-a"), new Path("/workspace/feature-a"), {
        binary: TEST_BINARY,
      });
      await manager.stopServer(refOf("/workspace/feature-a"));

      // Verify kill was called with 1000ms timeouts
      expect(mockProcessRunner.$.spawned(0)).toHaveBeenKilledWith(1000, 1000);
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

      manager = new OpenCodeServerManager(
        mockProcessRunner,
        multiPortManager,
        mockHttpClient,
        mockPathProvider,
        SILENT_LOGGER,
        "linux"
      );

      const [port1, port2] = await Promise.all([
        manager.startServer(refOf("/workspace/feature-a"), new Path("/workspace/feature-a"), {
          binary: TEST_BINARY,
        }),
        manager.startServer(refOf("/workspace/feature-b"), new Path("/workspace/feature-b"), {
          binary: TEST_BINARY,
        }),
      ]);

      expect(port1).not.toBe(port2);
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
      manager = new OpenCodeServerManager(
        mockProcessRunner,
        multiPortManager,
        mockHttpClient,
        mockPathProvider,
        SILENT_LOGGER,
        "linux"
      );

      await manager.startServer(refOf("/workspace/feature-a"), new Path("/workspace/feature-a"), {
        binary: TEST_BINARY,
      });
      await manager.startServer(refOf("/workspace/feature-b"), new Path("/workspace/feature-b"), {
        binary: TEST_BINARY,
      });

      await manager.dispose();

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

      await manager.startServer(refOf("/workspace/feature-a"), new Path("/workspace/feature-a"), {
        binary: TEST_BINARY,
      });
      events.push("returned");

      expect(events).toEqual(["callback", "returned"]);
    });

    it("fires callback after process terminated", async () => {
      const events: string[] = [];

      await manager.startServer(refOf("/workspace/feature-a"), new Path("/workspace/feature-a"), {
        binary: TEST_BINARY,
      });

      manager.onServerStopped(() => {
        events.push("callback");
      });

      await manager.stopServer(refOf("/workspace/feature-a"));
      events.push("stopped");

      // Callback should have been called before stopServer returns
      expect(events).toContain("callback");
      expect(events.indexOf("callback")).toBeLessThan(events.indexOf("stopped"));
    });
  });

  describe("MCP configuration", () => {
    it("passes OPENCODE_CONFIG_CONTENT env var when config is set", async () => {
      manager.setMcpConfig({
        nodePath: "/ide/node",
        cliPath: "/data/bin/ch.cjs",
        port: 12345,
        token: "test-token",
      });

      await manager.startServer(refOf("/workspace/feature-a"), new Path("/workspace/feature-a"), {
        binary: TEST_BINARY,
      });

      const spawned = mockProcessRunner.$.spawned(0);
      const configContent = spawned.$.env?.OPENCODE_CONFIG_CONTENT;
      expect(configContent).toBeDefined();

      const parsed = JSON.parse(configContent!) as {
        mcp: {
          codehydra: {
            type: string;
            command: string[];
            environment: Record<string, string>;
            enabled: boolean;
          };
        };
      };
      // A stdio subprocess rather than a URL: OpenCode's server is spawned
      // without CodeHydra's bin directory on PATH, so the launch has to name the
      // interpreter and bundle outright and pass credentials in its environment.
      expect(parsed.mcp.codehydra.type).toBe("local");
      expect(parsed.mcp.codehydra.command).toEqual(["/ide/node", "/data/bin/ch.cjs", "mcp"]);
      expect(parsed.mcp.codehydra.environment._CH_WORKSPACE).toBe(TEST_WORKSPACE_REF);
      expect(parsed.mcp.codehydra.environment._CH_WORKSPACE_PATH).toBeUndefined();
      // The server's own environment names the workspace the same way.
      expect(spawned.$.env?._CH_WORKSPACE).toBe(TEST_WORKSPACE_REF);
      expect(parsed.mcp.codehydra.environment._CH_API_PORT).toBe("12345");
      expect(parsed.mcp.codehydra.environment._CH_API_TOKEN).toBe("test-token");
      expect(parsed.mcp.codehydra.enabled).toBe(true);
    });

    it("omits the mcp block when MCP config not set", async () => {
      await manager.startServer(refOf("/workspace/feature-a"), new Path("/workspace/feature-a"), {
        binary: TEST_BINARY,
      });

      const spawned = mockProcessRunner.$.spawned(0);
      const configContent = spawned.$.env?.OPENCODE_CONFIG_CONTENT;
      expect(configContent).toBeDefined();

      const parsed = JSON.parse(configContent!) as Record<string, unknown>;
      expect(parsed.mcp).toBeUndefined();
    });
  });

  describe("PATH", () => {
    const binDir = () => mockPathProvider.dataPath("bin").toNative();
    const pathKeys = (env: NodeJS.ProcessEnv | undefined) =>
      Object.keys(env ?? {}).filter((key) => key.toUpperCase() === "PATH");

    it("puts CodeHydra's bin directory first, with the target platform's delimiter", async () => {
      await manager.startServer(refOf("/workspace/feature-a"), new Path("/workspace/feature-a"), {
        binary: TEST_BINARY,
        env: { PATH: "/usr/bin" },
      });

      const env = mockProcessRunner.$.spawned(0).$.env;
      expect(env?.PATH).toBe(`${binDir()}:/usr/bin`);
    });

    it("keeps Windows' single `Path` key and joins with ';'", async () => {
      const windows = new OpenCodeServerManager(
        mockProcessRunner,
        createPortManagerMock([14002]),
        mockHttpClient,
        mockPathProvider,
        SILENT_LOGGER,
        "win32"
      );
      try {
        // The host's PATH is in the env too; whichever spelling comes first
        // wins, and only one may remain or the un-prefixed copy would win.
        await windows.startServer(refOf("/workspace/feature-a"), new Path("/workspace/feature-a"), {
          binary: TEST_BINARY,
          env: { Path: "C:\\Windows" },
        });

        const env = mockProcessRunner.$.spawned(0).$.env;
        const keys = pathKeys(env);
        expect(keys).toHaveLength(1);
        expect(env?.[keys[0]!]?.startsWith(`${binDir()};`)).toBe(true);
      } finally {
        await windows.dispose();
      }
    });
  });

  describe("system prompt", () => {
    it("loads the CodeHydra system prompt via instructions", async () => {
      await manager.startServer(refOf("/workspace/feature-a"), new Path("/workspace/feature-a"), {
        binary: TEST_BINARY,
      });

      const spawned = mockProcessRunner.$.spawned(0);
      const parsed = JSON.parse(spawned.$.env!.OPENCODE_CONFIG_CONTENT!) as {
        instructions: string[];
      };

      // POSIX separators: the value is embedded in JSON, and opencode accepts
      // absolute paths (globbed by basename within their directory).
      expect(parsed.instructions).toHaveLength(1);
      expect(parsed.instructions[0]).toContain("bin/codehydra-prompt-opencode.md");
    });

    it("loads it even when MCP is configured", async () => {
      manager.setMcpConfig({
        nodePath: "/ide/node",
        cliPath: "/data/bin/ch.cjs",
        port: 12345,
        token: "test-token",
      });

      await manager.startServer(refOf("/workspace/feature-a"), new Path("/workspace/feature-a"), {
        binary: TEST_BINARY,
      });

      const spawned = mockProcessRunner.$.spawned(0);
      const parsed = JSON.parse(spawned.$.env!.OPENCODE_CONFIG_CONTENT!) as {
        instructions: string[];
        mcp: unknown;
      };

      expect(parsed.instructions[0]).toContain("codehydra-prompt-opencode.md");
      expect(parsed.mcp).toBeDefined();
    });
  });
});
