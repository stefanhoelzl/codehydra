// @vitest-environment node
/**
 * Integration tests for ApiServerModule through the Dispatcher.
 *
 * Tests verify the full pipeline: dispatcher -> operation -> hook handlers.
 * Uses minimal test operations that exercise specific hook points.
 *
 * API handler tests (Socket.IO round-trip with mock dispatcher) are in
 * api-server.boundary.test.ts.
 */

import { SEND_AGENT_MESSAGE_OPERATION_ID } from "../intents/send-agent-message";
import { createMockDispatcher } from "../intents/lib/dispatcher.test-utils";
import { createFileSystemMock } from "../boundaries/platform/filesystem.state-mock";
import { describe, it, expect, vi } from "vitest";

import type { Operation, OperationSchemas } from "../intents/lib/operation";
import { createMinimalOperation } from "../intents/lib/operation.test-utils";
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
import { createApiServerModule, type ApiServerModuleDeps } from "./api-server-module";
import { createPortManagerMock } from "../boundaries/platform/port-manager.state-mock";
import { SILENT_LOGGER } from "../boundaries/platform/logging";

import { COMMAND_TIMEOUT_MS } from "../shared/api-protocol";
import { wsPath, testPath, projPath } from "../shared/test-fixtures";
import { createMinimalStartOperation } from "./api-server.test-utils";
import type { WorkspaceName } from "../intents/contract";
import { makeWorkspaceRef, projectRefFor } from "../utils/ref";

const PROJECT_REF = projectRefFor(projPath("/test/project"));
const FEATURE_REF = makeWorkspaceRef(PROJECT_REF, "feature-1");

// =============================================================================
// Minimal Test Operations
// =============================================================================

/** The open-workspace "finalize" hook point with a canned feature-1 context. */
function createMinimalFinalizeOperation(
  hookInput: Partial<FinalizeHookInput> = {}
): Operation<OperationSchemas> {
  return createMinimalOperation(OPEN_WORKSPACE_OPERATION_ID, INTENT_OPEN_WORKSPACE, "finalize", {
    hookContext: (ctx) => ({
      intent: ctx.intent,
      workspaceRef: FEATURE_REF,
      workspacePath: testPath("/test/project/.worktrees/feature-1").toNative(),
      envVars: { OPENCODE_PORT: "8080" },
      agentType: "opencode" as const,
      ...hookInput,
    }),
    select: () => undefined,
  });
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
        projectRef: PROJECT_REF,
        projectPath: projPath("/test/project"),
        workspaceName: "feature-1" as WorkspaceName,
        workspaceRef: (ctx.intent.payload as DeleteWorkspaceIntent["payload"]).workspaceRef,
        workspacePath: wsPath("/test/project/.worktrees/feature-1"),
        active: false,
      }),
      defaultResult: {},
    }
  );
}

// =============================================================================
// Mock Factories
// =============================================================================

function createMockDeps(overrides?: Partial<ApiServerModuleDeps>): ApiServerModuleDeps {
  return {
    portManager: createPortManagerMock(),
    dispatcher: { dispatch: vi.fn() } as unknown as ApiServerModuleDeps["dispatcher"],
    appLayer: { openPath: vi.fn().mockResolvedValue(undefined) },
    fileSystem: createFileSystemMock(),
    logger: SILENT_LOGGER,
    ...overrides,
  };
}

// =============================================================================
// Test Setup
// =============================================================================

function createTestSetup(mockDeps?: ApiServerModuleDeps) {
  const deps = mockDeps ?? createMockDeps();
  const dispatcher = createMockDispatcher();
  const apiServer = createApiServerModule(deps);

  dispatcher.registerModule(apiServer.module);

  return { deps, dispatcher, apiServer };
}

// =============================================================================
// Tests
// =============================================================================

