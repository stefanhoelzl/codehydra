// @vitest-environment node
/**
 * Integration tests for IpcEventBridge agent:status-updated handling.
 *
 * Tests verify the full pipeline: dispatcher -> operation -> domain event -> IpcEventBridge -> registry.emit.
 *
 * Test plan items covered:
 * #2a: Renderer receives workspace status (idle)
 * #2b: Renderer receives workspace status (busy)
 * #2c: Renderer receives workspace status (mixed)
 * #2d: Renderer receives workspace status (none)
 */

import { describe, it, expect } from "vitest";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";
import { wireModules } from "../intents/infrastructure/wire";
import {
  UpdateAgentStatusOperation,
  INTENT_UPDATE_AGENT_STATUS,
} from "../operations/update-agent-status";
import type { UpdateAgentStatusIntent } from "../operations/update-agent-status";
import { createIpcEventBridge } from "./ipc-event-bridge";
import type { IApiRegistry } from "../api/registry-types";
import type { WorkspacePath, AggregatedAgentStatus } from "../../shared/ipc";
import type { ProjectId, WorkspaceName } from "../../shared/api/types";

// =============================================================================
// Mock ApiRegistry (behavioral mock with recorded events)
// =============================================================================

interface RecordedEvent {
  readonly channel: string;
  readonly data: unknown;
}

class MockApiRegistry {
  readonly events: RecordedEvent[] = [];

  emit(channel: string, data: unknown): void {
    this.events.push({ channel, data });
  }

  register(): void {
    // no-op
  }

  on(): () => void {
    return () => {};
  }

  getInterface(): undefined {
    return undefined;
  }

  async dispose(): Promise<void> {
    // no-op
  }
}

function createMockApiRegistry(): MockApiRegistry {
  return new MockApiRegistry();
}

// =============================================================================
// Test Setup
// =============================================================================

interface TestSetup {
  dispatcher: Dispatcher;
  mockApiRegistry: MockApiRegistry;
}

function createTestSetup(): TestSetup {
  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);

  dispatcher.registerOperation(INTENT_UPDATE_AGENT_STATUS, new UpdateAgentStatusOperation());

  const mockApiRegistry = createMockApiRegistry();
  const ipcEventBridge = createIpcEventBridge(mockApiRegistry as unknown as IApiRegistry);

  wireModules([ipcEventBridge], hookRegistry, dispatcher);

  return { dispatcher, mockApiRegistry };
}

const TEST_PROJECT_ID = "test-project-12345678" as ProjectId;
const TEST_WORKSPACE_NAME = "feature-branch" as WorkspaceName;
const TEST_WORKSPACE_PATH = "/projects/test/workspaces/feature-branch";

function updateStatusIntent(
  workspacePath: string,
  status: AggregatedAgentStatus,
  projectId: ProjectId = TEST_PROJECT_ID,
  workspaceName: WorkspaceName = TEST_WORKSPACE_NAME
): UpdateAgentStatusIntent {
  return {
    type: INTENT_UPDATE_AGENT_STATUS,
    payload: {
      workspacePath: workspacePath as WorkspacePath,
      projectId,
      workspaceName,
      status,
    },
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("IpcEventBridge - agent:status-updated", () => {
  describe("renderer receives workspace status (idle) (#2a)", () => {
    it("emits workspace:status-changed with idle agent status", async () => {
      const { dispatcher, mockApiRegistry } = createTestSetup();

      const status: AggregatedAgentStatus = { status: "idle", counts: { idle: 2, busy: 0 } };
      await dispatcher.dispatch(updateStatusIntent(TEST_WORKSPACE_PATH, status));

      expect(mockApiRegistry.events).toEqual([
        {
          channel: "workspace:status-changed",
          data: {
            projectId: TEST_PROJECT_ID,
            workspaceName: TEST_WORKSPACE_NAME,
            path: TEST_WORKSPACE_PATH,
            status: {
              isDirty: false,
              agent: { type: "idle", counts: { idle: 2, busy: 0, total: 2 } },
            },
          },
        },
      ]);
    });
  });

  describe("renderer receives workspace status (busy) (#2b)", () => {
    it("emits workspace:status-changed with busy agent status", async () => {
      const { dispatcher, mockApiRegistry } = createTestSetup();

      const status: AggregatedAgentStatus = { status: "busy", counts: { idle: 0, busy: 3 } };
      await dispatcher.dispatch(updateStatusIntent(TEST_WORKSPACE_PATH, status));

      expect(mockApiRegistry.events).toEqual([
        {
          channel: "workspace:status-changed",
          data: {
            projectId: TEST_PROJECT_ID,
            workspaceName: TEST_WORKSPACE_NAME,
            path: TEST_WORKSPACE_PATH,
            status: {
              isDirty: false,
              agent: { type: "busy", counts: { idle: 0, busy: 3, total: 3 } },
            },
          },
        },
      ]);
    });
  });

  describe("renderer receives workspace status (mixed) (#2c)", () => {
    it("emits workspace:status-changed with mixed agent status", async () => {
      const { dispatcher, mockApiRegistry } = createTestSetup();

      const status: AggregatedAgentStatus = { status: "mixed", counts: { idle: 1, busy: 2 } };
      await dispatcher.dispatch(updateStatusIntent(TEST_WORKSPACE_PATH, status));

      expect(mockApiRegistry.events).toEqual([
        {
          channel: "workspace:status-changed",
          data: {
            projectId: TEST_PROJECT_ID,
            workspaceName: TEST_WORKSPACE_NAME,
            path: TEST_WORKSPACE_PATH,
            status: {
              isDirty: false,
              agent: { type: "mixed", counts: { idle: 1, busy: 2, total: 3 } },
            },
          },
        },
      ]);
    });
  });

  describe("renderer receives workspace status (none) (#2d)", () => {
    it("emits workspace:status-changed with none agent status (no counts field)", async () => {
      const { dispatcher, mockApiRegistry } = createTestSetup();

      const status: AggregatedAgentStatus = { status: "none", counts: { idle: 0, busy: 0 } };
      await dispatcher.dispatch(updateStatusIntent(TEST_WORKSPACE_PATH, status));

      expect(mockApiRegistry.events).toEqual([
        {
          channel: "workspace:status-changed",
          data: {
            projectId: TEST_PROJECT_ID,
            workspaceName: TEST_WORKSPACE_NAME,
            path: TEST_WORKSPACE_PATH,
            status: {
              isDirty: false,
              agent: { type: "none" },
            },
          },
        },
      ]);
    });
  });
});
