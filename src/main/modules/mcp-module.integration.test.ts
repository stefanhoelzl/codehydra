// @vitest-environment node
/**
 * Integration tests for McpModule through the Dispatcher.
 *
 * Tests verify the full pipeline:
 * - app:start / start → start MCP server, return port
 * - app:shutdown / stop → dispose MCP server
 */

import { describe, it, expect, vi } from "vitest";
import { Dispatcher } from "../intents/infrastructure/dispatcher";
import { createMockLogger } from "../../services/logging/logging.test-utils";

import { INTENT_APP_START, APP_START_OPERATION_ID } from "../operations/app-start";
import type { AppStartIntent } from "../operations/app-start";
import {
  AppShutdownOperation,
  INTENT_APP_SHUTDOWN,
  APP_SHUTDOWN_OPERATION_ID,
} from "../operations/app-shutdown";
import type { AppShutdownIntent } from "../operations/app-shutdown";
import { createMinimalOperation } from "../intents/infrastructure/operation.test-utils";
import type { IntentModule } from "../intents/infrastructure/module";
import { createMcpModule, type McpModuleDeps } from "./mcp-module";

// =============================================================================
// Mock McpServerManager
// =============================================================================

interface MockMcpServerManager {
  start: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  getPort: ReturnType<typeof vi.fn>;
}

function createMockMcpServerManager(port = 9999): MockMcpServerManager {
  return {
    start: vi.fn().mockResolvedValue(port),
    dispose: vi.fn().mockResolvedValue(undefined),
    getPort: vi.fn().mockReturnValue(port),
  };
}

// =============================================================================
// Test Setup
// =============================================================================

interface TestSetup {
  dispatcher: Dispatcher;
  mcpServerManager: MockMcpServerManager;
}

function createTestSetup(): TestSetup {
  const dispatcher = new Dispatcher({ logger: createMockLogger() });

  const mcpServerManager = createMockMcpServerManager();

  // Register operations
  dispatcher.registerOperation(
    INTENT_APP_START,
    createMinimalOperation(APP_START_OPERATION_ID, "start", { throwOnError: false })
  );
  dispatcher.registerOperation(INTENT_APP_SHUTDOWN, new AppShutdownOperation());

  const mcpModule = createMcpModule({
    mcpServerManager: mcpServerManager as unknown as McpModuleDeps["mcpServerManager"],
  });

  dispatcher.registerModule(mcpModule);

  return {
    dispatcher,
    mcpServerManager,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("McpModule Integration", () => {
  describe("app:start / start hook", () => {
    it("starts MCP server and returns port", async () => {
      const { dispatcher, mcpServerManager } = createTestSetup();

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      expect(mcpServerManager.start).toHaveBeenCalled();
    });
  });

  describe("app:shutdown / stop hook", () => {
    it("disposes MCP server", async () => {
      // Wire a quit module to prevent app.quit() error
      const quitModule: IntentModule = {
        name: "test-quit",
        hooks: {
          [APP_SHUTDOWN_OPERATION_ID]: {
            quit: { handler: async () => {} },
          },
        },
      };
      const shutdownDispatcher = new Dispatcher({ logger: createMockLogger() });
      shutdownDispatcher.registerOperation(INTENT_APP_SHUTDOWN, new AppShutdownOperation());
      shutdownDispatcher.registerOperation(
        INTENT_APP_START,
        createMinimalOperation(APP_START_OPERATION_ID, "start", { throwOnError: false })
      );

      const msm = createMockMcpServerManager();
      const mcpModule = createMcpModule({
        mcpServerManager: msm as unknown as McpModuleDeps["mcpServerManager"],
      });

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

      expect(msm.dispose).toHaveBeenCalled();
    });
  });
});
