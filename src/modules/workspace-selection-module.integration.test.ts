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

import { createMockDispatcher } from "../intents/lib/dispatcher.test-utils";
import { describe, it, expect } from "vitest";
import { Dispatcher } from "../intents/lib/dispatcher";
import { INTENT_SWITCH_WORKSPACE, EVENT_WORKSPACE_SWITCHED } from "../intents/switch-workspace";
import type {
  SwitchWorkspaceIntent,
  FindCandidatesHookResult,
  WorkspaceCandidate,
  WorkspaceSwitchedEvent,
} from "../intents/switch-workspace";
import { SWITCH_WORKSPACE_OPERATION_ID } from "../intents/switch-workspace";
import {
  createTestViewManager,
  registerTestInfrastructure,
} from "../intents/operations.test-utils";
import type { IntentModule } from "../intents/lib/module";
import type { HookOutput } from "../intents/lib/operation";
import type { DomainEvent } from "../intents/lib/types";
import { createWorkspaceSelectionModule } from "./workspace-selection-module";
import { EVENT_AGENT_STATUS_UPDATED } from "../intents/update-agent-status";
import type { AgentStatusUpdatedEvent } from "../intents/update-agent-status";
import type { WorkspacePath, AggregatedAgentStatus } from "../shared/ipc";
import type { ProjectId, WorkspaceName } from "../shared/api/types";

// =============================================================================
// Test Constants
// =============================================================================

const PROJECT_PATH = "/projects/app";
const PROJECT_NAME = "app";
const WS_A = "/projects/app/workspaces/alpha";
const WS_B = "/projects/app/workspaces/beta";
const WS_C = "/projects/app/workspaces/gamma";

function candidate(workspacePath: string): WorkspaceCandidate {
  return {
    projectPath: PROJECT_PATH,
    projectName: PROJECT_NAME,
    workspacePath,
    workspaceName: workspacePath.slice(workspacePath.lastIndexOf("/") + 1),
  };
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
  const dispatcher = createMockDispatcher();
  const { viewManager, activeWorkspace } = createTestViewManager();

  registerTestInfrastructure(dispatcher, {
    workspaces: (wsPath) => {
      const found = opts.candidates.find((c) => c.workspacePath === wsPath);
      if (!found) return undefined;
      return {
        projectPath: found.projectPath,
        workspaceName: wsPath.slice(wsPath.lastIndexOf("/") + 1) as WorkspaceName,
      };
    },
    projects: {
      [PROJECT_PATH]: {
        projectId: Buffer.from(PROJECT_PATH).toString("base64url") as ProjectId,
        projectName: PROJECT_NAME,
      },
    },
    viewManager,
  });

  // Find-candidates module (returns fixed candidates)
  const findCandidatesModule: IntentModule = {
    name: "test",
    hooks: {
      [SWITCH_WORKSPACE_OPERATION_ID]: {
        "find-candidates": {
          handler: async (): Promise<HookOutput<FindCandidatesHookResult>> => {
            return { result: { candidates: opts.candidates } };
          },
        },
      },
    },
  };

  const selectionModule = createWorkspaceSelectionModule();

  for (const m of [findCandidatesModule, selectionModule]) dispatcher.registerModule(m);

  return {
    dispatcher,
    selectionModule,
    get activeWorkspacePath() {
      return activeWorkspace.path;
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
            workspace: {
              path: wsPath as WorkspacePath,
              projectId,
              name: wsPath.slice(wsPath.lastIndexOf("/") + 1) as WorkspaceName,
              active: false,
            },
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
