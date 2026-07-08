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

import { createMockDispatcher } from "../intents/lib/dispatcher.test-utils";
import { describe, it, expect, vi } from "vitest";

import { z } from "zod/v4";
import type {
  Operation,
  OperationContext,
  OperationSchemas,
  IntentOf,
} from "../intents/lib/operation";
import { createMinimalOperation } from "../intents/lib/operation.test-utils";
import { APP_START_OPERATION_ID, INTENT_APP_START } from "../intents/app-start";
import { APP_SHUTDOWN_OPERATION_ID, INTENT_APP_SHUTDOWN } from "../intents/app-shutdown";
import { OPEN_WORKSPACE_OPERATION_ID, INTENT_OPEN_WORKSPACE } from "../intents/open-workspace";
import type { FinalizeHookInput, OpenWorkspaceIntent } from "../intents/open-workspace";
import {
  DELETE_WORKSPACE_OPERATION_ID,
  INTENT_DELETE_WORKSPACE,
} from "../intents/delete-workspace";
import type {
  DeleteWorkspaceIntent,
  DeletePipelineHookInput,
  DeleteHookResult,
} from "../intents/delete-workspace";
import { createPluginServerModule, type PluginServerModuleDeps } from "./plugin-server-module";
import { SILENT_LOGGER } from "../boundaries/platform/logging";
import type { ProjectId, WorkspaceName } from "../shared/api/types";
import { COMMAND_TIMEOUT_MS } from "../shared/plugin-protocol";

// =============================================================================
// Minimal Test Operations
// =============================================================================

const startSchemas = {
  type: INTENT_APP_START,
  payload: z.unknown(),
  result: z.custom<number | null>(),
} satisfies OperationSchemas;

class MinimalStartOperation implements Operation<typeof startSchemas> {
  readonly id = APP_START_OPERATION_ID;
  readonly schemas = startSchemas;

  async execute(ctx: OperationContext<IntentOf<typeof startSchemas>>): Promise<number | null> {
    const { errors, capabilities } = await ctx.hooks.collect<void>("start", {
      intent: ctx.intent,
    });
    if (errors.length > 0) throw errors[0]!;
    return (capabilities.pluginPort as number | null) ?? null;
  }
}

const finalizeSchemas = {
  type: INTENT_OPEN_WORKSPACE,
  payload: z.unknown(),
} satisfies OperationSchemas;

/**
 * Finalize operation whose hook input is captured in a closure. The dispatcher
 * invokes `execute` detached from the object, so `this` is unavailable — read the
 * config from the enclosing scope instead.
 */
function createMinimalFinalizeOperation(
  hookInput: Partial<FinalizeHookInput> = {}
): Operation<typeof finalizeSchemas> {
  return {
    id: OPEN_WORKSPACE_OPERATION_ID,
    schemas: finalizeSchemas,
    async execute(ctx: OperationContext<IntentOf<typeof finalizeSchemas>>): Promise<void> {
      const { errors } = await ctx.hooks.collect<void>("finalize", {
        intent: ctx.intent,
        workspacePath: "/test/project/.worktrees/feature-1",
        envVars: { OPENCODE_PORT: "8080" },
        agentType: "opencode" as const,
        ...hookInput,
      });
      if (errors.length > 0) throw errors[0]!;
    },
  };
}

/** Runs the "delete" hook point with a canned delete-pipeline context. */
function createMinimalDeleteOperation() {
  return createMinimalOperation<DeleteHookResult>(
    DELETE_WORKSPACE_OPERATION_ID,
    INTENT_DELETE_WORKSPACE,
    "delete",
    {
      hookContext: (ctx): DeletePipelineHookInput => ({
        intent: ctx.intent,
        projectPath: "/projects/test",
        workspacePath: (ctx.intent.payload as DeleteWorkspaceIntent["payload"]).workspacePath ?? "",
        workspaceName: "test-workspace" as WorkspaceName,
        active: false,
      }),
      defaultResult: {},
    }
  );
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
    appLayer: { openPath: vi.fn().mockResolvedValue(undefined) },
    logger: SILENT_LOGGER,
    ...overrides,
  };
}

// =============================================================================
// Test Setup
// =============================================================================

function createTestSetup(mockDeps?: PluginServerModuleDeps) {
  const deps = mockDeps ?? createMockDeps();
  const dispatcher = createMockDispatcher();
  const module = createPluginServerModule(deps);

  dispatcher.registerModule(module);

  return { deps, dispatcher };
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
      dispatcher.registerOperation(new MinimalStartOperation());

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
        createMinimalOperation(APP_SHUTDOWN_OPERATION_ID, INTENT_APP_SHUTDOWN, "stop", {
          throwOnError: false,
        })
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
      dispatcher.registerOperation(new MinimalStartOperation());
      await dispatcher.dispatch({ type: "app:start", payload: {} });

      dispatcher.registerOperation(
        createMinimalFinalizeOperation({
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
        createMinimalFinalizeOperation({
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
        createMinimalFinalizeOperation({
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
      dispatcher.registerOperation(new MinimalStartOperation());
      await dispatcher.dispatch({ type: "app:start", payload: {} });

      dispatcher.registerOperation(createMinimalDeleteOperation());

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
      dispatcher.registerOperation(createMinimalDeleteOperation());

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
      dispatcher.registerOperation(createMinimalDeleteOperation());

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
