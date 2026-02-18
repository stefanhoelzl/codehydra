// @vitest-environment node
/**
 * Integration tests for McpModule through the Dispatcher.
 *
 * Tests verify the full pipeline:
 * - workspace:created event → mcpServerManager.registerWorkspace()
 * - workspace:deleted event → mcpServerManager.unregisterWorkspace()
 * - app:shutdown / stop → dispose MCP server, cleanup callbacks
 * - workspace:delete / shutdown → unregister workspace from MCP
 * - Agent server configured with MCP port
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
// Mock ViewManager
// =============================================================================

function createMockViewManager(): { setWorkspaceLoaded: ReturnType<typeof vi.fn> } {
  return {
    setWorkspaceLoaded: vi.fn(),
  };
}

// =============================================================================
// Mock AgentStatusManager
// =============================================================================

function createMockAgentStatusManager(): { markActive: ReturnType<typeof vi.fn> } {
  return {
    markActive: vi.fn(),
  };
}

// =============================================================================
// Mock AgentServerManager (OpenCode variant)
// =============================================================================

function createMockAgentServerManager(): {
  setMcpConfig: ReturnType<typeof vi.fn>;
  getBridgePort: ReturnType<typeof vi.fn>;
  onWorkspaceReady: ReturnType<typeof vi.fn>;
  capturedWorkspaceReadyCallback: ((workspacePath: string) => void) | null;
} {
  const mock: ReturnType<typeof createMockAgentServerManager> = {
    setMcpConfig: vi.fn(),
    getBridgePort: vi.fn().mockReturnValue(15000),
    capturedWorkspaceReadyCallback: null,
    onWorkspaceReady: vi.fn().mockImplementation((cb: (wp: string) => void) => {
      mock.capturedWorkspaceReadyCallback = cb;
      return () => {
        mock.capturedWorkspaceReadyCallback = null;
      };
    }),
  };
  return mock;
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
  viewManager: ReturnType<typeof createMockViewManager>;
  agentStatusManager: ReturnType<typeof createMockAgentStatusManager>;
  agentServerManager: ReturnType<typeof createMockAgentServerManager>;
  setMcpServerManager: ReturnType<typeof vi.fn>;
}

function createTestSetup(agentType: "opencode" | "claude" = "opencode"): TestSetup {
  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);

  const mcpServerManager = createMockMcpServerManager();
  const viewManager = createMockViewManager();
  const agentStatusManager = createMockAgentStatusManager();
  const agentServerManager = createMockAgentServerManager();
  const setMcpServerManager = vi.fn();

  // Register operations
  dispatcher.registerOperation(INTENT_OPEN_WORKSPACE, new MinimalOpenOperation());
  dispatcher.registerOperation(INTENT_DELETE_WORKSPACE, new MinimalDeleteOperation());
  dispatcher.registerOperation(INTENT_APP_START, new MinimalAppStartOperation());
  dispatcher.registerOperation(INTENT_APP_SHUTDOWN, new AppShutdownOperation());

  const mcpModule = createMcpModule({
    mcpServerManager: mcpServerManager as unknown as McpModuleDeps["mcpServerManager"],
    viewManager: viewManager as unknown as McpModuleDeps["viewManager"],
    agentStatusManager: agentStatusManager as unknown as McpModuleDeps["agentStatusManager"],
    serverManager: agentServerManager as unknown as McpModuleDeps["serverManager"],
    selectedAgentType: agentType,
    logger: SILENT_LOGGER,
    setMcpServerManager,
  });

  wireModules([mcpModule], hookRegistry, dispatcher);

  return {
    dispatcher,
    hookRegistry,
    mcpServerManager,
    viewManager,
    agentStatusManager,
    agentServerManager,
    setMcpServerManager,
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

    it("configures OpenCode agent server manager with MCP config", async () => {
      const { dispatcher, agentServerManager } = createTestSetup("opencode");

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      expect(agentServerManager.setMcpConfig).toHaveBeenCalledWith({
        port: 9999,
      });
    });

    it("configures Claude agent server manager with MCP port only", async () => {
      const { dispatcher, agentServerManager } = createTestSetup("claude");

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      expect(agentServerManager.setMcpConfig).toHaveBeenCalledWith({
        port: 9999,
      });
    });

    it("injects MCP server manager into AppState", async () => {
      const { dispatcher, mcpServerManager, setMcpServerManager } = createTestSetup();

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      expect(setMcpServerManager).toHaveBeenCalledWith(mcpServerManager);
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
        viewManager: createMockViewManager() as unknown as McpModuleDeps["viewManager"],
        agentStatusManager:
          createMockAgentStatusManager() as unknown as McpModuleDeps["agentStatusManager"],
        serverManager: createMockAgentServerManager() as unknown as McpModuleDeps["serverManager"],
        selectedAgentType: "opencode",
        logger: SILENT_LOGGER,
        setMcpServerManager: vi.fn(),
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
    it("disposes MCP server and cleans up callbacks", async () => {
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
        viewManager: createMockViewManager() as unknown as McpModuleDeps["viewManager"],
        agentStatusManager:
          createMockAgentStatusManager() as unknown as McpModuleDeps["agentStatusManager"],
        serverManager: createMockAgentServerManager() as unknown as McpModuleDeps["serverManager"],
        selectedAgentType: "opencode",
        logger: SILENT_LOGGER,
        setMcpServerManager: vi.fn(),
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

  describe("Claude-specific: onWorkspaceReady", () => {
    it("calls setWorkspaceLoaded when Claude wrapper signals ready", async () => {
      const hookRegistry = new HookRegistry();
      const dispatcher = new Dispatcher(hookRegistry);

      const mcpServerManager = createMockMcpServerManager();
      const viewManager = createMockViewManager();

      let capturedReadyCallback: ((workspacePath: string) => void) | null = null;
      const claudeServerManager = {
        setMcpConfig: vi.fn(),
        onWorkspaceReady: vi.fn().mockImplementation((cb: (wp: string) => void) => {
          capturedReadyCallback = cb;
          return () => {
            capturedReadyCallback = null;
          };
        }),
      };

      dispatcher.registerOperation(INTENT_APP_START, new MinimalAppStartOperation());

      const mcpModule = createMcpModule({
        mcpServerManager: mcpServerManager as unknown as McpModuleDeps["mcpServerManager"],
        viewManager: viewManager as unknown as McpModuleDeps["viewManager"],
        agentStatusManager:
          createMockAgentStatusManager() as unknown as McpModuleDeps["agentStatusManager"],
        serverManager: claudeServerManager as unknown as McpModuleDeps["serverManager"],
        selectedAgentType: "claude",
        logger: SILENT_LOGGER,
        setMcpServerManager: vi.fn(),
      });

      wireModules([mcpModule], hookRegistry, dispatcher);

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      expect(claudeServerManager.onWorkspaceReady).toHaveBeenCalled();
      expect(capturedReadyCallback).not.toBeNull();

      capturedReadyCallback!("/workspaces/claude-ws");
      expect(viewManager.setWorkspaceLoaded).toHaveBeenCalledWith("/workspaces/claude-ws");
    });
  });

  describe("OpenCode-specific: onWorkspaceReady", () => {
    it("calls setWorkspaceLoaded and markActive when OpenCode wrapper signals ready", async () => {
      const { dispatcher, agentServerManager, viewManager, agentStatusManager } =
        createTestSetup("opencode");

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      expect(agentServerManager.onWorkspaceReady).toHaveBeenCalled();
      expect(agentServerManager.capturedWorkspaceReadyCallback).not.toBeNull();

      agentServerManager.capturedWorkspaceReadyCallback!("/workspaces/oc-ws");
      expect(viewManager.setWorkspaceLoaded).toHaveBeenCalledWith("/workspaces/oc-ws");
      expect(agentStatusManager.markActive).toHaveBeenCalledWith("/workspaces/oc-ws");
    });
  });

  describe("workspace:open / setup hook", () => {
    it("contributes CODEHYDRA_BRIDGE_PORT env var for OpenCode", async () => {
      const hookRegistry = new HookRegistry();
      const dispatcher = new Dispatcher(hookRegistry);

      const mcpServerManager = createMockMcpServerManager();
      const agentServerManager = createMockAgentServerManager();

      dispatcher.registerOperation(INTENT_APP_START, new MinimalAppStartOperation());

      const mcpModule = createMcpModule({
        mcpServerManager: mcpServerManager as unknown as McpModuleDeps["mcpServerManager"],
        viewManager: createMockViewManager() as unknown as McpModuleDeps["viewManager"],
        agentStatusManager:
          createMockAgentStatusManager() as unknown as McpModuleDeps["agentStatusManager"],
        serverManager: agentServerManager as unknown as McpModuleDeps["serverManager"],
        selectedAgentType: "opencode",
        logger: SILENT_LOGGER,
        setMcpServerManager: vi.fn(),
      });

      wireModules([mcpModule], hookRegistry, dispatcher);

      // Call the setup hook directly through the hook registry
      const setupCtx = {
        intent: { type: "workspace:open", payload: {} },
        workspacePath: "/workspaces/test-ws",
        projectPath: "/projects/test",
      };
      const hooks = hookRegistry.resolve("open-workspace");
      const { results } = await hooks.collect("setup", setupCtx);

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({ envVars: { CODEHYDRA_BRIDGE_PORT: "15000" } });
    });

    it("returns empty result for Claude agent type", async () => {
      const hookRegistry = new HookRegistry();
      const dispatcher = new Dispatcher(hookRegistry);

      const mcpServerManager = createMockMcpServerManager();

      dispatcher.registerOperation(INTENT_APP_START, new MinimalAppStartOperation());

      const claudeServerManager = {
        setMcpConfig: vi.fn(),
        onWorkspaceReady: vi.fn().mockReturnValue(() => {}),
      };

      const mcpModule = createMcpModule({
        mcpServerManager: mcpServerManager as unknown as McpModuleDeps["mcpServerManager"],
        viewManager: createMockViewManager() as unknown as McpModuleDeps["viewManager"],
        agentStatusManager:
          createMockAgentStatusManager() as unknown as McpModuleDeps["agentStatusManager"],
        serverManager: claudeServerManager as unknown as McpModuleDeps["serverManager"],
        selectedAgentType: "claude",
        logger: SILENT_LOGGER,
        setMcpServerManager: vi.fn(),
      });

      wireModules([mcpModule], hookRegistry, dispatcher);

      const setupCtx = {
        intent: { type: "workspace:open", payload: {} },
        workspacePath: "/workspaces/test-ws",
        projectPath: "/projects/test",
      };
      const hooks = hookRegistry.resolve("open-workspace");
      const { results } = await hooks.collect("setup", setupCtx);

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({});
    });
  });
});
