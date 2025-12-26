// @vitest-environment node
/**
 * Tests for OpenCodeServerManager.
 *
 * Tests the managed OpenCode server lifecycle:
 * - startServer: allocates port, spawns process, health check, ports.json
 * - stopServer: graceful shutdown, cleanup
 * - stopAllForProject: bulk cleanup
 * - dispose: full cleanup on shutdown
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenCodeServerManager } from "./opencode-server-manager";
import { createMockProcessRunner, createMockSpawnedProcess } from "../platform/process.test-utils";
import { createSilentLogger } from "../logging";
import type { MockSpawnedProcess, MockProcessRunner } from "../platform/process.test-utils";
import type { PortManager, HttpClient } from "../platform/network";
import type { FileSystemLayer } from "../platform/filesystem";
import type { PathProvider } from "../platform/path-provider";

/**
 * Create a mock PortManager with vitest spies.
 */
function createTestPortManager(
  port = 14001
): PortManager & { findFreePort: ReturnType<typeof vi.fn> } {
  return {
    findFreePort: vi.fn().mockResolvedValue(port),
    getListeningPorts: vi.fn().mockResolvedValue([]),
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
 * Create a mock FileSystemLayer with vitest spies.
 */
function createTestFileSystemLayer(options?: {
  readFile?: { content?: string; error?: Error };
}): FileSystemLayer & {
  readFile: ReturnType<typeof vi.fn>;
  writeFile: ReturnType<typeof vi.fn>;
  mkdir: ReturnType<typeof vi.fn>;
  rename: ReturnType<typeof vi.fn>;
} {
  return {
    readFile: options?.readFile?.error
      ? vi.fn().mockRejectedValue(options.readFile.error)
      : vi.fn().mockResolvedValue(options?.readFile?.content ?? "{}"),
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    readdir: vi.fn().mockResolvedValue([]),
    unlink: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
    copyTree: vi.fn().mockResolvedValue(undefined),
    makeExecutable: vi.fn().mockResolvedValue(undefined),
    writeFileBuffer: vi.fn().mockResolvedValue(undefined),
    symlink: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Create a mock PathProvider for testing.
 */
function createTestPathProvider(): PathProvider {
  return {
    dataRootDir: "/test/app-data",
    projectsDir: "/test/app-data/projects",
    vscodeDir: "/test/app-data/vscode",
    vscodeExtensionsDir: "/test/app-data/vscode/extensions",
    vscodeUserDataDir: "/test/app-data/vscode/user-data",
    vscodeSetupMarkerPath: "/test/app-data/vscode/.setup-completed",
    electronDataDir: "/test/app-data/electron",
    vscodeAssetsDir: "/mock/assets",
    appIconPath: "/test/resources/icon.png",
    binDir: "/test/app-data/bin",
    codeServerDir: "/test/app-data/code-server/1.0.0",
    opencodeDir: "/test/app-data/opencode/1.0.0",
    codeServerBinaryPath: "/test/app-data/code-server/1.0.0/bin/code-server",
    opencodeBinaryPath: "/test/app-data/opencode/1.0.0/opencode",
    bundledNodePath: "/test/app-data/code-server/1.0.0/lib/node",
    mcpConfigPath: "/test/app-data/opencode/codehydra-mcp.json",
    getProjectWorkspacesDir: (projectPath: string) =>
      `/test/app-data/projects/${projectPath}/workspaces`,
  };
}

describe("OpenCodeServerManager", () => {
  // Common dependencies
  let mockProcessRunner: MockProcessRunner;
  let mockPortManager: ReturnType<typeof createTestPortManager>;
  let mockFileSystemLayer: ReturnType<typeof createTestFileSystemLayer>;
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
    mockFileSystemLayer = createTestFileSystemLayer();
    mockHttpClient = createTestHttpClient();
    mockPathProvider = createTestPathProvider();

    manager = new OpenCodeServerManager(
      mockProcessRunner,
      mockPortManager,
      mockFileSystemLayer,
      mockHttpClient,
      mockPathProvider,
      createSilentLogger()
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

    it("writes to ports.json after health check passes", async () => {
      await manager.startServer("/workspace/feature-a");

      expect(mockFileSystemLayer.writeFile).toHaveBeenCalledWith(
        expect.stringContaining("ports.json"),
        expect.stringContaining("/workspace/feature-a")
      );
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
        mockFileSystemLayer,
        mockHttpClient,
        mockPathProvider,
        createSilentLogger()
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
        mockFileSystemLayer,
        mockHttpClient,
        mockPathProvider,
        createSilentLogger()
      );

      try {
        await manager.startServer("/workspace/feature-a");
      } catch {
        // Expected to throw
      }

      // Should not have written to ports.json
      expect(mockFileSystemLayer.writeFile).not.toHaveBeenCalled();
      // getPort should return undefined
      expect(manager.getPort("/workspace/feature-a")).toBeUndefined();
    });

    it("cleans up on health check timeout", async () => {
      // Make health check fail (timeout)
      mockHttpClient = createTestHttpClient({ error: new Error("Connection refused") });
      manager = new OpenCodeServerManager(
        mockProcessRunner,
        mockPortManager,
        mockFileSystemLayer,
        mockHttpClient,
        mockPathProvider,
        createSilentLogger(),
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

    it("removes entry from ports.json", async () => {
      await manager.startServer("/workspace/feature-a");
      mockFileSystemLayer.writeFile.mockClear();

      await manager.stopServer("/workspace/feature-a");

      // Should write ports.json without this workspace
      expect(mockFileSystemLayer.writeFile).toHaveBeenCalledWith(
        expect.stringContaining("ports.json"),
        expect.not.stringContaining("/workspace/feature-a")
      );
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
        mockFileSystemLayer,
        mockHttpClient,
        mockPathProvider,
        createSilentLogger()
      );

      await manager.startServer("/workspace/feature-a");

      // Should not throw
      await expect(manager.stopServer("/workspace/feature-a")).resolves.not.toThrow();
    });

    it("handles stopping non-existent server gracefully", async () => {
      // Should not throw
      await expect(manager.stopServer("/workspace/nonexistent")).resolves.not.toThrow();
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

  describe("ports.json file handling", () => {
    it("handles corrupted ports.json gracefully", async () => {
      mockFileSystemLayer.readFile.mockResolvedValue("not valid json");

      // Should not throw, should create fresh file
      await manager.startServer("/workspace/feature-a");
      expect(mockFileSystemLayer.writeFile).toHaveBeenCalled();
    });

    it("handles missing ports.json gracefully", async () => {
      mockFileSystemLayer.readFile.mockRejectedValue(new Error("ENOENT"));

      // Should not throw, should create file
      await manager.startServer("/workspace/feature-a");
      expect(mockFileSystemLayer.writeFile).toHaveBeenCalled();
    });

    it("uses atomic write to prevent corruption", async () => {
      await manager.startServer("/workspace/feature-a");

      // Should write to temp file first
      expect(mockFileSystemLayer.writeFile).toHaveBeenCalledWith(
        expect.stringContaining("ports.json.tmp"),
        expect.any(String)
      );
      // Then rename temp file to final location
      expect(mockFileSystemLayer.rename).toHaveBeenCalledWith(
        expect.stringContaining("ports.json.tmp"),
        expect.stringContaining("ports.json")
      );
    });
  });

  describe("cleanupStaleEntries", () => {
    it("removes entries for dead processes", async () => {
      // Pre-populate ports.json with stale entry
      mockFileSystemLayer.readFile.mockResolvedValue(
        JSON.stringify({
          workspaces: {
            "/stale/workspace": { port: 19999 },
          },
        })
      );

      // Health check fails (process is dead)
      mockHttpClient.fetch.mockRejectedValue(new Error("Connection refused"));

      await manager.cleanupStaleEntries();

      // Should have written ports.json without the stale entry
      expect(mockFileSystemLayer.writeFile).toHaveBeenCalledWith(
        expect.stringContaining("ports.json"),
        expect.not.stringContaining("/stale/workspace")
      );
    });

    it("preserves entries for running processes", async () => {
      // Pre-populate ports.json with valid entry
      mockFileSystemLayer.readFile.mockResolvedValue(
        JSON.stringify({
          workspaces: {
            "/running/workspace": { port: 14001 },
          },
        })
      );

      // Health check succeeds (process is running)
      mockHttpClient.fetch.mockResolvedValue(
        new Response(JSON.stringify({ status: "ok" }), { status: 200 })
      );

      await manager.cleanupStaleEntries();

      // Should not have removed the entry (either no write, or write with entry preserved)
      const writeCalls = mockFileSystemLayer.writeFile.mock.calls;
      if (writeCalls.length > 0) {
        const lastCall = writeCalls[writeCalls.length - 1];
        if (lastCall) {
          const content = lastCall[1];
          expect(content).toContain("/running/workspace");
        }
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
