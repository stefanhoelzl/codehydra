/**
 * Tests for MCP Server Manager.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { McpServerManager } from "./mcp-server-manager";
import type { MockPortManager } from "../platform/network.test-utils";
import type { McpApiHandlers } from "./types";
import type { McpServerFactory } from "./mcp-server";
import type { McpServer as McpServerSdk } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMockLogger } from "../logging";
import { createPortManagerMock } from "../platform/network.test-utils";

/**
 * Create a mock McpApiHandlers.
 */
function createMockMcpHandlers(): McpApiHandlers {
  return {
    getStatus: vi.fn(),
    getMetadata: vi.fn(),
    setMetadata: vi.fn(),
    getAgentSession: vi.fn(),
    restartAgentServer: vi.fn(),
    listProjects: vi.fn(),
    createWorkspace: vi.fn(),
    deleteWorkspace: vi.fn(),
    executeCommand: vi.fn(),
    showMessage: vi.fn(),
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
  let handlers: McpApiHandlers;
  let logger: ReturnType<typeof createMockLogger>;
  let mockSdkFactory: McpServerFactory;
  let activeManager: McpServerManager | null = null;

  beforeEach(() => {
    portManager = createPortManagerMock([12345]);
    handlers = createMockMcpHandlers();
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
      const manager = new McpServerManager(portManager, () => handlers, logger);

      expect(manager).toBeInstanceOf(McpServerManager);
    });

    it("creates manager without logger", () => {
      const manager = new McpServerManager(portManager, () => handlers);

      expect(manager).toBeInstanceOf(McpServerManager);
    });
  });

  describe("start", () => {
    it("allocates port via PortManager", async () => {
      activeManager = new McpServerManager(portManager, () => handlers, logger, {
        serverFactory: mockSdkFactory,
      });

      const port = await activeManager.start();

      // Verify port was allocated (behavioral assertion)
      expect(port).toBe(12345);
      expect(portManager.$.allocatedPorts).toEqual([12345]);
    });

    it("returns allocated port", async () => {
      activeManager = new McpServerManager(portManager, () => handlers, logger, {
        serverFactory: mockSdkFactory,
      });

      const port = await activeManager.start();

      expect(port).toBe(12345);
    });

    it("prevents double-start", async () => {
      activeManager = new McpServerManager(portManager, () => handlers, logger, {
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
      const manager = new McpServerManager(portManager, () => handlers, logger);

      // Should not throw
      await expect(manager.stop()).resolves.not.toThrow();
    });

    it("clears port after stop", async () => {
      activeManager = new McpServerManager(portManager, () => handlers, logger, {
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
      activeManager = new McpServerManager(restartPortManager, () => handlers, logger, {
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
      const manager = new McpServerManager(portManager, () => handlers, logger);

      expect(manager.getPort()).toBeNull();
    });

    it("returns port after start", async () => {
      activeManager = new McpServerManager(portManager, () => handlers, logger, {
        serverFactory: mockSdkFactory,
      });

      await activeManager.start();

      expect(activeManager.getPort()).toBe(12345);
    });
  });

  describe("isRunning", () => {
    it("returns false before start", () => {
      const manager = new McpServerManager(portManager, () => handlers, logger);

      expect(manager.isRunning()).toBe(false);
    });
  });

  describe("dispose", () => {
    it("stops the manager", async () => {
      activeManager = new McpServerManager(portManager, () => handlers, logger, {
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

      const manager = new McpServerManager(failingPortManager, () => handlers, logger);

      await expect(manager.start()).rejects.toThrow("No ports available");
      expect(manager.getPort()).toBeNull();
    });
  });
});
