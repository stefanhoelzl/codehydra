// @vitest-environment node
/**
 * Integration tests for get-workspace-status operation through the Dispatcher.
 *
 * Tests verify the full dispatch pipeline: intent -> operation -> hooks -> result,
 * using the 2-stage hook pipeline: resolve → get.
 *
 * Test plan items covered:
 * #1: get-workspace-status returns dirty + agent status
 * #2: get-workspace-status returns none agent when no manager
 */

import { createMockDispatcher } from "./lib/dispatcher.test-utils";
import { describe, it, expect, beforeEach } from "vitest";
import { Dispatcher } from "./lib/dispatcher";
import type { IntentInterceptor } from "./lib/dispatcher";

import {
  GetWorkspaceStatusOperation,
  GET_WORKSPACE_STATUS_OPERATION_ID,
  INTENT_GET_WORKSPACE_STATUS,
} from "./get-workspace-status";
import type {
  GetWorkspaceStatusIntent,
  GetStatusHookResult,
  GetStatusHookInput,
} from "./get-workspace-status";
import { registerTestInfrastructure } from "./operations.test-utils";
import type { IntentModule } from "./lib/module";
import type { HookContext, HookOutput } from "./lib/operation";
import type { Intent } from "./lib/types";
import type { WorkspaceName, WorkspaceStatus } from "../shared/api/types";
import type { AggregatedAgentStatus } from "../shared/ipc";
import { Path } from "../utils/path/path";
import { projPath, wsPath, workspaceRefIn } from "../shared/test-fixtures";
import type { WorkspaceRef } from "./contract";

// =============================================================================
// Test Constants
// =============================================================================

const PROJECT_ROOT = projPath("/project");
const WORKSPACE_PATH = wsPath("/workspaces/feature-x");
const WORKSPACE_REF = workspaceRefIn(PROJECT_ROOT, "feature-x");

// =============================================================================
// Behavioral Mocks
// =============================================================================

interface MockWorkspaceProvider {
  isDirtyMap: Map<string, boolean>;
  isDirty(workspacePath: Path): Promise<boolean>;
}

function createMockWorkspaceProvider(entries: Record<string, boolean> = {}): MockWorkspaceProvider {
  const isDirtyMap = new Map(Object.entries(entries));
  return {
    isDirtyMap,
    isDirty: async (workspacePath: Path) => isDirtyMap.get(workspacePath.toString()) ?? false,
  };
}

// =============================================================================
// Test Setup
// =============================================================================

interface TestSetup {
  dispatcher: Dispatcher;
  workspaceName: WorkspaceName;
}

function createTestSetup(opts: {
  workspaceProvider?: MockWorkspaceProvider | null;
  agentStatus?: AggregatedAgentStatus | null;
}): TestSetup {
  const workspaceName = "feature-x" as WorkspaceName;

  const dispatcher = createMockDispatcher();

  dispatcher.registerOperation(new GetWorkspaceStatusOperation());

  registerTestInfrastructure(dispatcher, {
    workspaces: { [WORKSPACE_PATH]: { projectPath: PROJECT_ROOT, workspaceName } },
  });

  // get module: a made-up type with its own status values (no provider: it reports none)
  const getStatusModule: IntentModule = {
    name: "test",
    hooks: {
      [GET_WORKSPACE_STATUS_OPERATION_ID]: {
        get: {
          handler: async (ctx: HookContext): Promise<HookOutput<GetStatusHookResult>> => {
            const { workspacePath } = ctx as GetStatusHookInput;
            const provider = opts.workspaceProvider;
            if (!provider) return { result: {} };
            const touched = await provider.isDirty(new Path(workspacePath));
            return {
              result: touched
                ? { status: "touched", statusDescription: "Touched by hand" }
                : { status: "pristine" },
            };
          },
        },
      },
    },
  };

  // agent status module: returns agentStatus directly from test data
  const agentStatusModule: IntentModule = {
    name: "test",
    hooks: {
      [GET_WORKSPACE_STATUS_OPERATION_ID]: {
        get: {
          handler: async (): Promise<HookOutput<GetStatusHookResult>> => {
            const status = opts.agentStatus;
            if (status) {
              return { result: { agentStatus: status } };
            }
            return { result: {} };
          },
        },
      },
    },
  };

  dispatcher.registerModule(getStatusModule);
  dispatcher.registerModule(agentStatusModule);

  return { dispatcher, workspaceName };
}

// =============================================================================
// Helpers
// =============================================================================

