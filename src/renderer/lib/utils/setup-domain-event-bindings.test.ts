/**
 * Tests for setupDomainEventBindings.
 *
 * Since the read cutover the bindings only drive the agent notification
 * chime — read-model state arrives via ui:state snapshots instead.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorkspaceStatus } from "@shared/api/types";
import { asWorkspaceRef } from "@shared/test-fixtures";
import type { ProjectId, WorkspaceName } from "@shared/api/types";

// Mock the API module before importing the setup function
vi.mock("$lib/api", () => ({
  emitEvent: vi.fn(),
  on: vi.fn(() => vi.fn()),
}));

import { setupDomainEventBindings, type DomainEventApi } from "./setup-domain-event-bindings";
import type { ApiEvents } from "@shared/api/interfaces";
import { AgentNotificationService } from "$lib/services/agent-notifications";

const TEST_PROJECT_ID = "my-project-a1b2c3d4" as ProjectId;
const TEST_WORKSPACE_NAME = "feature-branch" as WorkspaceName;
const TEST_WORKSPACE_PATH = "/test/project/.worktrees/feature";
const TEST_WORKSPACE_REF = asWorkspaceRef(
  TEST_PROJECT_ID,
  TEST_WORKSPACE_NAME,
  TEST_WORKSPACE_PATH
);

type EventHandler<E extends keyof ApiEvents> = ApiEvents[E];

function createMockApi(): {
  api: DomainEventApi;
  handlers: Map<keyof ApiEvents, EventHandler<keyof ApiEvents>>;
  emit: <E extends keyof ApiEvents>(event: E, ...args: Parameters<ApiEvents[E]>) => void;
} {
  const handlers = new Map<keyof ApiEvents, EventHandler<keyof ApiEvents>>();

  const api: DomainEventApi = {
    on: vi.fn(<E extends keyof ApiEvents>(event: E, handler: ApiEvents[E]) => {
      handlers.set(event, handler as EventHandler<keyof ApiEvents>);
      return () => {
        handlers.delete(event);
      };
    }),
  };

  const emit = <E extends keyof ApiEvents>(event: E, ...args: Parameters<ApiEvents[E]>): void => {
    const handler = handlers.get(event) as
      | ((...args: Parameters<ApiEvents[E]>) => void)
      | undefined;
    if (handler) {
      handler(...args);
    }
  };

  return { api, handlers, emit };
}

function statusEvent(
  idle: number,
  busy: number
): Parameters<ApiEvents["workspace:status-changed"]>[0] {
  return {
    ...TEST_WORKSPACE_REF,
    status: {
      isDirty: false,
      unmergedCommits: 0,
      agent: { type: "busy", counts: { idle, busy, total: idle + busy } },
    } as WorkspaceStatus,
  };
}

describe("setupDomainEventBindings", () => {
  let notificationService: AgentNotificationService;

  beforeEach(() => {
    notificationService = new AgentNotificationService();
    vi.spyOn(notificationService, "handleStatusChange");
    vi.spyOn(notificationService, "removeWorkspace");
  });

  it("forwards status counts to the notification service", () => {
    const { api, emit } = createMockApi();
    setupDomainEventBindings(notificationService, api);

    emit("workspace:status-changed", statusEvent(1, 2));

    expect(notificationService.handleStatusChange).toHaveBeenCalledWith(TEST_WORKSPACE_PATH, {
      idle: 1,
      busy: 2,
      total: 3,
    });
  });

  it("treats agent 'none' as zero counts (gray → green later still chimes)", () => {
    const { api, emit } = createMockApi();
    setupDomainEventBindings(notificationService, api);

    emit("workspace:status-changed", {
      ...TEST_WORKSPACE_REF,
      status: { isDirty: false, unmergedCommits: 0, agent: { type: "none" } } as WorkspaceStatus,
    });

    expect(notificationService.handleStatusChange).toHaveBeenCalledWith(TEST_WORKSPACE_PATH, {
      idle: 0,
      busy: 0,
    });
  });

  it("drops chime tracking when a workspace is removed", () => {
    const { api, emit } = createMockApi();
    setupDomainEventBindings(notificationService, api);

    emit("workspace:removed", TEST_WORKSPACE_REF);

    expect(notificationService.removeWorkspace).toHaveBeenCalledWith(TEST_WORKSPACE_PATH);
  });

  it("unsubscribes all events when cleanup is called", () => {
    const { api, handlers, emit } = createMockApi();
    const cleanup = setupDomainEventBindings(notificationService, api);

    expect(handlers.size).toBeGreaterThan(0);
    cleanup();
    expect(handlers.size).toBe(0);

    emit("workspace:status-changed", statusEvent(1, 0));
    expect(notificationService.handleStatusChange).not.toHaveBeenCalled();
  });
});
