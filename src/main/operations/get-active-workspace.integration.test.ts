// @vitest-environment node
/**
 * Integration tests for get-active-workspace operation through the Dispatcher.
 *
 * Tests verify the full dispatch pipeline: intent -> operation -> hook -> result,
 * using behavioral mocks for ViewManager and WorkspaceAccessor.
 *
 * Test plan items covered:
 * #10: get-active-workspace returns ref when active
 * #11: get-active-workspace returns null when none active
 * #12: get-active-workspace returns null when project not found
 */

import { describe, it, expect, beforeEach } from "vitest";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";
import type { IntentInterceptor } from "../intents/infrastructure/dispatcher";
import { wireModules } from "../intents/infrastructure/wire";
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
import { generateProjectId, extractWorkspaceName } from "../../shared/api/id-utils";

// =============================================================================
// Test Constants
// =============================================================================

const PROJECT_ROOT = "/project";
const WORKSPACE_PATH = "/workspaces/feature-x";

// =============================================================================
// Behavioral Mocks
// =============================================================================

interface MockViewManager {
  activeWorkspacePath: string | null;
  getActiveWorkspacePath(): string | null;
}

function createMockViewManager(activeWorkspacePath: string | null): MockViewManager {
  return {
    activeWorkspacePath,
    getActiveWorkspacePath(): string | null {
      return this.activeWorkspacePath;
    },
  };
}

interface MockProjectFinder {
  projects: Map<string, { path: string; name: string }>;
  findProjectForWorkspace(workspacePath: string): { path: string; name: string } | undefined;
}

function createMockProjectFinder(
  entries: Record<string, { path: string; name: string }> = {}
): MockProjectFinder {
  const projects = new Map(Object.entries(entries));
  return {
    projects,
    findProjectForWorkspace(workspacePath: string) {
      return projects.get(workspacePath);
    },
  };
}

// =============================================================================
// Test Setup
// =============================================================================

interface TestSetup {
  dispatcher: Dispatcher;
}

function createTestSetup(opts: {
  viewManager: MockViewManager;
  projectFinder: MockProjectFinder;
}): TestSetup {
  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);

  dispatcher.registerOperation(INTENT_GET_ACTIVE_WORKSPACE, new GetActiveWorkspaceOperation());

  // Active workspace hook handler module
  const activeWorkspaceModule: IntentModule = {
    hooks: {
      [GET_ACTIVE_WORKSPACE_OPERATION_ID]: {
        get: {
          handler: async (): Promise<GetActiveWorkspaceHookResult> => {
            const activeWorkspacePath = opts.viewManager.getActiveWorkspacePath();
            if (!activeWorkspacePath) {
              return { workspaceRef: null };
            }

            const project = opts.projectFinder.findProjectForWorkspace(activeWorkspacePath);
            if (!project) {
              return { workspaceRef: null };
            }

            const projectId = generateProjectId(project.path);
            const workspaceName = extractWorkspaceName(activeWorkspacePath);

            return {
              workspaceRef: {
                projectId,
                workspaceName,
                path: activeWorkspacePath,
              },
            };
          },
        },
      },
    },
  };

  wireModules([activeWorkspaceModule], hookRegistry, dispatcher);

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
  describe("returns ref when active (#10)", () => {
    let setup: TestSetup;

    beforeEach(() => {
      setup = createTestSetup({
        viewManager: createMockViewManager(WORKSPACE_PATH),
        projectFinder: createMockProjectFinder({
          [WORKSPACE_PATH]: { path: PROJECT_ROOT, name: "project" },
        }),
      });
    });

    it("returns WorkspaceRef with projectId, workspaceName, and path", async () => {
      const { dispatcher } = setup;

      const result = (await dispatcher.dispatch(getActiveWorkspaceIntent())) as WorkspaceRef | null;

      expect(result).not.toBeNull();
      expect(result!.projectId).toBe(generateProjectId(PROJECT_ROOT));
      expect(result!.workspaceName).toBe(extractWorkspaceName(WORKSPACE_PATH));
      expect(result!.path).toBe(WORKSPACE_PATH);
    });
  });

  describe("returns null when none active (#11)", () => {
    it("returns null when no active workspace", async () => {
      const setup = createTestSetup({
        viewManager: createMockViewManager(null),
        projectFinder: createMockProjectFinder(),
      });

      const result = await setup.dispatcher.dispatch(getActiveWorkspaceIntent());

      expect(result).toBeNull();
    });
  });

  describe("returns null when project not found (#12)", () => {
    it("returns null when active workspace has no matching project", async () => {
      const setup = createTestSetup({
        viewManager: createMockViewManager(WORKSPACE_PATH),
        projectFinder: createMockProjectFinder({}), // No project entries
      });

      const result = await setup.dispatcher.dispatch(getActiveWorkspaceIntent());

      expect(result).toBeNull();
    });
  });

  describe("interceptor", () => {
    it("cancellation prevents operation execution (#14)", async () => {
      const setup = createTestSetup({
        viewManager: createMockViewManager(WORKSPACE_PATH),
        projectFinder: createMockProjectFinder({
          [WORKSPACE_PATH]: { path: PROJECT_ROOT, name: "project" },
        }),
      });

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