function statusIntent(workspaceRef: WorkspaceRef): GetWorkspaceStatusIntent {
  return {
    type: INTENT_GET_WORKSPACE_STATUS,
    payload: { workspaceRef },
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("GetWorkspaceStatus Operation", () => {
  describe("dirty + agent status (#1)", () => {
    let setup: TestSetup;

    beforeEach(() => {
      setup = createTestSetup({
        workspaceProvider: createMockWorkspaceProvider({
          [WORKSPACE_PATH]: true,
        }),
        agentStatus: { status: "busy", counts: { idle: 0, busy: 1 } },
      });
    });

    it("returns combined dirty + agent status", async () => {
      const { dispatcher } = setup;

      const result = (await dispatcher.dispatch(statusIntent(WORKSPACE_REF))) as WorkspaceStatus;

      expect(result.status).toBe("touched");
      expect(result.statusDescription).toBe("Touched by hand");
      expect(result.agent).toEqual({
        type: "busy",
        counts: { idle: 0, busy: 1, total: 1 },
      });
    });

    it("returns not dirty when workspace is clean", async () => {
      const cleanSetup = createTestSetup({
        workspaceProvider: createMockWorkspaceProvider({
          [WORKSPACE_PATH]: false,
        }),
        agentStatus: { status: "idle", counts: { idle: 1, busy: 0 } },
      });

      const result = (await cleanSetup.dispatcher.dispatch(
        statusIntent(WORKSPACE_REF)
      )) as WorkspaceStatus;

      expect(result.status).toBe("pristine");
      expect(result).not.toHaveProperty("statusDescription");
      expect(result.agent).toEqual({
        type: "idle",
        counts: { idle: 1, busy: 0, total: 1 },
      });
    });

    it.each([
      ["busy", { status: "busy", counts: { idle: 0, busy: 1 } }],
      ["none", { status: "none", counts: { idle: 0, busy: 0 } }],
    ] as const)("passes the agent's changedAt through (%s)", async (_label, agentStatus) => {
      const changedAt = "2026-11-05T10:00:00.000Z";
      const stamped = createTestSetup({
        workspaceProvider: createMockWorkspaceProvider({ [WORKSPACE_PATH]: false }),
        agentStatus: { ...agentStatus, changedAt },
      });

      const result = (await stamped.dispatcher.dispatch(
        statusIntent(WORKSPACE_REF)
      )) as WorkspaceStatus;

      expect(result.agent.changedAt).toBe(changedAt);
    });
  });

  describe("no agent status manager (#2)", () => {
    it("returns none agent when no manager registered", async () => {
      const setup = createTestSetup({
        workspaceProvider: createMockWorkspaceProvider({
          [WORKSPACE_PATH]: true,
        }),
        agentStatus: null,
      });

      const result = (await setup.dispatcher.dispatch(
        statusIntent(WORKSPACE_REF)
      )) as WorkspaceStatus;

      expect(result.status).toBe("touched");
      expect(result.agent).toEqual({ type: "none" });
    });

    it("returns none agent when status is none", async () => {
      const setup = createTestSetup({
        workspaceProvider: createMockWorkspaceProvider({
          [WORKSPACE_PATH]: false,
        }),
        agentStatus: null,
      });

      const result = (await setup.dispatcher.dispatch(
        statusIntent(WORKSPACE_REF)
      )) as WorkspaceStatus;

      expect(result.status).toBe("pristine");
      expect(result.agent).toEqual({ type: "none" });
    });
  });

  describe("the type's work status (#3)", () => {
    it("passes the type's status, description and details through untouched", async () => {
      const dispatcher = createMockDispatcher();
      const workspaceName = "feature-x" as WorkspaceName;

      dispatcher.registerOperation(new GetWorkspaceStatusOperation());

      registerTestInfrastructure(dispatcher, {
        workspaces: { [WORKSPACE_PATH]: { projectPath: PROJECT_ROOT, workspaceName } },
      });

      const typeModule: IntentModule = {
        name: "test",
        hooks: {
          [GET_WORKSPACE_STATUS_OPERATION_ID]: {
            get: {
              handler: async (): Promise<HookOutput<GetStatusHookResult>> => ({
                result: {
                  status: "stale",
                  statusDescription: "3 changes elsewhere",
                  details: { behind: 3 },
                },
              }),
            },
          },
        },
      };

      dispatcher.registerModule(typeModule);

      const result = (await dispatcher.dispatch(statusIntent(WORKSPACE_REF))) as WorkspaceStatus;

      expect(result).toMatchObject({
        status: "stale",
        statusDescription: "3 changes elsewhere",
        details: { behind: 3 },
      });
    });

    it("omits the description when the type has nothing to warn about", async () => {
      const setup = createTestSetup({
        workspaceProvider: createMockWorkspaceProvider({
          [WORKSPACE_PATH]: false,
        }),
        agentStatus: null,
      });

      const result = (await setup.dispatcher.dispatch(
        statusIntent(WORKSPACE_REF)
      )) as WorkspaceStatus;

      expect(result.status).toBe("pristine");
      expect(result).not.toHaveProperty("statusDescription");
    });
  });

  describe("no workspace provider", () => {
    it("omits the work status when no type reports one", async () => {
      const setup = createTestSetup({
        workspaceProvider: null,
        agentStatus: null,
      });

      const result = (await setup.dispatcher.dispatch(
        statusIntent(WORKSPACE_REF)
      )) as WorkspaceStatus;

      expect(result).not.toHaveProperty("status");
      expect(result).not.toHaveProperty("statusDescription");
      expect(result.agent).toEqual({ type: "none" });
    });
  });

  describe("error cases", () => {
    it("unknown workspace path throws", async () => {
      const setup = createTestSetup({
        workspaceProvider: createMockWorkspaceProvider(),
        agentStatus: null,
      });

      const error = await setup.dispatcher
        .dispatch(statusIntent(workspaceRefIn(PROJECT_ROOT, "nonexistent")))
        .then(() => expect.unreachable("should have thrown"))
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        `Workspace not found: ${workspaceRefIn(PROJECT_ROOT, "nonexistent")}`
      );
    });
  });

  describe("interceptor", () => {
    it("cancellation prevents operation execution (#14)", async () => {
      const setup = createTestSetup({
        workspaceProvider: createMockWorkspaceProvider({
          [WORKSPACE_PATH]: true,
        }),
        agentStatus: { status: "busy", counts: { idle: 0, busy: 1 } },
      });

      const cancelInterceptor: IntentInterceptor = {
        id: "cancel-all",
        async before(): Promise<Intent | null> {
          return null;
        },
      };
      setup.dispatcher.addInterceptor(cancelInterceptor);

      const result = await setup.dispatcher.dispatch(statusIntent(WORKSPACE_REF));

      expect(result).toBeUndefined();
    });
  });
});
