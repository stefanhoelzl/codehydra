// @vitest-environment node
/**
 * Integration tests for OpenCodeServerManager with AppState.
 *
 * Tests the full lifecycle of OpenCode servers managed by AppState:
 * - Server starts when workspace is added
 * - Server stops when workspace is removed
 * - All servers stop when project is closed
 * - AgentStatusManager receives start/stop events correctly
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenCodeServerManager } from "./opencode-server-manager";
import { AgentStatusManager } from "./agent-status-manager";
import { createMockProcessRunner, createMockSpawnedProcess } from "../platform/process.test-utils";
import { createSilentLogger } from "../logging";
import type { MockSpawnedProcess, MockProcessRunner } from "../platform/process.test-utils";
import type { PortManager, HttpClient } from "../platform/network";
import type { PathProvider } from "../platform/path-provider";
import type { WorkspacePath } from "../../shared/ipc";
import { createMockSdkClient, createMockSdkFactory } from "./sdk-test-utils";

/**
 * Create a mock PortManager with vitest spies.
 */
function createTestPortManager(
  startPort = 14001
): PortManager & { findFreePort: ReturnType<typeof vi.fn> } {
  let currentPort = startPort;
  return {
    findFreePort: vi.fn().mockImplementation(async () => currentPort++),
  };
}

/**
 * Create a mock HttpClient with vitest spies.
 */
function createTestHttpClient(): HttpClient & { fetch: ReturnType<typeof vi.fn> } {
  const defaultResponse = new Response(JSON.stringify({ status: "ok" }), { status: 200 });
  return {
    fetch: vi.fn().mockResolvedValue(defaultResponse),
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
    setupMarkerPath: "/test/app-data/.setup-completed",
    legacySetupMarkerPath: "/test/app-data/vscode/.setup-completed",
    electronDataDir: "/test/app-data/electron",
    vscodeAssetsDir: "/mock/assets",
    appIconPath: "/test/resources/icon.png",
    binDir: "/test/app-data/bin",
    codeServerDir: "/test/app-data/code-server/1.0.0",
    opencodeDir: "/test/app-data/opencode/1.0.0",
    codeServerBinaryPath: "/test/app-data/code-server/1.0.0/bin/code-server",
    opencodeBinaryPath: "/test/app-data/opencode/1.0.0/opencode",
    bundledNodePath: "/test/app-data/code-server/1.0.0/lib/node",
    getProjectWorkspacesDir: (projectPath: string) =>
      `/test/app-data/projects/${projectPath}/workspaces`,
  };
}

