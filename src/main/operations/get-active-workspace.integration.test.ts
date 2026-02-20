// @vitest-environment node
/**
 * Integration tests for get-active-workspace operation through the Dispatcher.
 *
 * Tests verify the full dispatch pipeline: intent -> operation -> hook -> result,
 * using a cached WorkspaceRef (event-driven pattern).
 *
 * Test plan items covered:
 * #10: get-active-workspace returns ref when cached
 * #11: get-active-workspace returns null when no cached ref
 * #14: interceptor cancellation prevents operation execution
 */

import { describe, it, expect, beforeEach } from "vitest";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";
import type { IntentInterceptor } from "../intents/infrastructure/dispatcher";

import {
  GetActiveWorkspaceOperation,
  GET_ACTIVE_WORKSPACE_OPERATION_ID,
  INTENT_GET_ACTIVE_WORKSPACE,
} from "./get-active-workspace";
import type {
  GetActiveWorkspaceIntent,
  GetActiveWorkspaceHookResult,
} from "./get-active-workspace";
import type { IntentModule } from "../intents/infrastructure/module";
import type { Intent } from "../intents/infrastructure/types";
import type { WorkspaceRef } from "../../shared/api/types";
import { extractWorkspaceName } from "../../shared/api/id-utils";
import type { ProjectId } from "../../shared/api/types";

const PROJECT_ID = "project-ea0135bc" as ProjectId;

// =============================================================================
// Test Constants
// =============================================================================

const WORKSPACE_PATH = "/workspaces/feature-x";

// =============================================================================
// Test Setup
// =============================================================================

interface TestSetup {
  dispatcher: Dispatcher;
}

function createTestSetup(cachedRef: WorkspaceRef | null): TestSetup {
  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);

  dispatcher.registerOperation(INTENT_GET_ACTIVE_WORKSPACE, new GetActiveWorkspaceOperation());

  // Active workspace hook handler module (event-cache pattern)
  const activeWorkspaceModule: IntentModule = {
    hooks: {
      [GET_ACTIVE_WORKSPACE_OPERATION_ID]: {
        get: {
          handler: async (): Promise<GetActiveWorkspaceHookResult> => {
            return { workspaceRef: cachedRef };
          },
        },
      },
    },
  };

  dispatcher.registerModule(activeWorkspaceModule);

  return { dispatcher };
}

// =============================================================================
// Helpers
// =============================================================================

function getActiveWorkspaceIntent(): GetActiveWorkspaceIntent {
  return {
    type: INTENT_GET_ACTIVE_WORKSPACE,
    payload: {},
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("GetActiveWorkspace Operation", () => {
  describe("returns ref when cached (#10)", () => {
    let setup: TestSetup;

    const expectedRef: WorkspaceRef = {
      projectId: PROJECT_ID,
      workspaceName: extractWorkspaceName(WORKSPACE_PATH),
      path: WORKSPACE_PATH,
    };

    beforeEach(() => {
      setup = createTestSetup(expectedRef);
    });

    it("returns WorkspaceRef with projectId, workspaceName, and path", async () => {
      const { dispatcher } = setup;

      const result = (await dispatcher.dispatch(getActiveWorkspaceIntent())) as WorkspaceRef | null;

      expect(result).not.toBeNull();
      expect(result!.projectId).toBe(expectedRef.projectId);
      expect(result!.workspaceName).toBe(expectedRef.workspaceName);
      expect(result!.path).toBe(WORKSPACE_PATH);
    });
  });

  describe("returns null when no cached ref (#11)", () => {
    it("returns null when no active workspace", async () => {
      const setup = createTestSetup(null);

      const result = await setup.dispatcher.dispatch(getActiveWorkspaceIntent());

      expect(result).toBeNull();
    });
  });

  describe("interceptor", () => {
    it("cancellation prevents operation execution (#14)", async () => {
      const expectedRef: WorkspaceRef = {
        projectId: PROJECT_ID,
        workspaceName: extractWorkspaceName(WORKSPACE_PATH),
        path: WORKSPACE_PATH,
      };
      const setup = createTestSetup(expectedRef);

      const cancelInterceptor: IntentInterceptor = {
        id: "cancel-all",
        async before(): Promise<Intent | null> {
          return null;
        },
      };
      setup.dispatcher.addInterceptor(cancelInterceptor);

      const result = await setup.dispatcher.dispatch(getActiveWorkspaceIntent());

      expect(result).toBeUndefined();
    });
  });
});
