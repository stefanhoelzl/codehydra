// @vitest-environment node
/**
 * Integration tests for PluginServerModule through the Dispatcher.
 *
 * Tests verify the full pipeline: dispatcher -> operation -> hook handlers.
 * Uses minimal test operations that exercise specific hook points, with
 * all dependencies mocked via vi.fn().
 */

import { describe, it, expect, vi } from "vitest";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher, IntentHandle } from "../intents/infrastructure/dispatcher";

import type { Operation, OperationContext } from "../intents/infrastructure/operation";
import type { Intent } from "../intents/infrastructure/types";
import { createMinimalOperation } from "../intents/infrastructure/operation.test-utils";
import { APP_START_OPERATION_ID } from "../operations/app-start";
import { APP_SHUTDOWN_OPERATION_ID } from "../operations/app-shutdown";
import { OPEN_WORKSPACE_OPERATION_ID, INTENT_OPEN_WORKSPACE } from "../operations/open-workspace";
import type { FinalizeHookInput, OpenWorkspaceIntent } from "../operations/open-workspace";
import {
  DELETE_WORKSPACE_OPERATION_ID,
  INTENT_DELETE_WORKSPACE,
} from "../operations/delete-workspace";
import type {
  DeleteWorkspaceIntent,
  DeletePipelineHookInput,
  DeleteHookResult,
} from "../operations/delete-workspace";
import { createPluginServerModule, type PluginServerModuleDeps } from "./plugin-server-module";
import { SILENT_LOGGER } from "../../services/logging";
import type { ProjectId, WorkspaceName } from "../../shared/api/types";
import type { ApiCallHandlers } from "../../services/plugin-server/plugin-server";
import { INTENT_GET_WORKSPACE_STATUS } from "../operations/get-workspace-status";
import { INTENT_GET_AGENT_SESSION } from "../operations/get-agent-session";
import { INTENT_RESTART_AGENT } from "../operations/restart-agent";
import { INTENT_GET_METADATA } from "../operations/get-metadata";
import { INTENT_SET_METADATA } from "../operations/set-metadata";
import { INTENT_RESOLVE_WORKSPACE } from "../operations/resolve-workspace";
import { INTENT_VSCODE_COMMAND } from "../operations/vscode-command";

// =============================================================================
// Minimal Test Operations
// =============================================================================

class MinimalStartOperation implements Operation<Intent, number | null> {
  readonly id = APP_START_OPERATION_ID;

  async execute(ctx: OperationContext<Intent>): Promise<number | null> {
    const { errors, capabilities } = await ctx.hooks.collect<void>("start", {
      intent: ctx.intent,
    });
    if (errors.length > 0) throw errors[0]!;
    return (capabilities.pluginPort as number | null) ?? null;
  }
}

class MinimalFinalizeOperation implements Operation<OpenWorkspaceIntent, void> {
  readonly id = OPEN_WORKSPACE_OPERATION_ID;
  private readonly hookInput: Partial<FinalizeHookInput>;

  constructor(hookInput: Partial<FinalizeHookInput> = {}) {
    this.hookInput = hookInput;
  }

  async execute(ctx: OperationContext<OpenWorkspaceIntent>): Promise<void> {
    const { errors } = await ctx.hooks.collect<void>("finalize", {
      intent: ctx.intent,
      workspacePath: "/test/project/.worktrees/feature-1",
      envVars: { OPENCODE_PORT: "8080" },
      agentType: "opencode" as const,
      ...this.hookInput,
    });
    if (errors.length > 0) throw errors[0]!;
  }
}

class MinimalDeleteOperation implements Operation<DeleteWorkspaceIntent, DeleteHookResult> {
  readonly id = DELETE_WORKSPACE_OPERATION_ID;

  async execute(ctx: OperationContext<DeleteWorkspaceIntent>): Promise<DeleteHookResult> {
    const { payload } = ctx.intent;
    const hookCtx: DeletePipelineHookInput = {
      intent: ctx.intent,
      projectPath: "/projects/test",
      workspacePath: payload.workspacePath ?? "",
    };
    const { results, errors } = await ctx.hooks.collect<DeleteHookResult>("delete", hookCtx);
    if (errors.length > 0) throw errors[0]!;
    return results[0] ?? {};
  }
}

// =============================================================================
// Mock Factories
// =============================================================================