describe("OpenCodeServerManager integration", () => {
  let serverManager: OpenCodeServerManager;
  let agentStatusManager: AgentStatusManager;
  let mockProcessRunner: MockProcessRunner;
  let mockPortManager: ReturnType<typeof createTestPortManager>;
  let mockHttpClient: ReturnType<typeof createTestHttpClient>;
  let mockPathProvider: PathProvider;
  let processes: MockSpawnedProcess[];

  beforeEach(() => {
    vi.clearAllMocks();
    processes = [];

    // Create a mock process runner that returns new processes for each call
    const mockProcess = createMockSpawnedProcess({ pid: 1000 });
    mockProcessRunner = createMockProcessRunner(mockProcess);
    // Override run to create new processes each time
    mockProcessRunner.run.mockImplementation(() => {
      const proc = createMockSpawnedProcess({ pid: 1000 + processes.length });
      processes.push(proc);
      return proc;
    });
    mockPortManager = createTestPortManager(14001);
    mockHttpClient = createTestHttpClient();
    mockPathProvider = createTestPathProvider();

    serverManager = new OpenCodeServerManager(
      mockProcessRunner,
      mockPortManager,
      mockHttpClient,
      mockPathProvider,
      createSilentLogger()
    );

    // Create AgentStatusManager with mock SDK
    const mockSdk = createMockSdkClient();
    const mockSdkFactory = createMockSdkFactory(mockSdk);
    agentStatusManager = new AgentStatusManager(createSilentLogger(), mockSdkFactory);
  });

  afterEach(async () => {
    await serverManager.dispose();
    agentStatusManager.dispose();
  });

  describe("callback wiring", () => {
    it("onServerStarted callback is fired with path and port", async () => {
      const startedCallback = vi.fn();
      serverManager.onServerStarted(startedCallback);

      // Start server
      await serverManager.startServer("/workspace/feature-a");

      // Callback should have been fired
      expect(startedCallback).toHaveBeenCalledWith("/workspace/feature-a", 14001);
    });

    it("onServerStopped callback is fired when server stops", async () => {
      const stoppedCallback = vi.fn();
      serverManager.onServerStopped(stoppedCallback);

      // Start and stop server
      await serverManager.startServer("/workspace/feature-a");
      await serverManager.stopServer("/workspace/feature-a");

      // Callback should have been fired
      expect(stoppedCallback).toHaveBeenCalledWith("/workspace/feature-a");
    });

    it("AgentStatusManager receives stop event via callback wiring", async () => {
      // Wire callbacks like AppState does
      serverManager.onServerStopped((path) => {
        agentStatusManager.removeWorkspace(path as WorkspacePath);
      });

      // Initialize workspace directly (simulating start callback)
      await agentStatusManager.initWorkspace("/workspace/feature-a" as WorkspacePath, 14001);

      // Start and stop server (stop triggers the callback)
      await serverManager.startServer("/workspace/feature-a");
      await serverManager.stopServer("/workspace/feature-a");

      // AgentStatusManager should report "none" status after removal
      const status = agentStatusManager.getStatus("/workspace/feature-a" as WorkspacePath);
      expect(status.status).toBe("none");
    });
  });

  describe("workspace lifecycle", () => {
    it("server starts on add, stops on remove", async () => {
      // Start
      const port = await serverManager.startServer("/workspace/feature-a");
      expect(port).toBe(14001);
      expect(serverManager.getPort("/workspace/feature-a")).toBe(14001);

      // Stop
      await serverManager.stopServer("/workspace/feature-a");
      expect(serverManager.getPort("/workspace/feature-a")).toBeUndefined();
    });
  });

  describe("multiple workspaces", () => {
    it("each gets own server and port", async () => {
      const port1 = await serverManager.startServer("/workspace/feature-a");
      const port2 = await serverManager.startServer("/workspace/feature-b");
      const port3 = await serverManager.startServer("/workspace/feature-c");

      expect(port1).toBe(14001);
      expect(port2).toBe(14002);
      expect(port3).toBe(14003);

      expect(serverManager.getPort("/workspace/feature-a")).toBe(14001);
      expect(serverManager.getPort("/workspace/feature-b")).toBe(14002);
      expect(serverManager.getPort("/workspace/feature-c")).toBe(14003);
    });
  });

  describe("project close cleanup", () => {
    it("all servers killed when project is closed", async () => {
      // Start multiple servers for the same project
      await serverManager.startServer("/project/.worktrees/feature-a");
      await serverManager.startServer("/project/.worktrees/feature-b");
      await serverManager.startServer("/project/.worktrees/feature-c");

      // All should be running
      expect(serverManager.getPort("/project/.worktrees/feature-a")).toBeDefined();
      expect(serverManager.getPort("/project/.worktrees/feature-b")).toBeDefined();
      expect(serverManager.getPort("/project/.worktrees/feature-c")).toBeDefined();

      // Close project
      await serverManager.stopAllForProject("/project");

      // All should be stopped
      expect(serverManager.getPort("/project/.worktrees/feature-a")).toBeUndefined();
      expect(serverManager.getPort("/project/.worktrees/feature-b")).toBeUndefined();
      expect(serverManager.getPort("/project/.worktrees/feature-c")).toBeUndefined();

      // All processes should have been killed
      for (const proc of processes) {
        expect(proc.kill).toHaveBeenCalled();
      }
    });
  });

  describe("rapid workspace add/remove cycles", () => {
    it("are stable", async () => {
      // Rapid add/remove cycles
      for (let i = 0; i < 5; i++) {
        await serverManager.startServer(`/workspace/feature-${i}`);
        await serverManager.stopServer(`/workspace/feature-${i}`);
      }

      // No servers should be running
      for (let i = 0; i < 5; i++) {
        expect(serverManager.getPort(`/workspace/feature-${i}`)).toBeUndefined();
      }
    });

    it("handles concurrent starts/stops", async () => {
      // Start multiple concurrently
      const [port1, port2, port3] = await Promise.all([
        serverManager.startServer("/workspace/feature-a"),
        serverManager.startServer("/workspace/feature-b"),
        serverManager.startServer("/workspace/feature-c"),
      ]);

      expect(port1).toBeDefined();
      expect(port2).toBeDefined();
      expect(port3).toBeDefined();
      expect(new Set([port1, port2, port3]).size).toBe(3); // All unique

      // Stop multiple concurrently
      await Promise.all([
        serverManager.stopServer("/workspace/feature-a"),
        serverManager.stopServer("/workspace/feature-b"),
        serverManager.stopServer("/workspace/feature-c"),
      ]);

      // All should be stopped
      expect(serverManager.getPort("/workspace/feature-a")).toBeUndefined();
      expect(serverManager.getPort("/workspace/feature-b")).toBeUndefined();
      expect(serverManager.getPort("/workspace/feature-c")).toBeUndefined();
    });
  });
});
