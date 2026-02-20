// @vitest-environment node
/**
 * Integration tests for update-agent-status operation through the Dispatcher.
 *
 * Tests verify the full dispatch pipeline: intent -> resolve hooks -> operation -> domain event emission.
 *
 * Test plan items covered:
 * #1: Status change produces domain event
 */

import { describe, it, expect } from "vitest";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";

import {
  UpdateAgentStatusOperation,
  UPDATE_AGENT_STATUS_OPERATION_ID,
  INTENT_UPDATE_AGENT_STATUS,
  EVENT_AGENT_STATUS_UPDATED,
} from "./update-agent-status";
import type {
  UpdateAgentStatusIntent,
  AgentStatusUpdatedEvent,
  ResolveHookResult,
  ResolveProjectHookResult,
  ResolveHookInput,
  ResolveProjectHookInput,
} from "./update-agent-status";
import type { DomainEvent } from "../intents/infrastructure/types";
import type { IntentModule } from "../intents/infrastructure/module";
import type { HookContext } from "../intents/infrastructure/operation";
import type { WorkspacePath, AggregatedAgentStatus } from "../../shared/ipc";
import type { ProjectId, WorkspaceName } from "../../shared/api/types";

// =============================================================================
// Test Setup
// =============================================================================

const TEST_PROJECT_ID = "test-project-id" as ProjectId;
const TEST_PROJECT_PATH = "/projects/test";
const TEST_WORKSPACE_NAME = "test-workspace" as WorkspaceName;

/**
 * Mock resolve module that provides workspace resolution for the
 * update-agent-status operation.
 */
function createMockResolveModule(): IntentModule {
  return {
    hooks: {
      [UPDATE_AGENT_STATUS_OPERATION_ID]: {
        resolve: {
          handler: async (ctx: HookContext): Promise<ResolveHookResult> => {
            void (ctx as ResolveHookInput);
            return {
              projectPath: TEST_PROJECT_PATH,
              workspaceName: TEST_WORKSPACE_NAME,
            };
          },
        },
        "resolve-project": {
          handler: async (ctx: HookContext): Promise<ResolveProjectHookResult> => {
            void (ctx as ResolveProjectHookInput);
            return { projectId: TEST_PROJECT_ID };
          },
        },
      },
    },
  };
}

function createTestSetup(): { dispatcher: Dispatcher } {
  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);

  dispatcher.registerOperation(INTENT_UPDATE_AGENT_STATUS, new UpdateAgentStatusOperation());

  const resolveModule = createMockResolveModule();
  dispatcher.registerModule(resolveModule);

  return { dispatcher };
}

function updateStatusIntent(
  workspacePath: string,
  status: AggregatedAgentStatus
): UpdateAgentStatusIntent {
  return {
    type: INTENT_UPDATE_AGENT_STATUS,
    payload: {
      workspacePath: workspacePath as WorkspacePath,
      status,
    },
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("UpdateAgentStatus Operation", () => {
  describe("status change produces domain event (#1)", () => {
    it("emits agent:status-updated with correct workspacePath and status for busy", async () => {
      const { dispatcher } = createTestSetup();
      const receivedEvents: DomainEvent[] = [];
      dispatcher.subscribe(EVENT_AGENT_STATUS_UPDATED, (event) => {
        receivedEvents.push(event);
      });

      const status: AggregatedAgentStatus = { status: "busy", counts: { idle: 0, busy: 2 } };
      await dispatcher.dispatch(updateStatusIntent("/workspace/test", status));

      expect(receivedEvents).toHaveLength(1);
      const event = receivedEvents[0] as AgentStatusUpdatedEvent;
      expect(event.type).toBe(EVENT_AGENT_STATUS_UPDATED);
      expect(event.payload.workspacePath).toBe("/workspace/test");
      expect(event.payload.projectId).toBe(TEST_PROJECT_ID);
      expect(event.payload.workspaceName).toBe(TEST_WORKSPACE_NAME);
      expect(event.payload.status).toEqual(status);
    });

    it("emits agent:status-updated with correct payload for idle", async () => {
      const { dispatcher } = createTestSetup();
      const receivedEvents: DomainEvent[] = [];
      dispatcher.subscribe(EVENT_AGENT_STATUS_UPDATED, (event) => {
        receivedEvents.push(event);
      });

      const status: AggregatedAgentStatus = { status: "idle", counts: { idle: 3, busy: 0 } };
      await dispatcher.dispatch(updateStatusIntent("/workspace/idle-test", status));

      expect(receivedEvents).toHaveLength(1);
      const event = receivedEvents[0] as AgentStatusUpdatedEvent;
      expect(event.payload.workspacePath).toBe("/workspace/idle-test");
      expect(event.payload.status).toEqual(status);
    });

    it("emits agent:status-updated with correct payload for mixed", async () => {
      const { dispatcher } = createTestSetup();
      const receivedEvents: DomainEvent[] = [];
      dispatcher.subscribe(EVENT_AGENT_STATUS_UPDATED, (event) => {
        receivedEvents.push(event);
      });

      const status: AggregatedAgentStatus = { status: "mixed", counts: { idle: 1, busy: 2 } };
      await dispatcher.dispatch(updateStatusIntent("/workspace/mixed", status));

      expect(receivedEvents).toHaveLength(1);
      const event = receivedEvents[0] as AgentStatusUpdatedEvent;
      expect(event.payload.status).toEqual(status);
    });

    it("emits agent:status-updated with correct payload for none", async () => {
      const { dispatcher } = createTestSetup();
      const receivedEvents: DomainEvent[] = [];
      dispatcher.subscribe(EVENT_AGENT_STATUS_UPDATED, (event) => {
        receivedEvents.push(event);
      });

      const status: AggregatedAgentStatus = { status: "none", counts: { idle: 0, busy: 0 } };
      await dispatcher.dispatch(updateStatusIntent("/workspace/none", status));

      expect(receivedEvents).toHaveLength(1);
      const event = receivedEvents[0] as AgentStatusUpdatedEvent;
      expect(event.payload.status).toEqual(status);
    });

    it("silently returns when resolve hooks provide no projectPath", async () => {
      const hookRegistry = new HookRegistry();
      const dispatcher = new Dispatcher(hookRegistry);
      dispatcher.registerOperation(INTENT_UPDATE_AGENT_STATUS, new UpdateAgentStatusOperation());

      // Wire a resolve module that returns empty (workspace not found)
      const emptyResolveModule: IntentModule = {
        hooks: {
          [UPDATE_AGENT_STATUS_OPERATION_ID]: {
            resolve: {
              handler: async (): Promise<ResolveHookResult> => ({}),
            },
            "resolve-project": {
              handler: async (): Promise<ResolveProjectHookResult> => ({}),
            },
          },
        },
      };
      dispatcher.registerModule(emptyResolveModule);

      const receivedEvents: DomainEvent[] = [];
      dispatcher.subscribe(EVENT_AGENT_STATUS_UPDATED, (event) => {
        receivedEvents.push(event);
      });

      const status: AggregatedAgentStatus = { status: "busy", counts: { idle: 0, busy: 1 } };
      await dispatcher.dispatch(updateStatusIntent("/unknown/workspace", status));

      expect(receivedEvents).toHaveLength(0);
    });
  });
});