function createMockDeps(overrides?: Partial<PluginServerModuleDeps>): PluginServerModuleDeps {
  return {
    pluginServer: {
      start: vi.fn().mockResolvedValue(3456),
      close: vi.fn().mockResolvedValue(undefined),
      setWorkspaceConfig: vi.fn(),
      removeWorkspaceConfig: vi.fn(),
      onApiCall: vi.fn(),
      sendCommand: vi.fn(),
      showNotification: vi.fn().mockResolvedValue({ success: true, data: { action: null } }),
      updateStatusBar: vi.fn().mockResolvedValue({ success: true, data: undefined }),
      disposeStatusBar: vi.fn().mockResolvedValue({ success: true, data: undefined }),
      showQuickPick: vi.fn().mockResolvedValue({ success: true, data: { selected: null } }),
      showInputBox: vi.fn().mockResolvedValue({ success: true, data: { value: null } }),
    },
    dispatcher: { dispatch: vi.fn() } as unknown as PluginServerModuleDeps["dispatcher"],
    logger: SILENT_LOGGER,
    ...overrides,
  };
}

// =============================================================================
// Test Setup
// =============================================================================

function createTestSetup(mockDeps?: PluginServerModuleDeps) {
  const deps = mockDeps ?? createMockDeps();
  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);
  const module = createPluginServerModule(deps);

  dispatcher.registerModule(module);

  return { deps, dispatcher, hookRegistry };
}

// =============================================================================
// Tests
// =============================================================================

