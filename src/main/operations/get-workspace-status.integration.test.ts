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

import { describe, it, expect, beforeEach } from "vitest";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";
import type { IntentInterceptor } from "../intents/infrastructure/dispatcher";

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
import {
  ResolveWorkspaceOperation,
  RESOLVE_WORKSPACE_OPERATION_ID,
  INTENT_RESOLVE_WORKSPACE,
} from "./resolve-workspace";
import type { ResolveHookResult } from "./resolve-workspace";
import type { IntentModule } from "../intents/infrastructure/module";
import type { HookContext } from "../intents/infrastructure/operation";
import type { Intent } from "../intents/infrastructure/types";
import type { WorkspaceName, WorkspaceStatus } from "../../shared/api/types";
import type { AggregatedAgentStatus, WorkspacePath } from "../../shared/ipc";
import { extractWorkspaceName } from "../../shared/api/id-utils";
import { Path } from "../../services/platform/path";

// =============================================================================
// Test Constants
// =============================================================================

const PROJECT_ROOT = "/project";
const WORKSPACE_PATH = "/workspaces/feature-x";

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

interface MockAgentStatusManager {
  statusMap: Map<string, AggregatedAgentStatus>;
  getStatus(path: WorkspacePath): AggregatedAgentStatus;
}

function createMockAgentStatusManager(
  entries: Record<string, AggregatedAgentStatus> = {}
): MockAgentStatusManager {
  const statusMap = new Map(Object.entries(entries));
  return {
    statusMap,
    getStatus: (path: WorkspacePath) =>
      statusMap.get(path) ?? { status: "none", counts: { idle: 0, busy: 0 } },
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
  agentStatusManager?: MockAgentStatusManager | null;
}): TestSetup {
  const workspaceName = extractWorkspaceName(WORKSPACE_PATH) as WorkspaceName;

  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);

  dispatcher.registerOperation(INTENT_GET_WORKSPACE_STATUS, new GetWorkspaceStatusOperation());
  dispatcher.registerOperation(INTENT_RESOLVE_WORKSPACE, new ResolveWorkspaceOperation());

  // resolve module: validates workspacePath → returns projectPath + workspaceName
  const resolveModule: IntentModule = {
    hooks: {
      [RESOLVE_WORKSPACE_OPERATION_ID]: {
        resolve: {
          handler: async (ctx: HookContext): Promise<ResolveHookResult> => {
            const intent = ctx.intent as { payload: { workspacePath: string } };
            if (intent.payload.workspacePath === WORKSPACE_PATH) {
              return { projectPath: PROJECT_ROOT, workspaceName };
            }
            return {};
          },
        },
      },
    },
  };

  // get module: returns isDirty from mock provider (reads workspacePath from enriched context)
  const getStatusModule: IntentModule = {
    hooks: {
      [GET_WORKSPACE_STATUS_OPERATION_ID]: {
        get: {
          handler: async (ctx: HookContext): Promise<GetStatusHookResult> => {
            const { workspacePath } = ctx as GetStatusHookInput;
            const provider = opts.workspaceProvider;
            const isDirty = provider ? await provider.isDirty(new Path(workspacePath)) : false;
            return { isDirty };
          },
        },
      },
    },
  };

  // agent status module: returns agentStatus from mock manager (reads workspacePath from enriched context)
  const agentStatusModule: IntentModule = {
    hooks: {
      [GET_WORKSPACE_STATUS_OPERATION_ID]: {
        get: {
          handler: async (ctx: HookContext): Promise<GetStatusHookResult> => {
            const { workspacePath } = ctx as GetStatusHookInput;
            const manager = opts.agentStatusManager;
            if (manager) {
              return { agentStatus: manager.getStatus(workspacePath as WorkspacePath) };
            }
            return {};
          },
        },
      },
    },
  };

  dispatcher.registerModule(resolveModule);
  dispatcher.registerModule(getStatusModule);
  dispatcher.registerModule(agentStatusModule);

  return { dispatcher, workspaceName };
}

