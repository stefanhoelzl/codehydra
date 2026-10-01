// @vitest-environment node
/**
 * Integration tests for resolve-project operation through the Dispatcher.
 *
 * Tests verify the full dispatch pipeline: intent -> operation -> hooks -> result.
 *
 * Test plan items covered:
 * #1: resolves projectRef → projectId + projectPath + projectName
 * #2: throws when no handler returns projectId
 * #3: defaults projectName to empty string when not provided
 * #4: propagates hook handler errors
 */

import { createMockDispatcher } from "./lib/dispatcher.test-utils";
import { describe, it, expect } from "vitest";
import { Dispatcher } from "./lib/dispatcher";

import {
  ResolveProjectOperation,
  RESOLVE_PROJECT_OPERATION_ID,
  INTENT_RESOLVE_PROJECT,
} from "./resolve-project";
import type { ResolveProjectIntent, ResolveHookResult } from "./resolve-project";
import type { IntentModule } from "./lib/module";
import type { HookContext, HookOutput } from "./lib/operation";
import type { ProjectId } from "../shared/api/types";
import { projPath } from "../shared/test-fixtures";
import type { ProjectRef } from "./contract";
import { projectRefFor } from "../utils/ref";

// =============================================================================
// Test Constants
// =============================================================================

const PROJECT_PATH = projPath("/projects/my-app");
const PROJECT_REF = projectRefFor(PROJECT_PATH);
const PROJECT_ID = "my-app-12345678" as ProjectId;
const PROJECT_NAME = "my-app";

// =============================================================================
// Test Setup
// =============================================================================

function createTestSetup(
  resolveHandler?: (ctx: HookContext) => Promise<HookOutput<ResolveHookResult>>
): {
  dispatcher: Dispatcher;
} {
  const dispatcher = createMockDispatcher();

  dispatcher.registerOperation(new ResolveProjectOperation());

  if (resolveHandler) {
    const module: IntentModule = {
      name: "test",
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

function resolveIntent(projectRef: ProjectRef): ResolveProjectIntent {
  return {
    type: INTENT_RESOLVE_PROJECT,
    payload: { projectRef },
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("ResolveProjectOperation Integration", () => {
  describe("success", () => {
    it("resolves projectRef to projectId + projectPath + projectName (#1)", async () => {
      const { dispatcher } = createTestSetup(async (): Promise<HookOutput<ResolveHookResult>> => ({
        result: {
          projectId: PROJECT_ID,
          projectPath: PROJECT_PATH,
          projectName: PROJECT_NAME,
        },
      }));

      const result = await dispatcher.dispatch(resolveIntent(PROJECT_REF));

      expect(result).toEqual({
        projectId: PROJECT_ID,
        projectRef: PROJECT_REF,
        projectPath: PROJECT_PATH,
        projectName: PROJECT_NAME,
      });
    });

    it("defaults projectName to empty string when not provided (#3)", async () => {
      const { dispatcher } = createTestSetup(async (): Promise<HookOutput<ResolveHookResult>> => ({
        result: {
          projectId: PROJECT_ID,
          projectPath: PROJECT_PATH,
        },
      }));

      const result = await dispatcher.dispatch(resolveIntent(PROJECT_REF));

      expect(result).toEqual({
        projectId: PROJECT_ID,
        projectRef: PROJECT_REF,
        projectPath: PROJECT_PATH,
        projectName: "",
      });
    });
  });

  describe("failure", () => {
    it("throws when no handler returns projectId (#2)", async () => {
      const { dispatcher } = createTestSetup(async (): Promise<HookOutput<ResolveHookResult>> => ({
        result: {
          projectName: PROJECT_NAME,
        },
      }));

      await expect(dispatcher.dispatch(resolveIntent(PROJECT_REF))).rejects.toThrow(
        `Project not found: ${PROJECT_REF}`
      );
    });

    it("throws when no handler is registered", async () => {
      const { dispatcher } = createTestSetup();

      await expect(dispatcher.dispatch(resolveIntent(PROJECT_REF))).rejects.toThrow(
        `Project not found: ${PROJECT_REF}`
      );
    });

    it("propagates hook handler errors (#4)", async () => {
      const { dispatcher } = createTestSetup(async () => {
        throw new Error("storage error");
      });

      await expect(dispatcher.dispatch(resolveIntent(PROJECT_REF))).rejects.toThrow(
        "storage error"
      );
    });
  });
});
