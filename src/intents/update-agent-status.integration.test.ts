// @vitest-environment node
/**
 * Integration tests for update-agent-status operation through the Dispatcher.
 *
 * Tests verify the full dispatch pipeline: intent -> resolve hooks -> operation -> domain event emission.
 *
 * Test plan items covered:
 * #1: Status change produces domain event
 */

import { createMockDispatcher } from "./lib/dispatcher.test-utils";
import { describe, it, expect } from "vitest";
import { Dispatcher } from "./lib/dispatcher";

import { UpdateAgentStatusOperation, EVENT_AGENT_STATUS_UPDATED } from "./update-agent-status";
import type { AgentStatusUpdatedEvent } from "./update-agent-status";
import { registerTestInfrastructure, updateStatusIntent } from "./operations.test-utils";
import type { DomainEvent } from "./lib/types";
import type { AggregatedAgentStatus } from "../shared/ipc";
import type { ProjectId, WorkspaceName } from "../shared/api/types";
import { projPath, wsPath, workspaceRefIn } from "../shared/test-fixtures";

// =============================================================================
// Test Setup
// =============================================================================

const TEST_PROJECT_ID = "test-project-id" as ProjectId;
const TEST_PROJECT_PATH = projPath("/projects/test");
const TEST_WORKSPACE_NAME = "test-workspace" as WorkspaceName;

const TEST_WORKSPACE_REF = workspaceRefIn(TEST_PROJECT_PATH, TEST_WORKSPACE_NAME);

const TEST_WORKSPACE_ENTRY = {
  projectPath: TEST_PROJECT_PATH,
  workspaceName: TEST_WORKSPACE_NAME,
};

function createTestSetup(): { dispatcher: Dispatcher } {
  const dispatcher = createMockDispatcher();

  dispatcher.registerOperation(new UpdateAgentStatusOperation());

  registerTestInfrastructure(dispatcher, {
    workspaces: { [wsPath("/workspace/test")]: TEST_WORKSPACE_ENTRY },
    projects: { [TEST_PROJECT_PATH]: { projectId: TEST_PROJECT_ID } },
  });

  return { dispatcher };
}

// =============================================================================
// Tests
// =============================================================================

describe("UpdateAgentStatus Operation", () => {
  describe("status change produces domain event (#1)", () => {
    it("emits agent:status-updated with correct workspace ref and status for busy", async () => {
      const { dispatcher } = createTestSetup();
      const receivedEvents: DomainEvent[] = [];
      dispatcher.subscribe(EVENT_AGENT_STATUS_UPDATED, (event) => {
        receivedEvents.push(event);
      });

      const status: AggregatedAgentStatus = { status: "busy", counts: { idle: 0, busy: 2 } };
      await dispatcher.dispatch(updateStatusIntent(TEST_WORKSPACE_REF, status));

      expect(receivedEvents).toHaveLength(1);
      const event = receivedEvents[0] as AgentStatusUpdatedEvent;
      expect(event.type).toBe(EVENT_AGENT_STATUS_UPDATED);
      expect(event.payload.workspaceRef).toBe(TEST_WORKSPACE_REF);
      expect(event.payload.projectId).toBe(TEST_PROJECT_ID);
      expect(event.payload.workspaceName).toBe(TEST_WORKSPACE_NAME);
      expect(event.payload.active).toBe(false);
      expect(event.payload.status).toEqual(status);
    });

    it("emits agent:status-updated with correct payload for idle", async () => {
      const { dispatcher } = createTestSetup();
      const receivedEvents: DomainEvent[] = [];
      dispatcher.subscribe(EVENT_AGENT_STATUS_UPDATED, (event) => {
        receivedEvents.push(event);
      });

      const status: AggregatedAgentStatus = { status: "idle", counts: { idle: 3, busy: 0 } };
      await dispatcher.dispatch(updateStatusIntent(TEST_WORKSPACE_REF, status));

      expect(receivedEvents).toHaveLength(1);
      const event = receivedEvents[0] as AgentStatusUpdatedEvent;
      expect(event.payload.workspaceRef).toBe(TEST_WORKSPACE_REF);
      expect(event.payload.status).toEqual(status);
    });

    it("emits agent:status-updated with correct payload for mixed", async () => {
      const { dispatcher } = createTestSetup();
      const receivedEvents: DomainEvent[] = [];
      dispatcher.subscribe(EVENT_AGENT_STATUS_UPDATED, (event) => {
        receivedEvents.push(event);
      });

      const status: AggregatedAgentStatus = { status: "mixed", counts: { idle: 1, busy: 2 } };
      await dispatcher.dispatch(updateStatusIntent(TEST_WORKSPACE_REF, status));

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
      await dispatcher.dispatch(updateStatusIntent(TEST_WORKSPACE_REF, status));

      expect(receivedEvents).toHaveLength(1);
      const event = receivedEvents[0] as AgentStatusUpdatedEvent;
      expect(event.payload.status).toEqual(status);
    });

    it("silently returns when the workspace is unknown", async () => {
      const dispatcher = createMockDispatcher();
      dispatcher.registerOperation(new UpdateAgentStatusOperation());

      // Empty lookups — resolve operations will throw, and update-agent-status
      // catches the error and silently returns.
      registerTestInfrastructure(dispatcher, { workspaces: {}, projects: {} });

      const receivedEvents: DomainEvent[] = [];
      dispatcher.subscribe(EVENT_AGENT_STATUS_UPDATED, (event) => {
        receivedEvents.push(event);
      });

      const status: AggregatedAgentStatus = { status: "busy", counts: { idle: 0, busy: 1 } };
      await dispatcher.dispatch(
        updateStatusIntent(workspaceRefIn(TEST_PROJECT_PATH, "unknown"), status)
      );

      expect(receivedEvents).toHaveLength(0);
    });
  });
});
