// @vitest-environment node
/**
 * Integration tests for McpModule through the Dispatcher.
 *
 * Tests verify the full pipeline:
 * - workspace:created event → mcpServerManager.registerWorkspace()
 * - workspace:deleted event → mcpServerManager.unregisterWorkspace()
 * - app:start / start → start MCP server, return port
 * - workspace:delete / shutdown → unregister workspace from MCP
 * - app:shutdown / stop → dispose MCP server
 */

import { describe, it, expect, vi } from "vitest";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";
import { wireModules } from "../intents/infrastructure/wire";
import { INTENT_OPEN_WORKSPACE, EVENT_WORKSPACE_CREATED } from "../operations/open-workspace";
import type { OpenWorkspaceIntent, WorkspaceCreatedEvent } from "../operations/open-workspace";
import {
  INTENT_DELETE_WORKSPACE,
  EVENT_WORKSPACE_DELETED,
  DELETE_WORKSPACE_OPERATION_ID,
} from "../operations/delete-workspace";
import type { DeleteWorkspaceIntent, WorkspaceDeletedEvent } from "../operations/delete-workspace";
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
import type { ProjectId, WorkspaceName } from "../../shared/api/types";

// =============================================================================
// Mock McpServerManager
// =============================================================================

interface MockMcpServerManager {
  start: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  registerWorkspace: ReturnType<typeof vi.fn>;
  unregisterWorkspace: ReturnType<typeof vi.fn>;
  getPort: ReturnType<typeof vi.fn>;
}

function createMockMcpServerManager(port = 9999): MockMcpServerManager {
  return {
    start: vi.fn().mockResolvedValue(port),
    dispose: vi.fn().mockResolvedValue(undefined),
    registerWorkspace: vi.fn(),
    unregisterWorkspace: vi.fn(),
    getPort: vi.fn().mockReturnValue(port),
  };
}

// =============================================================================
// Minimal operations that emit events for testing
// =============================================================================

class MinimalOpenOperation implements Operation<OpenWorkspaceIntent, unknown> {
  readonly id = "open-workspace";

  async execute(ctx: OperationContext<OpenWorkspaceIntent>): Promise<unknown> {
    const { payload } = ctx.intent;
    const event: WorkspaceCreatedEvent = {
      type: EVENT_WORKSPACE_CREATED,
      payload: {
        projectId: payload.projectId as unknown as ProjectId,
        workspaceName: payload.workspaceName as unknown as WorkspaceName,
        workspacePath: `/workspaces/${payload.workspaceName}`,
        projectPath: `/projects/test`,
        branch: payload.base ?? "main",
        base: payload.base ?? "main",
        metadata: {},
        workspaceUrl: `http://127.0.0.1:0/?folder=/workspaces/${payload.workspaceName}`,
      },
    };
    ctx.emit(event);
    return {};
  }
}

class MinimalDeleteOperation implements Operation<DeleteWorkspaceIntent, { started: true }> {
  readonly id = DELETE_WORKSPACE_OPERATION_ID;

  async execute(ctx: OperationContext<DeleteWorkspaceIntent>): Promise<{ started: true }> {
    const { payload } = ctx.intent;
    const event: WorkspaceDeletedEvent = {
      type: EVENT_WORKSPACE_DELETED,
      payload: {
        projectId: payload.projectId,
        workspaceName: payload.workspaceName,
        workspacePath: payload.workspacePath,
        projectPath: payload.projectPath,
      },
    };
    ctx.emit(event);
    return { started: true };
  }
}

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
  dispatcher.registerOperation(INTENT_OPEN_WORKSPACE, new MinimalOpenOperation());
  dispatcher.registerOperation(INTENT_DELETE_WORKSPACE, new MinimalDeleteOperation());
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
  describe("workspace:created event triggers registerWorkspace", () => {
    it("registers workspace with MCP server manager on workspace:created", async () => {
      const { dispatcher, mcpServerManager } = createTestSetup();

      await dispatcher.dispatch({
        type: INTENT_OPEN_WORKSPACE,
        payload: {
          projectId: "test-project" as unknown as ProjectId,
          workspaceName: "ws1" as unknown as WorkspaceName,
          base: "main",
        },
      } as OpenWorkspaceIntent);

      expect(mcpServerManager.registerWorkspace).toHaveBeenCalledWith({
        projectId: "test-project",
        workspaceName: "ws1",
        workspacePath: "/workspaces/ws1",
      });
    });
  });

  describe("workspace:deleted event triggers unregisterWorkspace", () => {
    it("unregisters workspace from MCP server manager on workspace:deleted", async () => {
      const { dispatcher, mcpServerManager } = createTestSetup();

      await dispatcher.dispatch({
        type: INTENT_DELETE_WORKSPACE,
        payload: {
          projectId: "test-12345678" as ProjectId,
          workspaceName: "ws1" as WorkspaceName,
          workspacePath: "/workspaces/ws1",
          projectPath: "/projects/test",
          keepBranch: false,
          force: false,
          removeWorktree: true,
        },
      } as DeleteWorkspaceIntent);

      expect(mcpServerManager.unregisterWorkspace).toHaveBeenCalledWith("/workspaces/ws1");
    });
  });

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

  describe("workspace:delete / shutdown hook", () => {
    it("unregisters workspace from MCP during deletion", async () => {
      // Setup with a delete operation that calls shutdown hooks
      const hookRegistry = new HookRegistry();
      const d = new Dispatcher(hookRegistry);

      const msm = createMockMcpServerManager();
      d.registerOperation(
        INTENT_DELETE_WORKSPACE,
        new (class implements Operation<DeleteWorkspaceIntent, { started: true }> {
          readonly id = DELETE_WORKSPACE_OPERATION_ID;
          async execute(ctx: OperationContext<DeleteWorkspaceIntent>): Promise<{ started: true }> {
            await ctx.hooks.collect("shutdown", { intent: ctx.intent });
            const event: WorkspaceDeletedEvent = {
              type: EVENT_WORKSPACE_DELETED,
              payload: {
                projectId: ctx.intent.payload.projectId,
                workspaceName: ctx.intent.payload.workspaceName,
                workspacePath: ctx.intent.payload.workspacePath,
                projectPath: ctx.intent.payload.projectPath,
              },
            };
            ctx.emit(event);
            return { started: true };
          }
        })()
      );

      const mcpModule = createMcpModule({
        mcpServerManager: msm as unknown as McpModuleDeps["mcpServerManager"],
        logger: SILENT_LOGGER,
      });

      wireModules([mcpModule], hookRegistry, d);

      await d.dispatch({
        type: INTENT_DELETE_WORKSPACE,
        payload: {
          projectId: "test-12345678" as ProjectId,
          workspaceName: "ws1" as WorkspaceName,
          workspacePath: "/workspaces/ws1",
          projectPath: "/projects/test",
          keepBranch: false,
          force: false,
          removeWorktree: true,
        },
      } as DeleteWorkspaceIntent);

      // Called twice: once from shutdown hook, once from workspace:deleted event
      expect(msm.unregisterWorkspace).toHaveBeenCalledWith("/workspaces/ws1");
      expect(msm.unregisterWorkspace).toHaveBeenCalledTimes(2);
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