describe("PluginServerModule", () => {
  // ---------------------------------------------------------------------------
  // start
  // ---------------------------------------------------------------------------

  describe("start", () => {
    it("starts PluginServer and registers API handlers", async () => {
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation("app:start", new MinimalStartOperation());

      await dispatcher.dispatch({ type: "app:start", payload: {} });

      expect(deps.pluginServer!.start).toHaveBeenCalled();
      expect(deps.pluginServer!.onApiCall).toHaveBeenCalled();
    });

    it("provides pluginPort capability with the plugin port", async () => {
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation("app:start", new MinimalStartOperation());

      const pluginPort = await dispatcher.dispatch({ type: "app:start", payload: {} });

      expect(pluginPort).toBe(3456);
    });

    it("provides null pluginPort capability with null pluginServer", async () => {
      const deps = createMockDeps({ pluginServer: null });
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation("app:start", new MinimalStartOperation());

      const pluginPort = await dispatcher.dispatch({
        type: "app:start",
        payload: {},
      });

      expect(pluginPort).toBeNull();
    });

    it("degrades gracefully when PluginServer fails, provides null pluginPort", async () => {
      const deps = createMockDeps({
        pluginServer: {
          start: vi.fn().mockRejectedValue(new Error("bind failed")),
          close: vi.fn().mockResolvedValue(undefined),
          setWorkspaceConfig: vi.fn(),
          removeWorkspaceConfig: vi.fn(),
          onApiCall: vi.fn(),
          sendCommand: vi.fn(),
          showNotification: vi.fn(),
          updateStatusBar: vi.fn(),
          disposeStatusBar: vi.fn(),
          showQuickPick: vi.fn(),
          showInputBox: vi.fn(),
        },
      });
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation("app:start", new MinimalStartOperation());

      const pluginPort = await dispatcher.dispatch({ type: "app:start", payload: {} });

      expect(pluginPort).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // stop
  // ---------------------------------------------------------------------------

  describe("stop", () => {
    it("closes PluginServer", async () => {
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation(
        "app:shutdown",
        createMinimalOperation(APP_SHUTDOWN_OPERATION_ID, "stop", { throwOnError: false })
      );

      await dispatcher.dispatch({ type: "app:shutdown", payload: {} });

      expect(deps.pluginServer!.close).toHaveBeenCalled();
    });

    it("handles null pluginServer gracefully", async () => {
      const deps = createMockDeps({ pluginServer: null });
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation(
        "app:shutdown",
        createMinimalOperation(APP_SHUTDOWN_OPERATION_ID, "stop", { throwOnError: false })
      );

      await expect(
        dispatcher.dispatch({ type: "app:shutdown", payload: {} })
      ).resolves.not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // finalize
  // ---------------------------------------------------------------------------

  describe("finalize", () => {
    it("calls setWorkspaceConfig on PluginServer during finalize", async () => {
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);

      dispatcher.registerOperation(
        "workspace:open",
        new MinimalFinalizeOperation({
          workspacePath: "/test/project/.worktrees/feature-1",
          envVars: { OPENCODE_PORT: "8080" },
          agentType: "opencode",
        })
      );

      await dispatcher.dispatch({
        type: "workspace:open",
        payload: {
          projectPath: "/test/project",
          workspaceName: "feature-1",
          base: "main",
        },
      } as OpenWorkspaceIntent);

      expect(deps.pluginServer!.setWorkspaceConfig).toHaveBeenCalledWith(
        "/test/project/.worktrees/feature-1",
        { OPENCODE_PORT: "8080" },
        "opencode",
        true
      );
    });

    it("passes resetWorkspace=false for existing (reopened) workspaces", async () => {
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);

      dispatcher.registerOperation(
        "workspace:open",
        new MinimalFinalizeOperation({
          workspacePath: "/test/project/.worktrees/feature-1",
          envVars: { OPENCODE_PORT: "8080" },
          agentType: "opencode",
        })
      );

      await dispatcher.dispatch({
        type: "workspace:open",
        payload: {
          projectPath: "/test/project",
          workspaceName: "feature-1",
          base: "main",
          existingWorkspace: {
            path: "/test/project/.worktrees/feature-1",
            name: "feature-1",
            branch: "feature-1",
            metadata: {},
          },
        },
      } as OpenWorkspaceIntent);

      expect(deps.pluginServer!.setWorkspaceConfig).toHaveBeenCalledWith(
        "/test/project/.worktrees/feature-1",
        { OPENCODE_PORT: "8080" },
        "opencode",
        false
      );
    });

    it("skips setWorkspaceConfig with null pluginServer", async () => {
      const deps = createMockDeps({ pluginServer: null });
      const { dispatcher } = createTestSetup(deps);

      dispatcher.registerOperation(
        "workspace:open",
        new MinimalFinalizeOperation({
          workspacePath: "/test/project/.worktrees/feature-1",
          envVars: { OPENCODE_PORT: "8080" },
          agentType: "opencode",
        })
      );

      // Should resolve without error (no-op with null pluginServer)
      await expect(
        dispatcher.dispatch({
          type: "workspace:open",
          payload: {
            projectPath: "/test/project",
            workspaceName: "feature-1",
            base: "main",
          },
        } as OpenWorkspaceIntent)
      ).resolves.not.toThrow();
    });

    it("does not provide workspaceUrl capability (plugin server has no URL)", async () => {
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);

      dispatcher.registerOperation(
        "workspace:open",
        new MinimalFinalizeOperation({
          workspacePath: "/test/project/.worktrees/feature-1",
          envVars: { OPENCODE_PORT: "8080" },
          agentType: "opencode",
        })
      );

      // Should resolve without error (plugin server does not provide workspaceUrl)
      await expect(
        dispatcher.dispatch({
          type: "workspace:open",
          payload: {
            projectPath: "/test/project",
            workspaceName: "feature-1",
            base: "main",
          },
        } as OpenWorkspaceIntent)
      ).resolves.not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // delete
  // ---------------------------------------------------------------------------

  describe("delete", () => {
    it("calls removeWorkspaceConfig on PluginServer during delete", async () => {
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation("workspace:delete", new MinimalDeleteOperation());

      await dispatcher.dispatch({
        type: "workspace:delete",
        payload: {
          projectId: "test-12345678" as ProjectId,
          workspaceName: "feature-1" as WorkspaceName,
          workspacePath: "/test/project/.worktrees/feature-1",
          projectPath: "/test/project",
          keepBranch: false,
          force: false,
          removeWorktree: true,
        },
      } as DeleteWorkspaceIntent);

      expect(deps.pluginServer!.removeWorkspaceConfig).toHaveBeenCalledWith(
        "/test/project/.worktrees/feature-1"
      );
    });

    it("handles null pluginServer gracefully during delete", async () => {
      const deps = createMockDeps({ pluginServer: null });
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation("workspace:delete", new MinimalDeleteOperation());

      const result = (await dispatcher.dispatch({
        type: "workspace:delete",
        payload: {
          projectId: "test-12345678" as ProjectId,
          workspaceName: "feature-1" as WorkspaceName,
          workspacePath: "/test/project/.worktrees/feature-1",
          projectPath: "/test/project",
          keepBranch: false,
          force: false,
          removeWorktree: true,
        },
      } as DeleteWorkspaceIntent)) as DeleteHookResult;

      expect(result).toEqual({});
    });

    it("ignores errors in force mode", async () => {
      const deps = createMockDeps({
        pluginServer: {
          start: vi.fn().mockResolvedValue(3456),
          close: vi.fn().mockResolvedValue(undefined),
          setWorkspaceConfig: vi.fn(),
          removeWorkspaceConfig: vi.fn().mockImplementation(() => {
            throw new Error("socket error");
          }),
          onApiCall: vi.fn(),
          sendCommand: vi.fn(),
          showNotification: vi.fn(),
          updateStatusBar: vi.fn(),
          disposeStatusBar: vi.fn(),
          showQuickPick: vi.fn(),
          showInputBox: vi.fn(),
        },
      });
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation("workspace:delete", new MinimalDeleteOperation());

      const result = (await dispatcher.dispatch({
        type: "workspace:delete",
        payload: {
          projectId: "test-12345678" as ProjectId,
          workspaceName: "feature-1" as WorkspaceName,
          workspacePath: "/test/project/.worktrees/feature-1",
          projectPath: "/test/project",
          keepBranch: false,
          force: true,
          removeWorktree: true,
        },
      } as DeleteWorkspaceIntent)) as DeleteHookResult;

      expect(result).toEqual({});
    });
  });

  // ---------------------------------------------------------------------------
  // Plugin API handlers
  // ---------------------------------------------------------------------------

  describe("plugin API handlers", () => {
    const testWorkspacePath = "/home/user/.codehydra/workspaces/my-feature";

    /**
     * Helper: run the start hook to register handlers, then extract them from
     * the onApiCall mock. Returns the captured handlers and mock dispatcher.
     */
    async function setupPluginHandlers(
      resolveWith?: unknown,
      options?: { accepted?: boolean }
    ): Promise<{
      handlers: ApiCallHandlers;
      mockDispatch: ReturnType<typeof vi.fn>;
      deps: PluginServerModuleDeps;
    }> {
      const mockDispatch = vi.fn().mockImplementation(() => {
        const handle = new IntentHandle();
        handle.signalAccepted(options?.accepted ?? true);
        if (resolveWith instanceof Error) {
          handle.reject(resolveWith);
        } else {
          handle.resolve(resolveWith);
        }
        return handle;
      });

      const deps = createMockDeps({
        dispatcher: { dispatch: mockDispatch } as unknown as PluginServerModuleDeps["dispatcher"],
      });
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation("app:start", new MinimalStartOperation());

      // Dispatch app:start to trigger handler registration
      await dispatcher.dispatch({ type: "app:start", payload: {} });

      // Extract registered handlers
      const onApiCallMock = deps.pluginServer!.onApiCall as ReturnType<typeof vi.fn>;
      expect(onApiCallMock).toHaveBeenCalledTimes(1);
      const handlers = onApiCallMock.mock.calls[0]![0] as ApiCallHandlers;

      return { handlers, mockDispatch, deps };
    }

    it("registers handlers on app:start when pluginServer is available", async () => {
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation("app:start", new MinimalStartOperation());

      await dispatcher.dispatch({ type: "app:start", payload: {} });

      expect(deps.pluginServer!.onApiCall).toHaveBeenCalled();
    });

    it("getStatus dispatches correct intent", async () => {
      const status = { isDirty: false, unmergedCommits: 0, agent: { type: "none" as const } };
      const { handlers, mockDispatch } = await setupPluginHandlers(status);

      const result = await handlers.getStatus(testWorkspacePath);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(status);
      }
      expect(mockDispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: INTENT_GET_WORKSPACE_STATUS,
          payload: { workspacePath: testWorkspacePath },
        })
      );
    });

    it("getAgentSession dispatches correct intent", async () => {
      const session = { port: 12345, sessionId: "ses-123" };
      const { handlers, mockDispatch } = await setupPluginHandlers(session);

      const result = await handlers.getAgentSession(testWorkspacePath);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(session);
      }
      expect(mockDispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: INTENT_GET_AGENT_SESSION,
          payload: { workspacePath: testWorkspacePath },
        })
      );
    });

    it("restartAgentServer dispatches correct intent", async () => {
      const { handlers, mockDispatch } = await setupPluginHandlers(14001);

      const result = await handlers.restartAgentServer(testWorkspacePath);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(14001);
      }
      expect(mockDispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: INTENT_RESTART_AGENT,
          payload: { workspacePath: testWorkspacePath },
        })
      );
    });

    it("getMetadata dispatches correct intent", async () => {
      const { handlers, mockDispatch } = await setupPluginHandlers({ base: "main" });

      const result = await handlers.getMetadata(testWorkspacePath);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ base: "main" });
      }
      expect(mockDispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: INTENT_GET_METADATA,
          payload: { workspacePath: testWorkspacePath },
        })
      );
    });

    it("setMetadata dispatches correct intent", async () => {
      const { handlers, mockDispatch } = await setupPluginHandlers(undefined);

      const result = await handlers.setMetadata(testWorkspacePath, {
        key: "my-key",
        value: "my-value",
      });

      expect(result.success).toBe(true);
      expect(mockDispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: INTENT_SET_METADATA,
          payload: { workspacePath: testWorkspacePath, key: "my-key", value: "my-value" },
        })
      );
    });

    it("delete returns started:true when accepted", async () => {
      const { handlers, mockDispatch } = await setupPluginHandlers(undefined, { accepted: true });

      const result = await handlers.delete(testWorkspacePath, {});

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ started: true });
      }
      expect(mockDispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: INTENT_DELETE_WORKSPACE,
          payload: expect.objectContaining({
            workspacePath: testWorkspacePath,
            keepBranch: true,
            force: false,
            removeWorktree: true,
          }),
        })
      );
    });

    it("delete returns started:false when rejected by interceptor", async () => {
      const { handlers } = await setupPluginHandlers(undefined, { accepted: false });

      const result = await handlers.delete(testWorkspacePath, {});

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ started: false });
      }
    });

    it("executeCommand dispatches VscodeCommandIntent", async () => {
      const { handlers, mockDispatch } = await setupPluginHandlers("command result");

      const result = await handlers.executeCommand(testWorkspacePath, {
        command: "test.command",
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe("command result");
      }
      expect(mockDispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: INTENT_VSCODE_COMMAND,
          payload: expect.objectContaining({
            workspacePath: testWorkspacePath,
            command: "test.command",
          }),
        })
      );
    });

    it("create dispatches correct intent with optional fields", async () => {
      const workspace = {
        projectId: "proj-1",
        name: "my-ws",
        branch: "my-ws",
        metadata: {},
        path: "/workspaces/my-ws",
      };
      const resolvedProject = { projectPath: "/project/path", workspaceName: "caller-ws" };
      const { handlers, mockDispatch } = await setupPluginHandlers(workspace);
      // Mock: first dispatch (workspace:resolve) returns resolvedProject,
      // second dispatch (workspace:open) returns workspace
      mockDispatch.mockImplementation((intent: Intent) => {
        const handle = new IntentHandle();
        handle.signalAccepted(true);
        if (intent.type === INTENT_RESOLVE_WORKSPACE) {
          handle.resolve(resolvedProject);
        } else {
          handle.resolve(workspace);
        }
        return handle;
      });

      const result = await handlers.create(testWorkspacePath, {
        name: "my-ws",
        base: "main",
        initialPrompt: "Do something",
        stealFocus: false,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(workspace);
      }
      expect(mockDispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: INTENT_OPEN_WORKSPACE,
          payload: expect.objectContaining({
            projectPath: "/project/path",
            workspaceName: "my-ws",
            base: "main",
            initialPrompt: "Do something",
            stealFocus: false,
          }),
        })
      );
    });

    it("create does not include optional fields when undefined", async () => {
      const workspace = {
        projectId: "p",
        name: "ws",
        branch: "ws",
        metadata: {},
        path: "/ws",
      };
      const resolvedProject = { projectPath: "/project/path", workspaceName: "caller-ws" };
      const { handlers, mockDispatch } = await setupPluginHandlers(workspace);
      mockDispatch.mockImplementation((intent: Intent) => {
        const handle = new IntentHandle();
        handle.signalAccepted(true);
        if (intent.type === INTENT_RESOLVE_WORKSPACE) {
          handle.resolve(resolvedProject);
        } else {
          handle.resolve(workspace);
        }
        return handle;
      });

      await handlers.create(testWorkspacePath, { name: "my-ws", base: "main" });

      // Second call is workspace:open (first is workspace:resolve)
      const dispatchedIntent = mockDispatch.mock.calls[1]![0];
      expect(dispatchedIntent.payload).not.toHaveProperty("initialPrompt");
      expect(dispatchedIntent.payload).not.toHaveProperty("stealFocus");
    });

    it("returns error result when dispatch throws", async () => {
      const { handlers, mockDispatch } = await setupPluginHandlers();
      mockDispatch.mockImplementation(() => {
        const handle = new IntentHandle();
        handle.signalAccepted(true);
        handle.reject(new Error("Workspace not found"));
        return handle;
      });

      const result = await handlers.getStatus(testWorkspacePath);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("Workspace not found");
      }
    });
  });
});
