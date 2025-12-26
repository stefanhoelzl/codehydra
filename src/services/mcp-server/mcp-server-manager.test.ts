/**
 * Tests for MCP Server Manager.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { McpServerManager } from "./mcp-server-manager";
import type { PortManager } from "../platform/network";
import type { PathProvider } from "../platform/path-provider";
import type { ICoreApi, IWorkspaceApi, IProjectApi } from "../../shared/api/interfaces";
import type { WorkspaceLookup } from "./workspace-resolver";
import type { McpServerFactory } from "./mcp-server";
import type { McpServer as McpServerSdk } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMockLogger } from "../logging";
import { createMockPathProvider } from "../platform/path-provider.test-utils";

/**
 * Create a mock PortManager.
 */
function createMockPortManager(overrides?: Partial<PortManager>): PortManager {
  return {
    findFreePort: vi.fn().mockResolvedValue(12345),
    ...overrides,
  };
}

/**
 * Create a mock ICoreApi.
 */
function createMockCoreApi(): ICoreApi {
  return {
    workspaces: {
      create: vi.fn(),
      remove: vi.fn(),
      forceRemove: vi.fn(),
      get: vi.fn(),
      getStatus: vi.fn(),
      getOpencodePort: vi.fn(),
      setMetadata: vi.fn(),
      getMetadata: vi.fn(),
    } as unknown as IWorkspaceApi,
    projects: {} as IProjectApi,
    on: vi.fn().mockReturnValue(() => {}),
    dispose: vi.fn(),
  };
}

/**
 * Create a mock WorkspaceLookup.
 */
function createMockAppState(): WorkspaceLookup {
  return {
    findProjectForWorkspace: vi.fn().mockReturnValue(undefined),
  };
}

/**
 * Create a mock MCP SDK server for testing.
 */
function createMockMcpSdk(): McpServerSdk {
  return {
    registerTool: vi.fn().mockReturnValue({}),
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(false),
    server: {},
  } as unknown as McpServerSdk;
}

describe("McpServerManager", () => {
  let portManager: PortManager;
  let pathProvider: PathProvider;
  let api: ICoreApi;
  let appState: WorkspaceLookup;
  let logger: ReturnType<typeof createMockLogger>;
  let mockSdkFactory: McpServerFactory;
  let activeManager: McpServerManager | null = null;

  beforeEach(() => {
    portManager = createMockPortManager();
    pathProvider = createMockPathProvider({ dataRootDir: "/tmp/test-data" });
    api = createMockCoreApi();
    appState = createMockAppState();
    logger = createMockLogger();
    mockSdkFactory = () => createMockMcpSdk();
    activeManager = null;
  });

  afterEach(async () => {
    // Clean up any running servers to avoid port conflicts
    if (activeManager) {
      await activeManager.stop();
      activeManager = null;
    }
  });

  describe("constructor", () => {
    it("creates manager with all dependencies", () => {
      const manager = new McpServerManager(portManager, pathProvider, api, appState, logger);

      expect(manager).toBeInstanceOf(McpServerManager);
    });

    it("creates manager without logger", () => {
      const manager = new McpServerManager(portManager, pathProvider, api, appState);

      expect(manager).toBeInstanceOf(McpServerManager);
    });
  });

  describe("start", () => {
    it("allocates port via PortManager", async () => {
      activeManager = new McpServerManager(portManager, pathProvider, api, appState, logger, {
        serverFactory: mockSdkFactory,
      });

      await activeManager.start();

      expect(portManager.findFreePort).toHaveBeenCalled();
    });

    it("returns allocated port", async () => {
      activeManager = new McpServerManager(portManager, pathProvider, api, appState, logger, {
        serverFactory: mockSdkFactory,
      });

      const port = await activeManager.start();

      expect(port).toBe(12345);
    });

    it("prevents double-start", async () => {
      activeManager = new McpServerManager(portManager, pathProvider, api, appState, logger, {
        serverFactory: mockSdkFactory,
      });

      await activeManager.start();
      const port2 = await activeManager.start();

      // Should return same port without allocating new one
      expect(port2).toBe(12345);
      expect(portManager.findFreePort).toHaveBeenCalledTimes(1);
    });
  });

  describe("stop", () => {
    it("stops cleanly when not started", async () => {
      const manager = new McpServerManager(portManager, pathProvider, api, appState, logger);

      // Should not throw
      await expect(manager.stop()).resolves.not.toThrow();
    });

    it("clears port after stop", async () => {
      activeManager = new McpServerManager(portManager, pathProvider, api, appState, logger, {
        serverFactory: mockSdkFactory,
      });

      await activeManager.start();
      expect(activeManager.getPort()).toBe(12345);

      await activeManager.stop();
      expect(activeManager.getPort()).toBeNull();
    });

    it("allows restart after stop", async () => {
      activeManager = new McpServerManager(portManager, pathProvider, api, appState, logger, {
        serverFactory: mockSdkFactory,
      });

      await activeManager.start();
      await activeManager.stop();

      // Should be able to start again
      vi.mocked(portManager.findFreePort).mockResolvedValue(54321);
      const port = await activeManager.start();
      expect(port).toBe(54321);
    });
  });

  describe("getPort", () => {
    it("returns null before start", () => {
      const manager = new McpServerManager(portManager, pathProvider, api, appState, logger);

      expect(manager.getPort()).toBeNull();
    });

    it("returns port after start", async () => {
      activeManager = new McpServerManager(portManager, pathProvider, api, appState, logger, {
        serverFactory: mockSdkFactory,
      });

      await activeManager.start();

      expect(activeManager.getPort()).toBe(12345);
    });
  });

  describe("getConfigPath", () => {
    it("returns config path from PathProvider", () => {
      const manager = new McpServerManager(portManager, pathProvider, api, appState, logger);

      // Config path is always available from PathProvider
      expect(manager.getConfigPath()).toContain("codehydra-mcp.json");
    });
  });

  describe("isRunning", () => {
    it("returns false before start", () => {
      const manager = new McpServerManager(portManager, pathProvider, api, appState, logger);

      expect(manager.isRunning()).toBe(false);
    });
  });

  describe("dispose", () => {
    it("stops the manager", async () => {
      activeManager = new McpServerManager(portManager, pathProvider, api, appState, logger, {
        serverFactory: mockSdkFactory,
      });

      await activeManager.start();
      await activeManager.dispose();

      expect(activeManager.getPort()).toBeNull();
    });
  });

  describe("error handling", () => {
    it("cleans up on port allocation failure", async () => {
      const failingPortManager = createMockPortManager({
        findFreePort: vi.fn().mockRejectedValue(new Error("No ports available")),
      });

      const manager = new McpServerManager(failingPortManager, pathProvider, api, appState, logger);

      await expect(manager.start()).rejects.toThrow("No ports available");
      expect(manager.getPort()).toBeNull();
    });
  });
});