// =============================================================================
// Helpers
// =============================================================================

function statusIntent(workspacePath: string): GetWorkspaceStatusIntent {
  return {
    type: INTENT_GET_WORKSPACE_STATUS,
    payload: { workspacePath },
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
        agentStatusManager: createMockAgentStatusManager({
          [WORKSPACE_PATH]: { status: "busy", counts: { idle: 0, busy: 1 } },
        }),
      });
    });

    it("returns combined dirty + agent status", async () => {
      const { dispatcher } = setup;

      const result = (await dispatcher.dispatch(statusIntent(WORKSPACE_PATH))) as WorkspaceStatus;

      expect(result.isDirty).toBe(true);
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
        agentStatusManager: createMockAgentStatusManager({
          [WORKSPACE_PATH]: { status: "idle", counts: { idle: 1, busy: 0 } },
        }),
      });

      const result = (await cleanSetup.dispatcher.dispatch(
        statusIntent(WORKSPACE_PATH)
      )) as WorkspaceStatus;

      expect(result.isDirty).toBe(false);
      expect(result.agent).toEqual({
        type: "idle",
        counts: { idle: 1, busy: 0, total: 1 },
      });
    });
  });

  describe("no agent status manager (#2)", () => {
    it("returns none agent when no manager registered", async () => {
      const setup = createTestSetup({
        workspaceProvider: createMockWorkspaceProvider({
          [WORKSPACE_PATH]: true,
        }),
        agentStatusManager: null,
      });

      const result = (await setup.dispatcher.dispatch(
        statusIntent(WORKSPACE_PATH)
      )) as WorkspaceStatus;

      expect(result.isDirty).toBe(true);
      expect(result.agent).toEqual({ type: "none" });
    });

    it("returns none agent when status is none", async () => {
      const setup = createTestSetup({
        workspaceProvider: createMockWorkspaceProvider({
          [WORKSPACE_PATH]: false,
        }),
        agentStatusManager: createMockAgentStatusManager({
          // No entry for workspace — getStatus returns none default
        }),
      });

      const result = (await setup.dispatcher.dispatch(
        statusIntent(WORKSPACE_PATH)
      )) as WorkspaceStatus;

      expect(result.isDirty).toBe(false);
      expect(result.agent).toEqual({ type: "none" });
    });
  });

  describe("no workspace provider", () => {
    it("returns isDirty false when no provider", async () => {
      const setup = createTestSetup({
        workspaceProvider: null,
        agentStatusManager: null,
      });

      const result = (await setup.dispatcher.dispatch(
        statusIntent(WORKSPACE_PATH)
      )) as WorkspaceStatus;

      expect(result.isDirty).toBe(false);
      expect(result.agent).toEqual({ type: "none" });
    });
  });

  describe("error cases", () => {
    it("unknown workspace path throws", async () => {
      const setup = createTestSetup({
        workspaceProvider: createMockWorkspaceProvider(),
        agentStatusManager: null,
      });

      const error = await setup.dispatcher
        .dispatch(statusIntent("/nonexistent/path"))
        .then(() => expect.unreachable("should have thrown"))
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("Workspace not found: /nonexistent/path");
    });
  });

  describe("interceptor", () => {
    it("cancellation prevents operation execution (#14)", async () => {
      const setup = createTestSetup({
        workspaceProvider: createMockWorkspaceProvider({
          [WORKSPACE_PATH]: true,
        }),
        agentStatusManager: createMockAgentStatusManager({
          [WORKSPACE_PATH]: { status: "busy", counts: { idle: 0, busy: 1 } },
        }),
      });

      const cancelInterceptor: IntentInterceptor = {
        id: "cancel-all",
        async before(): Promise<Intent | null> {
          return null;
        },
      };
      setup.dispatcher.addInterceptor(cancelInterceptor);

      const result = await setup.dispatcher.dispatch(statusIntent(WORKSPACE_PATH));

      expect(result).toBeUndefined();
    });
  });
});
