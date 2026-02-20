// @vitest-environment node
/**
 * Integration tests for McpModule through the Dispatcher.
 *
 * Tests verify the full pipeline:
 * - app:start / start → start MCP server, return port
 * - app:shutdown / stop → dispose MCP server
 */

import { describe, it, expect, vi } from "vitest";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";
import { wireModules } from "../intents/infrastructure/wire";
import { INTENT_APP_START, APP_START_OPERATION_ID } from "../operations/app-start";
import type { AppStartIntent } from "../operations/app-start";
import {
  AppShutdownOperation,
  INTENT_APP_SHUTDOWN,
  APP_SHUTDOWN_OPERATION_ID,
} from "../operations/app-shutdown";
import type { AppShutdownIntent } from "../operations/app-shutdown";
import type { Operation, OperationContext } from "../intents/infrastructure/operation";
import type { IntentModule } from "../intents/infrastructure/module";
import { createMcpModule, type McpModuleDeps } from "./mcp-module";
import { SILENT_LOGGER } from "../../services/logging";

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
// Minimal operations for testing
// =============================================================================

/**
 * Minimal app:start that only runs the "start" hook point.
 * The real AppStartOperation has many hook points (show-ui, check-config, etc.)
 * but we only need "start" for MCP module testing.
 */
class MinimalAppStartOperation implements Operation<AppStartIntent, void> {
  readonly id = APP_START_OPERATION_ID;

  async execute(ctx: OperationContext<AppStartIntent>): Promise<void> {
    await ctx.hooks.collect("start", { intent: ctx.intent });
  }
}

// =============================================================================
// Test Setup
// =============================================================================

interface TestSetup {
  dispatcher: Dispatcher;
  hookRegistry: HookRegistry;
  mcpServerManager: MockMcpServerManager;
}

function createTestSetup(): TestSetup {
  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);

  const mcpServerManager = createMockMcpServerManager();

  // Register operations
  dispatcher.registerOperation(INTENT_APP_START, new MinimalAppStartOperation());
  dispatcher.registerOperation(INTENT_APP_SHUTDOWN, new AppShutdownOperation());

  const mcpModule = createMcpModule({
    mcpServerManager: mcpServerManager as unknown as McpModuleDeps["mcpServerManager"],
    logger: SILENT_LOGGER,
  });

  wireModules([mcpModule], hookRegistry, dispatcher);

  return {
    dispatcher,
    hookRegistry,
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
        hooks: {
          [APP_SHUTDOWN_OPERATION_ID]: {
            quit: { handler: async () => {} },
          },
        },
      };
      const hookRegistry = new HookRegistry();
      const shutdownDispatcher = new Dispatcher(hookRegistry);
      shutdownDispatcher.registerOperation(INTENT_APP_SHUTDOWN, new AppShutdownOperation());
      shutdownDispatcher.registerOperation(INTENT_APP_START, new MinimalAppStartOperation());

      const msm = createMockMcpServerManager();
      const mcpModule = createMcpModule({
        mcpServerManager: msm as unknown as McpModuleDeps["mcpServerManager"],
        logger: SILENT_LOGGER,
      });

      wireModules([mcpModule, quitModule], hookRegistry, shutdownDispatcher);

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
