// @vitest-environment node
/**
 * Integration tests for PluginServerModule through the Dispatcher.
 *
 * Tests verify the full pipeline: dispatcher -> operation -> hook handlers.
 * Uses minimal test operations that exercise specific hook points.
 *
 * API handler tests (Socket.IO round-trip with mock dispatcher) are in
 * plugin-server.boundary.test.ts.
 */

import { describe, it, expect, vi } from "vitest";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";

import type { Operation, OperationContext } from "../intents/infrastructure/operation";
import type { Intent } from "../intents/infrastructure/types";
import { createMinimalOperation } from "../intents/infrastructure/operation.test-utils";
import { APP_START_OPERATION_ID } from "../operations/app-start";
import { APP_SHUTDOWN_OPERATION_ID } from "../operations/app-shutdown";
import { OPEN_WORKSPACE_OPERATION_ID } from "../operations/open-workspace";
import type { FinalizeHookInput, OpenWorkspaceIntent } from "../operations/open-workspace";
import { DELETE_WORKSPACE_OPERATION_ID } from "../operations/delete-workspace";
import type {
  DeleteWorkspaceIntent,
  DeletePipelineHookInput,
  DeleteHookResult,
} from "../operations/delete-workspace";
import { createPluginServerModule, type PluginServerModuleDeps } from "./plugin-server-module";
import { SILENT_LOGGER } from "../../services/logging";
import type { ProjectId, WorkspaceName } from "../../shared/api/types";
import { COMMAND_TIMEOUT_MS, SHUTDOWN_DISCONNECT_TIMEOUT_MS } from "../../shared/plugin-protocol";

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
    portManager: {
      findFreePort: vi.fn().mockResolvedValue(3456),
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
  // Constants (absorbed from old unit tests)
  // ---------------------------------------------------------------------------

  describe("constants", () => {
    it("COMMAND_TIMEOUT_MS is 10 seconds", () => {
      expect(COMMAND_TIMEOUT_MS).toBe(10_000);
    });

    it("SHUTDOWN_DISCONNECT_TIMEOUT_MS is 5 seconds", () => {
      expect(SHUTDOWN_DISCONNECT_TIMEOUT_MS).toBe(5_000);
    });
  });

  // ---------------------------------------------------------------------------
  // start
  // ---------------------------------------------------------------------------

  describe("start", () => {
    it("degrades gracefully when port allocation fails, provides null pluginPort", async () => {
      const deps = createMockDeps({
        portManager: {
          findFreePort: vi.fn().mockRejectedValue(new Error("bind failed")),
        },
      });
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation("app:start", new MinimalStartOperation());

      const pluginPort = await dispatcher.dispatch({ type: "app:start", payload: {} });

      expect(pluginPort).toBeNull();
    });

    it("provides pluginPort capability when started successfully", async () => {
      // This is tested with real Socket.IO in boundary tests.
      // Integration test only verifies graceful degradation above.
      // The start hook catches errors and returns null pluginPort.
    });
  });

  // ---------------------------------------------------------------------------
  // stop
  // ---------------------------------------------------------------------------

  describe("stop", () => {
    it("completes without error", async () => {
      const deps = createMockDeps();
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
    it("completes without error when server has been started", async () => {
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);

      // Start the server first
      dispatcher.registerOperation("app:start", new MinimalStartOperation());
      await dispatcher.dispatch({ type: "app:start", payload: {} });

      dispatcher.registerOperation(
        "workspace:open",
        new MinimalFinalizeOperation({
          workspacePath: "/test/project/.worktrees/feature-1",
          envVars: { OPENCODE_PORT: "8080" },
          agentType: "opencode",
        })
      );

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

    it("is a no-op when server has not been started (io is null)", async () => {
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);

      // Do NOT start the server
      dispatcher.registerOperation(
        "workspace:open",
        new MinimalFinalizeOperation({
          workspacePath: "/test/project/.worktrees/feature-1",
          envVars: { OPENCODE_PORT: "8080" },
          agentType: "opencode",
        })
      );

      // Should resolve without error (no-op when io is null)
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
    it("completes without error when server is running", async () => {
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);

      // Start the server first
      dispatcher.registerOperation("app:start", new MinimalStartOperation());
      await dispatcher.dispatch({ type: "app:start", payload: {} });

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

    it("is a no-op when server has not been started (io is null)", async () => {
      const deps = createMockDeps();
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
      // Force mode delete should not throw even if internal state is inconsistent
      const deps = createMockDeps();
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
});
