// @vitest-environment node
/**
 * Integration tests for resolve-workspace operation through the Dispatcher.
 *
 * Tests verify the full dispatch pipeline: intent -> operation -> hooks -> result.
 *
 * Test plan items covered:
 * #1: resolves a ref or a path to the workspace's identity
 * #2: throws when no handler identifies the workspace completely
 * #3: adds what "state" handlers know about the identified workspace
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
import type {
  ResolveWorkspaceIntent,
  ResolveHookResult,
  StateHookInput,
  StateHookResult,
} from "./resolve-workspace";
import type { IntentModule } from "./lib/module";
import type { HookContext, HookOutput } from "./lib/operation";
import type { WorkspaceName } from "../shared/api/types";
import { wsPath, projPath } from "../shared/test-fixtures";
import { makeWorkspaceRef, projectRefFor } from "../utils/ref";

// =============================================================================
// Test Constants
// =============================================================================

const PROJECT_PATH = projPath("/projects/my-app");
const PROJECT_REF = projectRefFor(PROJECT_PATH);
const WORKSPACE_PATH = wsPath("/workspaces/feature-x");
const WORKSPACE_NAME = "feature-x" as WorkspaceName;
const WORKSPACE_REF = makeWorkspaceRef(PROJECT_REF, WORKSPACE_NAME);

const IDENTITY = {
  workspaceRef: WORKSPACE_REF,
  workspacePath: WORKSPACE_PATH,
  projectRef: PROJECT_REF,
  projectPath: PROJECT_PATH,
  workspaceName: WORKSPACE_NAME,
  branch: "feature-x",
  metadata: { title: "Fix login bug" },
} satisfies ResolveHookResult;

// =============================================================================
// Test Setup
// =============================================================================

function createTestSetup(
  resolveHandler?: (ctx: HookContext) => Promise<HookOutput<ResolveHookResult>>,
  stateHandler?: (ctx: HookContext) => Promise<HookOutput<StateHookResult>>
): {
  dispatcher: Dispatcher;
} {
  const dispatcher = createMockDispatcher();

  dispatcher.registerOperation(new ResolveWorkspaceOperation());

  const module: IntentModule = {
    name: "test",
    hooks: {
      [RESOLVE_WORKSPACE_OPERATION_ID]: {
        ...(resolveHandler && { resolve: { handler: resolveHandler } }),
        ...(stateHandler && { state: { handler: stateHandler } }),
      },
    },
  };
  dispatcher.registerModule(module);

  return { dispatcher };
}

function byPath(): ResolveWorkspaceIntent {
  return { type: INTENT_RESOLVE_WORKSPACE, payload: { workspacePath: WORKSPACE_PATH } };
}

function byRef(): ResolveWorkspaceIntent {
  return { type: INTENT_RESOLVE_WORKSPACE, payload: { workspaceRef: WORKSPACE_REF } };
}

// =============================================================================
// Tests
// =============================================================================

describe("ResolveWorkspaceOperation Integration", () => {
  describe("success", () => {
    it.each([
      ["a ref", byRef],
      ["a path", byPath],
    ])("resolves %s to the workspace's identity (#1)", async (_label, intent) => {
      const { dispatcher } = createTestSetup(async () => ({ result: IDENTITY }));

      const result = await dispatcher.dispatch(intent());

      expect(result).toEqual({
        ...IDENTITY,
        active: false,
        // Defaults to null when no teardown pipeline owns the workspace.
        closing: null,
      });
    });

    it("adds what state handlers know, with the identity resolved (#3)", async () => {
      let seen: StateHookInput | undefined;
      const { dispatcher } = createTestSetup(
        async () => ({ result: IDENTITY }),
        async (ctx) => {
          seen = ctx as StateHookInput;
          return { result: { active: true, closing: "delete" } };
        }
      );

      const result = await dispatcher.dispatch(byRef());

      expect(seen).toMatchObject({ workspaceRef: WORKSPACE_REF, workspacePath: WORKSPACE_PATH });
      expect(result.active).toBe(true);
      expect(result.closing).toBe("delete");
    });
  });

  describe("failure", () => {
    it("throws when no handler identifies the workspace completely (#2)", async () => {
      const { dispatcher } = createTestSetup(async () => ({
        result: { projectPath: PROJECT_PATH, workspaceName: WORKSPACE_NAME },
      }));

      await expect(dispatcher.dispatch(byPath())).rejects.toThrow(
        `Workspace not found: ${WORKSPACE_PATH}`
      );
    });

    it("throws when no handler is registered", async () => {
      const { dispatcher } = createTestSetup();

      await expect(dispatcher.dispatch(byRef())).rejects.toThrow(
        `Workspace not found: ${WORKSPACE_REF}`
      );
    });

    // Coded so callers can distinguish "that workspace doesn't exist" from a
    // genuine failure — the MCP tools turn this into `workspace-not-found`.
    it("codes the not-found error as WORKSPACE_NOT_FOUND", async () => {
      const { dispatcher } = createTestSetup();

      await expect(dispatcher.dispatch(byPath())).rejects.toMatchObject({
        code: "WORKSPACE_NOT_FOUND",
      });
    });

    it("rejects a payload with neither a ref nor a path", async () => {
      const { dispatcher } = createTestSetup(async () => ({ result: IDENTITY }));

      await expect(
        dispatcher.dispatch({ type: INTENT_RESOLVE_WORKSPACE, payload: {} })
      ).rejects.toThrow(/exactly one of workspaceRef and workspacePath/);
    });

    it("propagates hook handler errors (#4)", async () => {
      const { dispatcher } = createTestSetup(async () => {
        throw new Error("provider error");
      });

      await expect(dispatcher.dispatch(byPath())).rejects.toThrow("provider error");
    });
  });
});
