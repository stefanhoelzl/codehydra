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

// =============================================================================
// Test Setup
// =============================================================================

const TEST_PROJECT_ID = "test-project-id" as ProjectId;
const TEST_PROJECT_PATH = "/projects/test";
const TEST_WORKSPACE_NAME = "test-workspace" as WorkspaceName;

const TEST_WORKSPACE_ENTRY = {
  projectPath: TEST_PROJECT_PATH,
  workspaceName: TEST_WORKSPACE_NAME,
};

function createTestSetup(): { dispatcher: Dispatcher } {
  const dispatcher = createMockDispatcher();

  dispatcher.registerOperation(new UpdateAgentStatusOperation());

  registerTestInfrastructure(dispatcher, {
    // Every workspace path used by the tests resolves to the same project.
    workspaces: () => TEST_WORKSPACE_ENTRY,
    projects: { [TEST_PROJECT_PATH]: { projectId: TEST_PROJECT_ID } },
  });

  return { dispatcher };
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
      expect(event.payload.workspace.path).toBe("/workspace/test");
      expect(event.payload.workspace.projectId).toBe(TEST_PROJECT_ID);
      expect(event.payload.workspace.name).toBe(TEST_WORKSPACE_NAME);
      expect(event.payload.workspace.active).toBe(false);
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
      expect(event.payload.workspace.path).toBe("/workspace/idle-test");
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
      await dispatcher.dispatch(updateStatusIntent("/unknown/workspace", status));

      expect(receivedEvents).toHaveLength(0);
    });
  });
});
