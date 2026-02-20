// @vitest-environment node
/**
 * Integration tests for WorkspaceSelectionModule.
 *
 * Tests verify the "select-next" hook handler through the Dispatcher,
 * including scorer integration with agentStatusManager.
 *
 * Test plan items covered:
 * #1: Selects nearest candidate when no scorer differentiates
 * #2: Prefers idle workspace over busy workspace
 * #3: Returns undefined when no candidates provided
 */

import { describe, it, expect } from "vitest";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";
import {
  SwitchWorkspaceOperation,
  INTENT_SWITCH_WORKSPACE,
  EVENT_WORKSPACE_SWITCHED,
} from "../operations/switch-workspace";
import type {
  SwitchWorkspaceIntent,
  ResolveHookResult,
  ResolveProjectHookResult,
  SwitchWorkspaceHookResult,
  FindCandidatesHookResult,
  WorkspaceCandidate,
  WorkspaceSwitchedEvent,
} from "../operations/switch-workspace";
import { SWITCH_WORKSPACE_OPERATION_ID } from "../operations/switch-workspace";
import type { IntentModule } from "../intents/infrastructure/module";
import type { HookContext } from "../intents/infrastructure/operation";
import type { DomainEvent } from "../intents/infrastructure/types";
import { createWorkspaceSelectionModule } from "./workspace-selection-module";
import { extractWorkspaceName } from "../../shared/api/id-utils";
import type { WorkspacePath, AggregatedAgentStatus } from "../../shared/ipc";
import type { ProjectId } from "../../shared/api/types";

// =============================================================================
// Test Constants
// =============================================================================

const PROJECT_PATH = "/projects/app";
const PROJECT_NAME = "app";
const WS_A = "/projects/app/workspaces/alpha";
const WS_B = "/projects/app/workspaces/beta";
const WS_C = "/projects/app/workspaces/gamma";

function candidate(workspacePath: string): WorkspaceCandidate {
  return { projectPath: PROJECT_PATH, projectName: PROJECT_NAME, workspacePath };
}

function noneStatus(): AggregatedAgentStatus {
  return { status: "none", counts: { idle: 0, busy: 0 } };
}

function idleStatus(): AggregatedAgentStatus {
  return { status: "idle", counts: { idle: 1, busy: 0 } };
}

function busyStatus(): AggregatedAgentStatus {
  return { status: "busy", counts: { idle: 0, busy: 1 } };
}

// =============================================================================
// Test Setup
// =============================================================================

interface TestSetup {
  dispatcher: Dispatcher;
  activeWorkspacePath: string | null;
}

function createTestSetup(opts: {
  candidates: WorkspaceCandidate[];
  statusMap?: Map<string, AggregatedAgentStatus>;
}): TestSetup {
  const statusMap = opts.statusMap ?? new Map();
  const agentStatusManager = {
    getStatus(path: WorkspacePath): AggregatedAgentStatus {
      return statusMap.get(path) ?? noneStatus();
    },
  };

  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);

  dispatcher.registerOperation(INTENT_SWITCH_WORKSPACE, new SwitchWorkspaceOperation());

  let activeWorkspacePath: string | null = null;

  // Resolve module: workspace path → project path + workspace name
  const resolveModule: IntentModule = {
    hooks: {
      [SWITCH_WORKSPACE_OPERATION_ID]: {
        resolve: {
          handler: async (ctx: HookContext): Promise<ResolveHookResult> => {
            const { workspacePath: wsPath } = ctx as { workspacePath: string } & HookContext;
            const found = opts.candidates.find((c) => c.workspacePath === wsPath);
            if (!found) return {};
            return {
              projectPath: found.projectPath,
              workspaceName: extractWorkspaceName(wsPath),
            };
          },
        },
      },
    },
  };

  // Resolve project module
  const resolveProjectModule: IntentModule = {
    hooks: {
      [SWITCH_WORKSPACE_OPERATION_ID]: {
        "resolve-project": {
          handler: async (ctx: HookContext): Promise<ResolveProjectHookResult> => {
            const { projectPath } = ctx as { projectPath: string } & HookContext;
            if (projectPath === PROJECT_PATH) {
              return {
                projectId: Buffer.from(PROJECT_PATH).toString("base64url") as ProjectId,
                projectName: PROJECT_NAME,
              };
            }
            return {};
          },
        },
      },
    },
  };

  // Activate module
  const activateModule: IntentModule = {
    hooks: {
      [SWITCH_WORKSPACE_OPERATION_ID]: {
        activate: {
          handler: async (ctx: HookContext): Promise<SwitchWorkspaceHookResult> => {
            const { workspacePath } = ctx as { workspacePath: string } & HookContext;
            activeWorkspacePath = workspacePath;
            return { resolvedPath: workspacePath };
          },
        },
      },
    },
  };

  // Find-candidates module (returns fixed candidates)
  const findCandidatesModule: IntentModule = {
    hooks: {
      [SWITCH_WORKSPACE_OPERATION_ID]: {
        "find-candidates": {
          handler: async (): Promise<FindCandidatesHookResult> => {
            return { candidates: opts.candidates };
          },
        },
      },
    },
  };

  const selectionModule = createWorkspaceSelectionModule(agentStatusManager);

  for (const m of [
    resolveModule,
    resolveProjectModule,
    activateModule,
    findCandidatesModule,
    selectionModule,
  ])
    dispatcher.registerModule(m);

  return {
    dispatcher,
    get activeWorkspacePath() {
      return activeWorkspacePath;
    },
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("WorkspaceSelectionModule", () => {
  describe("selects nearest candidate (#1)", () => {
    it("picks the next workspace in alphabetical order", async () => {
      const setup = createTestSetup({
        candidates: [candidate(WS_A), candidate(WS_B), candidate(WS_C)],
      });

      const autoIntent: SwitchWorkspaceIntent = {
        type: INTENT_SWITCH_WORKSPACE,
        payload: { auto: true, currentPath: WS_A },
      };
      await setup.dispatcher.dispatch(autoIntent);

      expect(setup.activeWorkspacePath).toBe(WS_B);
    });
  });

  describe("prefers idle over busy (#2)", () => {
    it("selects idle workspace even when busy workspace is closer", async () => {
      const statusMap = new Map<string, AggregatedAgentStatus>([
        [WS_A, noneStatus()],
        [WS_B, busyStatus()],
        [WS_C, idleStatus()],
      ]);

      const setup = createTestSetup({
        candidates: [candidate(WS_A), candidate(WS_B), candidate(WS_C)],
        statusMap,
      });

      const autoIntent: SwitchWorkspaceIntent = {
        type: INTENT_SWITCH_WORKSPACE,
        payload: { auto: true, currentPath: WS_A },
      };
      await setup.dispatcher.dispatch(autoIntent);

      // gamma (idle, score=0) should be preferred over beta (busy, score=1)
      expect(setup.activeWorkspacePath).toBe(WS_C);
    });
  });

  describe("emits null when no candidates (#3)", () => {
    it("emits workspace:switched(null) when candidates list is empty", async () => {
      const setup = createTestSetup({ candidates: [] });

      const events: DomainEvent[] = [];
      setup.dispatcher.subscribe(EVENT_WORKSPACE_SWITCHED, (event) => {
        events.push(event);
      });

      const autoIntent: SwitchWorkspaceIntent = {
        type: INTENT_SWITCH_WORKSPACE,
        payload: { auto: true, currentPath: "/nonexistent" },
      };
      await setup.dispatcher.dispatch(autoIntent);

      expect(events).toHaveLength(1);
      expect((events[0] as WorkspaceSwitchedEvent).payload).toBeNull();
    });
  });
});
