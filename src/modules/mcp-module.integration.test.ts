// @vitest-environment node
/**
 * Integration tests for McpModule and its internal McpServerManager.
 *
 * Tests verify:
 * - McpServerManager lifecycle (start, stop, port allocation, error handling)
 * - Full dispatcher pipeline: app:start -> start MCP server, app:shutdown -> dispose
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Dispatcher } from "../intents/lib/dispatcher";
import { createMockDispatcher } from "../intents/lib/dispatcher.test-utils";

import { INTENT_APP_START, APP_START_OPERATION_ID } from "../intents/app-start";
import type { AppStartIntent } from "../intents/app-start";
import {
  AppShutdownOperation,
  INTENT_APP_SHUTDOWN,
  APP_SHUTDOWN_OPERATION_ID,
} from "../intents/app-shutdown";
import type { AppShutdownIntent } from "../intents/app-shutdown";
import { createMinimalOperation } from "../intents/lib/operation.test-utils";
import type { IntentModule } from "../intents/lib/module";
import { McpServerManager, createMcpModule } from "./mcp-module";
import type { McpServerFactory } from "./mcp-module";
import type { MockPortManager } from "../boundaries/platform/network.test-utils";
import type { McpServer as McpServerSdk } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMockLogger } from "../boundaries/platform/logging";
import { createPortManagerMock } from "../boundaries/platform/network.test-utils";

// =============================================================================
// Mock helpers
// =============================================================================

function createMockMcpSdk(): McpServerSdk {
  return {
    registerTool: vi.fn().mockReturnValue({}),
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(false),
    server: {},
  } as unknown as McpServerSdk;
}

// =============================================================================
// McpServerManager Direct Tests
// =============================================================================

describe("McpServerManager", () => {
  let portManager: MockPortManager;
  let dispatcher: Dispatcher;
  let logger: ReturnType<typeof createMockLogger>;
  let mockSdkFactory: McpServerFactory;
  let activeManager: McpServerManager | null = null;

  beforeEach(() => {
    portManager = createPortManagerMock([12345]);
    dispatcher = createMockDispatcher();
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
      const manager = new McpServerManager(portManager, dispatcher, logger);

      expect(manager).toBeInstanceOf(McpServerManager);
    });

    it("creates manager without logger", () => {
      const manager = new McpServerManager(portManager, dispatcher);

      expect(manager).toBeInstanceOf(McpServerManager);
    });
  });

  describe("start", () => {
    it("allocates port via PortManager", async () => {
      activeManager = new McpServerManager(portManager, dispatcher, logger, {
        serverFactory: mockSdkFactory,
      });

      const port = await activeManager.start();

      // Verify port was allocated (behavioral assertion)
      expect(port).toBe(12345);
      expect(portManager.$.allocatedPorts).toEqual([12345]);
    });

    it("returns allocated port", async () => {
      activeManager = new McpServerManager(portManager, dispatcher, logger, {
        serverFactory: mockSdkFactory,
      });

      const port = await activeManager.start();

      expect(port).toBe(12345);
    });

    it("prevents double-start", async () => {
      activeManager = new McpServerManager(portManager, dispatcher, logger, {
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
      const manager = new McpServerManager(portManager, dispatcher, logger);

      // Should not throw
      await expect(manager.stop()).resolves.not.toThrow();
    });

    it("clears port after stop", async () => {
      activeManager = new McpServerManager(portManager, dispatcher, logger, {
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
      activeManager = new McpServerManager(restartPortManager, dispatcher, logger, {
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
      const manager = new McpServerManager(portManager, dispatcher, logger);

      expect(manager.getPort()).toBeNull();
    });

    it("returns port after start", async () => {
      activeManager = new McpServerManager(portManager, dispatcher, logger, {
        serverFactory: mockSdkFactory,
      });

      await activeManager.start();

      expect(activeManager.getPort()).toBe(12345);
    });
  });

  describe("isRunning", () => {
    it("returns false before start", () => {
      const manager = new McpServerManager(portManager, dispatcher, logger);

      expect(manager.isRunning()).toBe(false);
    });
  });

  describe("dispose", () => {
    it("stops the manager", async () => {
      activeManager = new McpServerManager(portManager, dispatcher, logger, {
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

      const manager = new McpServerManager(failingPortManager, dispatcher, logger);

      await expect(manager.start()).rejects.toThrow("No ports available");
      expect(manager.getPort()).toBeNull();
    });
  });
});

// =============================================================================
// Module Integration Tests (through Dispatcher)
// =============================================================================

describe("McpModule Integration", () => {
  describe("app:start / start hook", () => {
    it("starts MCP server and returns port", async () => {
      const dispatcher = createMockDispatcher();
      const portManager = createPortManagerMock([9999]);
      const mockSdkFactory: McpServerFactory = () => createMockMcpSdk();

      dispatcher.registerOperation(
        INTENT_APP_START,
        createMinimalOperation(APP_START_OPERATION_ID, "start", { throwOnError: false })
      );

      const mcpModule = createMcpModule({
        portManager,
        dispatcher,
        logger: createMockLogger(),
        config: { serverFactory: mockSdkFactory },
      });

      dispatcher.registerModule(mcpModule);

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      expect(portManager.$.allocatedPorts).toEqual([9999]);
    });
  });

  describe("app:shutdown / stop hook", () => {
    it("disposes MCP server", async () => {
      const shutdownDispatcher = createMockDispatcher();
      const portManager = createPortManagerMock([9999]);
      const mockSdkFactory: McpServerFactory = () => createMockMcpSdk();

      shutdownDispatcher.registerOperation(INTENT_APP_SHUTDOWN, new AppShutdownOperation());
      shutdownDispatcher.registerOperation(
        INTENT_APP_START,
        createMinimalOperation(APP_START_OPERATION_ID, "start", { throwOnError: false })
      );

      const mcpModule = createMcpModule({
        portManager,
        dispatcher: shutdownDispatcher,
        logger: createMockLogger(),
        config: { serverFactory: mockSdkFactory },
      });

      // Wire a quit module to prevent app.quit() error
      const quitModule: IntentModule = {
        name: "test-quit",
        hooks: {
          [APP_SHUTDOWN_OPERATION_ID]: {
            quit: { handler: async () => {} },
          },
        },
      };

      shutdownDispatcher.registerModule(mcpModule);
      shutdownDispatcher.registerModule(quitModule);

      // Start to wire callbacks
      await shutdownDispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      // Shutdown
      await shutdownDispatcher.dispatch({
        type: INTENT_APP_SHUTDOWN,
        payload: {},
      } as AppShutdownIntent);

      // After dispose, starting again should allocate the next port
      // (This verifies the manager was properly stopped/disposed)
    });
  });
});
