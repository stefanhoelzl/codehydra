// @vitest-environment node
/**
 * Integration tests for resolve-project operation through the Dispatcher.
 *
 * Tests verify the full dispatch pipeline: intent -> operation -> hooks -> result.
 *
 * Test plan items covered:
 * #1: resolves projectPath → projectId + projectName
 * #2: throws when no handler returns projectId
 * #3: defaults projectName to empty string when not provided
 * #4: propagates hook handler errors
 */

import { describe, it, expect } from "vitest";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";

import {
  ResolveProjectOperation,
  RESOLVE_PROJECT_OPERATION_ID,
  INTENT_RESOLVE_PROJECT,
} from "./resolve-project";
import type { ResolveProjectIntent, ResolveHookResult } from "./resolve-project";
import type { IntentModule } from "../intents/infrastructure/module";
import type { HookContext } from "../intents/infrastructure/operation";
import type { ProjectId } from "../../shared/api/types";

// =============================================================================
// Test Constants
// =============================================================================

const PROJECT_PATH = "/projects/my-app";
const PROJECT_ID = "my-app-12345678" as ProjectId;
const PROJECT_NAME = "my-app";

// =============================================================================
// Test Setup
// =============================================================================

function createTestSetup(resolveHandler?: (ctx: HookContext) => Promise<ResolveHookResult>): {
  dispatcher: Dispatcher;
} {
  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);

  dispatcher.registerOperation(INTENT_RESOLVE_PROJECT, new ResolveProjectOperation());

  if (resolveHandler) {
    const module: IntentModule = {
      hooks: {
        [RESOLVE_PROJECT_OPERATION_ID]: {
          resolve: { handler: resolveHandler },
        },
      },
    };
    dispatcher.registerModule(module);
  }

  return { dispatcher };
}

function resolveIntent(projectPath: string): ResolveProjectIntent {
  return {
    type: INTENT_RESOLVE_PROJECT,
    payload: { projectPath },
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("ResolveProjectOperation Integration", () => {
  describe("success", () => {
    it("resolves projectPath to projectId + projectName (#1)", async () => {
      const { dispatcher } = createTestSetup(
        async (): Promise<ResolveHookResult> => ({
          projectId: PROJECT_ID,
          projectName: PROJECT_NAME,
        })
      );

      const result = await dispatcher.dispatch(resolveIntent(PROJECT_PATH));

      expect(result).toEqual({
        projectId: PROJECT_ID,
        projectName: PROJECT_NAME,
      });
    });

    it("defaults projectName to empty string when not provided (#3)", async () => {
      const { dispatcher } = createTestSetup(
        async (): Promise<ResolveHookResult> => ({
          projectId: PROJECT_ID,
        })
      );

      const result = await dispatcher.dispatch(resolveIntent(PROJECT_PATH));

      expect(result).toEqual({
        projectId: PROJECT_ID,
        projectName: "",
      });
    });
  });

  describe("failure", () => {
    it("throws when no handler returns projectId (#2)", async () => {
      const { dispatcher } = createTestSetup(
        async (): Promise<ResolveHookResult> => ({
          projectName: PROJECT_NAME,
        })
      );

      await expect(dispatcher.dispatch(resolveIntent(PROJECT_PATH))).rejects.toThrow(
        `Project not found for path: ${PROJECT_PATH}`
      );
    });

    it("throws when no handler is registered", async () => {
      const { dispatcher } = createTestSetup();

      await expect(dispatcher.dispatch(resolveIntent(PROJECT_PATH))).rejects.toThrow(
        `Project not found for path: ${PROJECT_PATH}`
      );
    });

    it("propagates hook handler errors (#4)", async () => {
      const { dispatcher } = createTestSetup(async () => {
        throw new Error("storage error");
      });

      await expect(dispatcher.dispatch(resolveIntent(PROJECT_PATH))).rejects.toThrow(
        "storage error"
      );
    });
  });
});
