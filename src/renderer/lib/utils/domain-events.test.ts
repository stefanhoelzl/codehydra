/**
 * Tests for domain event subscription helper (v2 API).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ProjectId, WorkspaceName, Project, Workspace, WorkspaceRef } from "@shared/api/types";
import {
  setupDomainEventsV2,
  type DomainEventApiV2,
  type DomainStoresV2,
  type ApiEventsV2,
} from "./domain-events";
import { AgentNotificationService } from "$lib/services/agent-notifications";

// =============================================================================
// Test Data
// =============================================================================

const TEST_PROJECT_ID = "my-project-a1b2c3d4" as ProjectId;
const TEST_WORKSPACE_NAME = "feature-branch" as WorkspaceName;
const TEST_PROJECT_PATH = "/test/project";
const TEST_WORKSPACE_PATH = "/test/project/.worktrees/feature";

const TEST_PROJECT: Project = {
  id: TEST_PROJECT_ID,
  name: "my-project",
  path: TEST_PROJECT_PATH,
  workspaces: [],
};

const TEST_WORKSPACE: Workspace = {
  projectId: TEST_PROJECT_ID,
  name: TEST_WORKSPACE_NAME,
  branch: "feature-branch",
  baseBranch: "main",
  path: TEST_WORKSPACE_PATH,
};

const TEST_WORKSPACE_REF: WorkspaceRef = {
  projectId: TEST_PROJECT_ID,
  workspaceName: TEST_WORKSPACE_NAME,
  path: TEST_WORKSPACE_PATH,
};

// =============================================================================
// Mock API Factory
// =============================================================================

type EventHandler<E extends keyof ApiEventsV2> = ApiEventsV2[E];

function createMockApi(): {
  api: DomainEventApiV2;
  handlers: Map<keyof ApiEventsV2, EventHandler<keyof ApiEventsV2>>;
  emit: <E extends keyof ApiEventsV2>(event: E, ...args: Parameters<ApiEventsV2[E]>) => void;
} {
  const handlers = new Map<keyof ApiEventsV2, EventHandler<keyof ApiEventsV2>>();

  const api: DomainEventApiV2 = {
    on: vi.fn(<E extends keyof ApiEventsV2>(event: E, handler: ApiEventsV2[E]) => {
      handlers.set(event, handler as EventHandler<keyof ApiEventsV2>);
      return () => {
        handlers.delete(event);
      };
    }),
  };

  const emit = <E extends keyof ApiEventsV2>(
    event: E,
    ...args: Parameters<ApiEventsV2[E]>
  ): void => {
    const handler = handlers.get(event) as
      | ((...args: Parameters<ApiEventsV2[E]>) => void)
      | undefined;
    if (handler) {
      handler(...args);
    }
  };

  return { api, handlers, emit };
}

// =============================================================================
// Tests
// =============================================================================

describe("setupDomainEventsV2", () => {
  let mockApi: ReturnType<typeof createMockApi>;
  let mockStores: DomainStoresV2;

  beforeEach(() => {
    mockApi = createMockApi();

    mockStores = {
      addProject: vi.fn(),
      removeProject: vi.fn(),
      addWorkspace: vi.fn(),
      removeWorkspace: vi.fn(),
      setActiveWorkspace: vi.fn(),
      updateAgentStatus: vi.fn(),
    };
  });

  describe("project events", () => {
    it("calls addProject when project:opened is emitted", () => {
      setupDomainEventsV2(mockApi.api, mockStores);

      mockApi.emit("project:opened", { project: TEST_PROJECT });

      expect(mockStores.addProject).toHaveBeenCalledWith(TEST_PROJECT);
    });

    it("calls removeProject when project:closed is emitted", () => {
      setupDomainEventsV2(mockApi.api, mockStores);

      mockApi.emit("project:closed", { projectId: TEST_PROJECT_ID });

      expect(mockStores.removeProject).toHaveBeenCalledWith(TEST_PROJECT_ID);
    });
  });

  describe("workspace events", () => {
    it("calls addWorkspace and setActiveWorkspace when workspace:created is emitted", () => {
      setupDomainEventsV2(mockApi.api, mockStores);

      mockApi.emit("workspace:created", {
        projectId: TEST_PROJECT_ID,
        workspace: TEST_WORKSPACE,
      });

      expect(mockStores.addWorkspace).toHaveBeenCalledWith(TEST_PROJECT_ID, TEST_WORKSPACE);
      // Newly created workspace should be set as active
      expect(mockStores.setActiveWorkspace).toHaveBeenCalledWith({
        projectId: TEST_PROJECT_ID,
        workspaceName: TEST_WORKSPACE_NAME,
        path: TEST_WORKSPACE_PATH,
      });
    });

    it("calls removeWorkspace when workspace:removed is emitted", () => {
      setupDomainEventsV2(mockApi.api, mockStores);

      mockApi.emit("workspace:removed", TEST_WORKSPACE_REF);

      expect(mockStores.removeWorkspace).toHaveBeenCalledWith(TEST_WORKSPACE_REF);
    });

    it("calls setActiveWorkspace when workspace:switched is emitted", () => {
      setupDomainEventsV2(mockApi.api, mockStores);

      mockApi.emit("workspace:switched", TEST_WORKSPACE_REF);

      expect(mockStores.setActiveWorkspace).toHaveBeenCalledWith(TEST_WORKSPACE_REF);
    });

    it("calls setActiveWorkspace with null when workspace:switched emits null", () => {
      setupDomainEventsV2(mockApi.api, mockStores);

      mockApi.emit("workspace:switched", null);

      expect(mockStores.setActiveWorkspace).toHaveBeenCalledWith(null);
    });
  });

  describe("status events", () => {
    it("calls updateAgentStatus when workspace:status-changed is emitted", () => {
      setupDomainEventsV2(mockApi.api, mockStores);

      const status = {
        isDirty: false,
        agent: { type: "idle" as const, counts: { idle: 1, busy: 0, total: 1 } },
      };
      const event = { ...TEST_WORKSPACE_REF, status };

      mockApi.emit("workspace:status-changed", event);

      expect(mockStores.updateAgentStatus).toHaveBeenCalledWith(event, status);
    });
  });

  describe("hooks", () => {
    it("calls onProjectOpenedHook after addProject when provided", () => {
      const hookSpy = vi.fn();

      setupDomainEventsV2(mockApi.api, mockStores, {
        onProjectOpenedHook: hookSpy,
      });

      mockApi.emit("project:opened", { project: TEST_PROJECT });

      // Verify addProject was called first
      expect(mockStores.addProject).toHaveBeenCalledWith(TEST_PROJECT);
      // Verify hook was called with the project
      expect(hookSpy).toHaveBeenCalledWith(TEST_PROJECT);
    });

    it("works without hooks (backward compatible)", () => {
      expect(() => {
        setupDomainEventsV2(mockApi.api, mockStores);
      }).not.toThrow();

      mockApi.emit("project:opened", { project: TEST_PROJECT });

      expect(mockStores.addProject).toHaveBeenCalledWith(TEST_PROJECT);
    });
  });

  describe("cleanup", () => {
    it("returns cleanup function that unsubscribes all events", () => {
      const cleanup = setupDomainEventsV2(mockApi.api, mockStores);

      // Verify handlers were registered
      expect(mockApi.handlers.size).toBeGreaterThan(0);

      // Call cleanup
      cleanup();

      // Verify all handlers were removed
      expect(mockApi.handlers.size).toBe(0);
    });

    it("does not call stores after cleanup", () => {
      const cleanup = setupDomainEventsV2(mockApi.api, mockStores);

      cleanup();

      // Try to emit events after cleanup
      mockApi.emit("project:opened", { project: TEST_PROJECT });

      expect(mockStores.addProject).not.toHaveBeenCalled();
    });
  });

  describe("agent notifications", () => {
    let mockNotificationService: AgentNotificationService;

    beforeEach(() => {
      mockNotificationService = new AgentNotificationService();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("calls notification service on agent status change with counts", () => {
      const handleStatusChangeSpy = vi.spyOn(mockNotificationService, "handleStatusChange");

      setupDomainEventsV2(mockApi.api, mockStores, undefined, {
        notificationService: mockNotificationService,
      });

      const status = {
        isDirty: false,
        agent: { type: "idle" as const, counts: { idle: 1, busy: 0, total: 1 } },
      };
      mockApi.emit("workspace:status-changed", { ...TEST_WORKSPACE_REF, status });

      expect(handleStatusChangeSpy).toHaveBeenCalledWith(TEST_WORKSPACE_PATH, {
        idle: 1,
        busy: 0,
        total: 1,
      });
    });

    it("does not call notification service when agent type is none", () => {
      const handleStatusChangeSpy = vi.spyOn(mockNotificationService, "handleStatusChange");

      setupDomainEventsV2(mockApi.api, mockStores, undefined, {
        notificationService: mockNotificationService,
      });

      const status = {
        isDirty: false,
        agent: { type: "none" as const },
      };
      mockApi.emit("workspace:status-changed", { ...TEST_WORKSPACE_REF, status });

      expect(handleStatusChangeSpy).not.toHaveBeenCalled();
    });

    it("cleans up notification service when workspace is removed", () => {
      const removeWorkspaceSpy = vi.spyOn(mockNotificationService, "removeWorkspace");

      setupDomainEventsV2(mockApi.api, mockStores, undefined, {
        notificationService: mockNotificationService,
      });

      mockApi.emit("workspace:removed", TEST_WORKSPACE_REF);

      expect(removeWorkspaceSpy).toHaveBeenCalledWith(TEST_WORKSPACE_PATH);
    });

    it("calls notification service after updating store", () => {
      const callOrder: string[] = [];

      mockStores.updateAgentStatus = vi.fn(() => {
        callOrder.push("store");
      });

      vi.spyOn(mockNotificationService, "handleStatusChange").mockImplementation(() => {
        callOrder.push("notification");
      });

      setupDomainEventsV2(mockApi.api, mockStores, undefined, {
        notificationService: mockNotificationService,
      });

      const status = {
        isDirty: false,
        agent: { type: "busy" as const, counts: { idle: 0, busy: 2, total: 2 } },
      };
      mockApi.emit("workspace:status-changed", { ...TEST_WORKSPACE_REF, status });

      // Verify order: store update first, then notification
      expect(callOrder).toEqual(["store", "notification"]);
    });
  });
});
