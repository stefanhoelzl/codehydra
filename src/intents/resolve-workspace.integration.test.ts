// @vitest-environment node
/**
 * Integration tests for resolve-workspace operation through the Dispatcher.
 *
 * Tests verify the full dispatch pipeline: intent -> operation -> hooks -> result.
 *
 * Test plan items covered:
 * #1: resolves workspacePath → projectPath + workspaceName
 * #2: throws when no handler returns projectPath
 * #3: throws when no handler returns workspaceName
 * #4: propagates hook handler errors
 */

import { createMockDispatcher } from "./lib/dispatcher.test-utils";
import { describe, it, expect } from "vitest";
import { Dispatcher } from "./lib/dispatcher";

import {
  ResolveWorkspaceOperation,
  RESOLVE_WORKSPACE_OPERATION_ID,
  INTENT_RESOLVE_WORKSPACE,
} from "./resolve-workspace";
import type { ResolveWorkspaceIntent, ResolveHookResult } from "./resolve-workspace";
import type { IntentModule } from "./lib/module";
import type { HookContext, HookOutput } from "./lib/operation";
import type { WorkspaceName } from "../shared/api/types";

// =============================================================================
// Test Constants
// =============================================================================

const PROJECT_PATH = "/projects/my-app";
const WORKSPACE_PATH = "/workspaces/feature-x";
const WORKSPACE_NAME = "feature-x" as WorkspaceName;

// =============================================================================
// Test Setup
// =============================================================================

function createTestSetup(
  resolveHandler?: (ctx: HookContext) => Promise<HookOutput<ResolveHookResult>>
): {
  dispatcher: Dispatcher;
} {
  const dispatcher = createMockDispatcher();

  dispatcher.registerOperation(new ResolveWorkspaceOperation());

  if (resolveHandler) {
    const module: IntentModule = {
      name: "test",
      hooks: {
        [RESOLVE_WORKSPACE_OPERATION_ID]: {
          resolve: { handler: resolveHandler },
        },
      },
    };
    dispatcher.registerModule(module);
  }

  return { dispatcher };
}

function resolveIntent(workspacePath: string): ResolveWorkspaceIntent {
  return {
    type: INTENT_RESOLVE_WORKSPACE,
    payload: { workspacePath },
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("ResolveWorkspaceOperation Integration", () => {
  describe("success", () => {
    it("resolves workspacePath to projectPath + workspaceName (#1)", async () => {
      const { dispatcher } = createTestSetup(
        async (): Promise<HookOutput<ResolveHookResult>> => ({
          result: {
            projectPath: PROJECT_PATH,
            workspaceName: WORKSPACE_NAME,
          },
        })
      );

      const result = await dispatcher.dispatch(resolveIntent(WORKSPACE_PATH));

      expect(result).toEqual({
        projectPath: PROJECT_PATH,
        workspaceName: WORKSPACE_NAME,
        active: false,
        // Defaults to null when no handler provides a branch.
        branch: null,
      });
    });

    it("returns the branch when a handler provides it", async () => {
      const { dispatcher } = createTestSetup(
        async (): Promise<HookOutput<ResolveHookResult>> => ({
          result: {
            projectPath: PROJECT_PATH,
            workspaceName: WORKSPACE_NAME,
            branch: "feature-x",
          },
        })
      );

      const result = await dispatcher.dispatch(resolveIntent(WORKSPACE_PATH));

      expect(result.branch).toBe("feature-x");
    });
  });

  describe("failure", () => {
    it("throws when no handler returns projectPath (#2)", async () => {
      const { dispatcher } = createTestSetup(
        async (): Promise<HookOutput<ResolveHookResult>> => ({
          result: {
            workspaceName: WORKSPACE_NAME,
          },
        })
      );

      await expect(dispatcher.dispatch(resolveIntent(WORKSPACE_PATH))).rejects.toThrow(
        `Workspace not found: ${WORKSPACE_PATH}`
      );
    });

    it("throws when no handler returns workspaceName (#3)", async () => {
      const { dispatcher } = createTestSetup(
        async (): Promise<HookOutput<ResolveHookResult>> => ({
          result: {
            projectPath: PROJECT_PATH,
          },
        })
      );

      await expect(dispatcher.dispatch(resolveIntent(WORKSPACE_PATH))).rejects.toThrow(
        `Workspace not found: ${WORKSPACE_PATH}`
      );
    });

    it("throws when no handler is registered", async () => {
      const { dispatcher } = createTestSetup();

      await expect(dispatcher.dispatch(resolveIntent(WORKSPACE_PATH))).rejects.toThrow(
        `Workspace not found: ${WORKSPACE_PATH}`
      );
    });

    it("propagates hook handler errors (#4)", async () => {
      const { dispatcher } = createTestSetup(async () => {
        throw new Error("provider error");
      });

      await expect(dispatcher.dispatch(resolveIntent(WORKSPACE_PATH))).rejects.toThrow(
        "provider error"
      );
    });
  });
});
