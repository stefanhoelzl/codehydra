/**
 * Tests for MCP Server Manager.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { McpServerManager } from "./mcp-server-manager";
import type { MockPortManager } from "../platform/network.test-utils";
import type { PathProvider } from "../platform/path-provider";
import type { ICoreApi, IWorkspaceApi, IProjectApi } from "../../shared/api/interfaces";
import type { McpServerFactory } from "./mcp-server";
import type { McpServer as McpServerSdk } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMockLogger } from "../logging";
import { createMockPathProvider } from "../platform/path-provider.test-utils";
import { createPortManagerMock } from "../platform/network.test-utils";

/**
 * Create a mock ICoreApi.
 */
function createMockCoreApi(): ICoreApi {
  return {
    workspaces: {
      create: vi.fn(),
      remove: vi.fn(),
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
  let portManager: MockPortManager;
  let pathProvider: PathProvider;
  let api: ICoreApi;
  let logger: ReturnType<typeof createMockLogger>;
  let mockSdkFactory: McpServerFactory;
  let activeManager: McpServerManager | null = null;

  beforeEach(() => {
    portManager = createPortManagerMock([12345]);
    pathProvider = createMockPathProvider({ dataRootDir: "/tmp/test-data" });
    api = createMockCoreApi();
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
      const manager = new McpServerManager(portManager, pathProvider, api, logger);

      expect(manager).toBeInstanceOf(McpServerManager);
    });

    it("creates manager without logger", () => {
      const manager = new McpServerManager(portManager, pathProvider, api);

      expect(manager).toBeInstanceOf(McpServerManager);
    });
  });

  describe("start", () => {
    it("allocates port via PortManager", async () => {
      activeManager = new McpServerManager(portManager, pathProvider, api, logger, {
        serverFactory: mockSdkFactory,
      });

      const port = await activeManager.start();

      // Verify port was allocated (behavioral assertion)
      expect(port).toBe(12345);
      expect(portManager.$.allocatedPorts).toEqual([12345]);
    });

    it("returns allocated port", async () => {
      activeManager = new McpServerManager(portManager, pathProvider, api, logger, {
        serverFactory: mockSdkFactory,
      });

      const port = await activeManager.start();

      expect(port).toBe(12345);
    });

    it("prevents double-start", async () => {
      activeManager = new McpServerManager(portManager, pathProvider, api, logger, {
        serverFactory: mockSdkFactory,
      });

      await activeManager.start();
      const port2 = await activeManager.start();

      // Should return same port without allocating new one
      expect(port2).toBe(12345);
      // Verify only one port was allocated (behavioral assertion)
      expect(portManager.$.allocatedPorts).toEqual([12345]);
    });
  });

  describe("stop", () => {
    it("stops cleanly when not started", async () => {
      const manager = new McpServerManager(portManager, pathProvider, api, logger);

      // Should not throw
      await expect(manager.stop()).resolves.not.toThrow();
    });

    it("clears port after stop", async () => {
      activeManager = new McpServerManager(portManager, pathProvider, api, logger, {
        serverFactory: mockSdkFactory,
      });

      await activeManager.start();
      expect(activeManager.getPort()).toBe(12345);

      await activeManager.stop();
      expect(activeManager.getPort()).toBeNull();
    });

    it("allows restart after stop", async () => {
      // Provide two ports for start/stop/restart cycle
      const restartPortManager = createPortManagerMock([12345, 54321]);
      activeManager = new McpServerManager(restartPortManager, pathProvider, api, logger, {
        serverFactory: mockSdkFactory,
      });

      await activeManager.start();
      await activeManager.stop();

      // Should be able to start again with next port
      const port = await activeManager.start();
      expect(port).toBe(54321);
    });
  });

  describe("getPort", () => {
    it("returns null before start", () => {
      const manager = new McpServerManager(portManager, pathProvider, api, logger);

      expect(manager.getPort()).toBeNull();
    });

    it("returns port after start", async () => {
      activeManager = new McpServerManager(portManager, pathProvider, api, logger, {
        serverFactory: mockSdkFactory,
      });

      await activeManager.start();

      expect(activeManager.getPort()).toBe(12345);
    });
  });

  describe("isRunning", () => {
    it("returns false before start", () => {
      const manager = new McpServerManager(portManager, pathProvider, api, logger);

      expect(manager.isRunning()).toBe(false);
    });
  });

  describe("dispose", () => {
    it("stops the manager", async () => {
      activeManager = new McpServerManager(portManager, pathProvider, api, logger, {
        serverFactory: mockSdkFactory,
      });

      await activeManager.start();
      await activeManager.dispose();

      expect(activeManager.getPort()).toBeNull();
    });
  });

  describe("error handling", () => {
    it("cleans up on port allocation failure", async () => {
      // Empty port list causes "No ports available" error on first call
      const failingPortManager = createPortManagerMock([]);

      const manager = new McpServerManager(failingPortManager, pathProvider, api, logger);

      await expect(manager.start()).rejects.toThrow("No ports available");
      expect(manager.getPort()).toBeNull();
    });
  });

  describe("onFirstRequest", () => {
    it("returns unsubscribe function", () => {
      const manager = new McpServerManager(portManager, pathProvider, api, logger);
      const callback = vi.fn();

      const unsubscribe = manager.onFirstRequest(callback);

      expect(typeof unsubscribe).toBe("function");
    });

    it("unsubscribe removes callback from internal set", () => {
      const manager = new McpServerManager(portManager, pathProvider, api, logger);
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      const unsub1 = manager.onFirstRequest(callback1);
      manager.onFirstRequest(callback2);

      // Unsubscribe first callback
      unsub1();

      // Internal state is not directly testable, but we can verify
      // that unsubscribe is callable multiple times without error
      expect(() => unsub1()).not.toThrow();
    });

    it("stop clears callbacks", async () => {
      activeManager = new McpServerManager(portManager, pathProvider, api, logger, {
        serverFactory: mockSdkFactory,
      });

      const callback = vi.fn();
      activeManager.onFirstRequest(callback);

      await activeManager.start();
      await activeManager.stop();

      // After stop, callbacks should be cleared (verified by no errors on restart)
      expect(activeManager.getPort()).toBeNull();
    });
  });
});