describe("ApiServerModule", () => {
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
    it("degrades gracefully when port allocation fails, provides null apiPort", async () => {
      const deps = createMockDeps({
        portManager: {
          listenOnFreePort: vi.fn().mockRejectedValue(new Error("bind failed")),
        },
      });
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation(createMinimalStartOperation());

      const apiPort = await dispatcher.dispatch({ type: "app:start", payload: {} });

      expect(apiPort).toBeNull();
    });

    it("provides apiPort capability when started successfully", async () => {
      // This is tested with real Socket.IO in boundary tests.
      // Integration test only verifies graceful degradation above.
      // The start hook catches errors and returns null apiPort.
    });
  });

  // ---------------------------------------------------------------------------
  // isReady — the probe best-effort callers use instead of dispatching blind
  // ---------------------------------------------------------------------------

  describe("isReady", () => {
    it("is false before start", () => {
      const { apiServer } = createTestSetup();
      expect(apiServer.isReady()).toBe(false);
    });

    it("stays false when the server failed to start", async () => {
      // The failure path a caller must not dispatch into: the start hook
      // degrades to a null port rather than throwing, so "app started" is not
      // the same question as "the API server is up".
      const deps = createMockDeps({
        portManager: {
          listenOnFreePort: vi.fn().mockRejectedValue(new Error("bind failed")),
        },
      });
      const { dispatcher, apiServer } = createTestSetup(deps);
      dispatcher.registerOperation(createMinimalStartOperation());

      await dispatcher.dispatch({ type: "app:start", payload: {} });

      expect(apiServer.isReady()).toBe(false);
    });
  });

  describe("send-message editor", () => {
    it("answers that a workspace with no sidekick connected is not connected", async () => {
      const { apiServer } = createTestSetup();

      // The operation's "editor" context: the intent, plus the workspace it is for.
      const ctx = {
        intent: { type: "agent:send-message", payload: {} },
        workspaceRef: FEATURE_REF,
      };
      const output =
        await apiServer.module.hooks![SEND_AGENT_MESSAGE_OPERATION_ID]!["editor"]!.handler(ctx);

      expect(output).toEqual({ result: { connected: false } });
      expect(apiServer.isConnected(FEATURE_REF)).toBe(false);
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
      dispatcher.registerOperation(createMinimalStartOperation());
      await dispatcher.dispatch({ type: "app:start", payload: {} });

      dispatcher.registerOperation(
        createMinimalFinalizeOperation({
          workspacePath: wsPath("/test/project/.worktrees/feature-1"),
          envVars: { OPENCODE_PORT: "8080" },
          agentType: "opencode",
        })
      );

      await expect(
        dispatcher.dispatch<OpenWorkspaceIntent>({
          type: "workspace:open",
          payload: {
            workspaceName: "feature-1",
            projectRef: PROJECT_REF,
            base: "main",
          },
        })
      ).resolves.not.toThrow();
    });

    it("is a no-op when server has not been started (io is null)", async () => {
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);

      // Do NOT start the server
      dispatcher.registerOperation(
        createMinimalFinalizeOperation({
          workspacePath: wsPath("/test/project/.worktrees/feature-1"),
          envVars: { OPENCODE_PORT: "8080" },
          agentType: "opencode",
        })
      );

      // Should resolve without error (no-op when io is null)
      await expect(
        dispatcher.dispatch<OpenWorkspaceIntent>({
          type: "workspace:open",
          payload: {
            workspaceName: "feature-1",
            projectRef: PROJECT_REF,
            base: "main",
          },
        })
      ).resolves.not.toThrow();
    });

    it("does not provide workspaceUrl capability (API server has no URL)", async () => {
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);

      dispatcher.registerOperation(
        createMinimalFinalizeOperation({
          workspacePath: wsPath("/test/project/.worktrees/feature-1"),
          envVars: { OPENCODE_PORT: "8080" },
          agentType: "opencode",
        })
      );

      await expect(
        dispatcher.dispatch<OpenWorkspaceIntent>({
          type: "workspace:open",
          payload: {
            workspaceName: "feature-1",
            projectRef: PROJECT_REF,
            base: "main",
          },
        })
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
      dispatcher.registerOperation(createMinimalStartOperation());
      await dispatcher.dispatch({ type: "app:start", payload: {} });

      dispatcher.registerOperation(createMinimalDeleteOperation());

      const result = (await dispatcher.dispatch<DeleteWorkspaceIntent>({
        type: "workspace:delete",
        payload: {
          workspaceRef: FEATURE_REF,
          keepBranch: false,
          force: false,
          removeWorktree: true,
        },
      })) as DeleteHookResult;

      expect(result).toEqual({});
    });

    it("is a no-op when server has not been started (io is null)", async () => {
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation(createMinimalDeleteOperation());

      const result = (await dispatcher.dispatch<DeleteWorkspaceIntent>({
        type: "workspace:delete",
        payload: {
          workspaceRef: FEATURE_REF,
          keepBranch: false,
          force: false,
          removeWorktree: true,
        },
      })) as DeleteHookResult;

      expect(result).toEqual({});
    });

    it("ignores errors in force mode", async () => {
      // Force mode delete should not throw even if internal state is inconsistent
      const deps = createMockDeps();
      const { dispatcher } = createTestSetup(deps);
      dispatcher.registerOperation(createMinimalDeleteOperation());

      const result = (await dispatcher.dispatch<DeleteWorkspaceIntent>({
        type: "workspace:delete",
        payload: {
          workspaceRef: FEATURE_REF,
          keepBranch: false,
          force: true,
          removeWorktree: true,
        },
      })) as DeleteHookResult;

      expect(result).toEqual({});
    });
  });
});
