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
import { Dispatcher } from "../intents/infrastructure/dispatcher";
import { createMockLogger } from "../../services/logging/logging.test-utils";
import {
  SwitchWorkspaceOperation,
  INTENT_SWITCH_WORKSPACE,
  EVENT_WORKSPACE_SWITCHED,
} from "../operations/switch-workspace";
import type {
  SwitchWorkspaceIntent,
  SwitchWorkspaceHookResult,
  FindCandidatesHookResult,
  WorkspaceCandidate,
  WorkspaceSwitchedEvent,
} from "../operations/switch-workspace";
import { SWITCH_WORKSPACE_OPERATION_ID } from "../operations/switch-workspace";
import {
  ResolveWorkspaceOperation,
  RESOLVE_WORKSPACE_OPERATION_ID,
  INTENT_RESOLVE_WORKSPACE,
} from "../operations/resolve-workspace";
import type { ResolveHookResult as ResolveWorkspaceHookResult } from "../operations/resolve-workspace";
import {
  ResolveProjectOperation,
  RESOLVE_PROJECT_OPERATION_ID,
  INTENT_RESOLVE_PROJECT,
} from "../operations/resolve-project";
import type { ResolveHookResult as ResolveProjectHookResult } from "../operations/resolve-project";
import type { IntentModule } from "../intents/infrastructure/module";
import type { HookContext } from "../intents/infrastructure/operation";
import type { DomainEvent } from "../intents/infrastructure/types";
import { createWorkspaceSelectionModule } from "./workspace-selection-module";
import { EVENT_AGENT_STATUS_UPDATED } from "../operations/update-agent-status";
import type { AgentStatusUpdatedEvent } from "../operations/update-agent-status";
import { extractWorkspaceName } from "../../shared/api/id-utils";
import type { WorkspacePath, AggregatedAgentStatus } from "../../shared/ipc";
import type { ProjectId, WorkspaceName } from "../../shared/api/types";

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
  selectionModule: IntentModule;
  activeWorkspacePath: string | null;
}

function createTestSetup(opts: { candidates: WorkspaceCandidate[] }): TestSetup {
  const dispatcher = new Dispatcher({ logger: createMockLogger() });

  dispatcher.registerOperation(INTENT_SWITCH_WORKSPACE, new SwitchWorkspaceOperation());
  dispatcher.registerOperation(INTENT_RESOLVE_WORKSPACE, new ResolveWorkspaceOperation());
  dispatcher.registerOperation(INTENT_RESOLVE_PROJECT, new ResolveProjectOperation());

  let activeWorkspacePath: string | null = null;

  // Resolve module: workspace path → project path + workspace name
  const resolveModule: IntentModule = {
    name: "test",
    hooks: {
      [RESOLVE_WORKSPACE_OPERATION_ID]: {
        resolve: {
          handler: async (ctx: HookContext): Promise<ResolveWorkspaceHookResult> => {
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
    name: "test",
    hooks: {
      [RESOLVE_PROJECT_OPERATION_ID]: {
        resolve: {
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
    name: "test",
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
    name: "test",
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

  const selectionModule = createWorkspaceSelectionModule();

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
    selectionModule,
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
      const setup = createTestSetup({
        candidates: [candidate(WS_A), candidate(WS_B), candidate(WS_C)],
      });

      // Populate the module's internal status cache via its event handler
      const statusHandler = setup.selectionModule.events![EVENT_AGENT_STATUS_UPDATED]!;
      const projectId = Buffer.from(PROJECT_PATH).toString("base64url") as ProjectId;
      for (const [wsPath, status] of [
        [WS_A, noneStatus()],
        [WS_B, busyStatus()],
        [WS_C, idleStatus()],
      ] as const) {
        const event: AgentStatusUpdatedEvent = {
          type: EVENT_AGENT_STATUS_UPDATED,
          payload: {
            workspacePath: wsPath as WorkspacePath,
            projectId,
            workspaceName: extractWorkspaceName(wsPath) as WorkspaceName,
            status,
          },
        };
        await statusHandler.handler(event);
      }

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
