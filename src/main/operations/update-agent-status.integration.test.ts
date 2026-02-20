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
  INTENT_UPDATE_AGENT_STATUS,
  EVENT_AGENT_STATUS_UPDATED,
} from "./update-agent-status";
import type { UpdateAgentStatusIntent, AgentStatusUpdatedEvent } from "./update-agent-status";
import {
  ResolveWorkspaceOperation,
  RESOLVE_WORKSPACE_OPERATION_ID,
  INTENT_RESOLVE_WORKSPACE,
} from "./resolve-workspace";
import type { ResolveHookResult as ResolveWorkspaceHookResult } from "./resolve-workspace";
import {
  ResolveProjectOperation,
  RESOLVE_PROJECT_OPERATION_ID,
  INTENT_RESOLVE_PROJECT,
} from "./resolve-project";
import type { ResolveHookResult as ResolveProjectHookResult } from "./resolve-project";
import type { DomainEvent } from "../intents/infrastructure/types";
import type { IntentModule } from "../intents/infrastructure/module";
import type { WorkspacePath, AggregatedAgentStatus } from "../../shared/ipc";
import type { ProjectId, WorkspaceName } from "../../shared/api/types";

// =============================================================================
// Test Setup
// =============================================================================

const TEST_PROJECT_ID = "test-project-id" as ProjectId;
const TEST_PROJECT_PATH = "/projects/test";
const TEST_WORKSPACE_NAME = "test-workspace" as WorkspaceName;

/**
 * Mock resolve modules that provide workspace + project resolution
 * for the update-agent-status operation via shared resolve intents.
 */
function createMockResolveModules(): IntentModule[] {
  const resolveWorkspaceModule: IntentModule = {
    hooks: {
      [RESOLVE_WORKSPACE_OPERATION_ID]: {
        resolve: {
          handler: async (): Promise<ResolveWorkspaceHookResult> => {
            return {
              projectPath: TEST_PROJECT_PATH,
              workspaceName: TEST_WORKSPACE_NAME,
            };
          },
        },
      },
    },
  };

  const resolveProjectModule: IntentModule = {
    hooks: {
      [RESOLVE_PROJECT_OPERATION_ID]: {
        resolve: {
          handler: async (): Promise<ResolveProjectHookResult> => {
            return { projectId: TEST_PROJECT_ID };
          },
        },
      },
    },
  };

  return [resolveWorkspaceModule, resolveProjectModule];
}

function createTestSetup(): { dispatcher: Dispatcher } {
  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);

  dispatcher.registerOperation(INTENT_UPDATE_AGENT_STATUS, new UpdateAgentStatusOperation());
  dispatcher.registerOperation(INTENT_RESOLVE_WORKSPACE, new ResolveWorkspaceOperation());
  dispatcher.registerOperation(INTENT_RESOLVE_PROJECT, new ResolveProjectOperation());

  for (const mod of createMockResolveModules()) {
    dispatcher.registerModule(mod);
  }

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
      dispatcher.registerOperation(INTENT_RESOLVE_WORKSPACE, new ResolveWorkspaceOperation());
      dispatcher.registerOperation(INTENT_RESOLVE_PROJECT, new ResolveProjectOperation());

      // Register resolve modules that return empty — resolve operations will throw,
      // and update-agent-status catches the error and silently returns.
      const emptyResolveModule: IntentModule = {
        hooks: {
          [RESOLVE_WORKSPACE_OPERATION_ID]: {
            resolve: {
              handler: async (): Promise<ResolveWorkspaceHookResult> => ({}),
            },
          },
          [RESOLVE_PROJECT_OPERATION_ID]: {
            resolve: {
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
