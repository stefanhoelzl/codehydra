// @vitest-environment node
/**
 * Integration tests for update-agent-status operation through the Dispatcher.
 *
 * Tests verify the full dispatch pipeline: intent -> operation -> domain event emission.
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
import type { DomainEvent } from "../intents/infrastructure/types";
import type { WorkspacePath, AggregatedAgentStatus } from "../../shared/ipc";
import type { ProjectId, WorkspaceName } from "../../shared/api/types";

// =============================================================================
// Test Setup
// =============================================================================

function createTestSetup(): { dispatcher: Dispatcher } {
  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);

  dispatcher.registerOperation(INTENT_UPDATE_AGENT_STATUS, new UpdateAgentStatusOperation());

  return { dispatcher };
}

const TEST_PROJECT_ID = "test-project-id" as ProjectId;
const TEST_WORKSPACE_NAME = "test-workspace" as WorkspaceName;

function updateStatusIntent(
  workspacePath: string,
  status: AggregatedAgentStatus
): UpdateAgentStatusIntent {
  return {
    type: INTENT_UPDATE_AGENT_STATUS,
    payload: {
      workspacePath: workspacePath as WorkspacePath,
      projectId: TEST_PROJECT_ID,
      workspaceName: TEST_WORKSPACE_NAME,
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
  });
});
