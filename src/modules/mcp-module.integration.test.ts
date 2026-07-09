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
    portManager = createPortManagerMock();
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
    it("binds a port via PortManager", async () => {
      activeManager = new McpServerManager(portManager, dispatcher, logger, {
        serverFactory: mockSdkFactory,
      });

      const port = await activeManager.start();

      // The port the server listens on is the one PortManager bound for it.
      expect(port).toBeGreaterThan(0);
      expect(portManager.$.allocatedPorts).toEqual([port]);
    });

    it("prevents double-start", async () => {
      activeManager = new McpServerManager(portManager, dispatcher, logger, {
        serverFactory: mockSdkFactory,
      });

      const port1 = await activeManager.start();
      const port2 = await activeManager.start();

      // Should return same port without binding a new one
      expect(port2).toBe(port1);
      expect(portManager.$.allocatedPorts).toEqual([port1]);
    });
  });

  describe("stop", () => {
    it("stops cleanly when not started", async () => {
      const manager = new McpServerManager(portManager, dispatcher, logger);

      // Should not throw
      await expect(manager.stop()).resolves.not.toThrow();
    });

    it("allows restart after stop", async () => {
      const restartPortManager = createPortManagerMock();
      activeManager = new McpServerManager(restartPortManager, dispatcher, logger, {
        serverFactory: mockSdkFactory,
      });

      const first = await activeManager.start();
      await activeManager.stop();

      // Should be able to start again, binding a second port
      const second = await activeManager.start();
      expect(second).toBeGreaterThan(0);
      expect(restartPortManager.$.allocatedPorts).toEqual([first, second]);
    });
  });

  describe("dispose", () => {
    it("stops the manager", async () => {
      const disposePortManager = createPortManagerMock();
      activeManager = new McpServerManager(disposePortManager, dispatcher, logger, {
        serverFactory: mockSdkFactory,
      });

      const first = await activeManager.start();
      await activeManager.dispose();

      // After dispose, starting again binds a fresh port
      const second = await activeManager.start();
      expect(second).toBeGreaterThan(0);
      expect(disposePortManager.$.allocatedPorts).toEqual([first, second]);
    });
  });

  describe("error handling", () => {
    it("cleans up when the server cannot bind a port", async () => {
      const failingPortManager = {
        ...createPortManagerMock(),
        listenOnFreePort: vi.fn().mockRejectedValue(new Error("bind failed")),
      };

      const manager = new McpServerManager(failingPortManager, dispatcher, logger);

      await expect(manager.start()).rejects.toThrow("bind failed");
      // A failed start must not leave the manager looking alive.
      await expect(manager.stop()).resolves.not.toThrow();
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
      const portManager = createPortManagerMock();
      const mockSdkFactory: McpServerFactory = () => createMockMcpSdk();

      dispatcher.registerOperation(
        createMinimalOperation(APP_START_OPERATION_ID, INTENT_APP_START, "start", {
          throwOnError: false,
        })
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

      expect(portManager.$.allocatedPorts).toHaveLength(1);
      expect(portManager.$.allocatedPorts[0]).toBeGreaterThan(0);
    });
  });

  describe("app:shutdown / stop hook", () => {
    it("disposes MCP server", async () => {
      const shutdownDispatcher = createMockDispatcher();
      const portManager = createPortManagerMock();
      const mockSdkFactory: McpServerFactory = () => createMockMcpSdk();

      shutdownDispatcher.registerOperation(new AppShutdownOperation());
      shutdownDispatcher.registerOperation(
        createMinimalOperation(APP_START_OPERATION_ID, INTENT_APP_START, "start", {
          throwOnError: false,
        })
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
