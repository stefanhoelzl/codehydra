/**
 * Tests for domain event subscription helper (v2 API).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ProjectId, WorkspaceName, Project, Workspace, WorkspaceRef } from "@shared/api/types";
import {
  setupDomainEvents,
  type DomainEventApi,
  type DomainStores,
  type ApiEvents,
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
  metadata: { base: "main" },
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

// =============================================================================
// Tests
// =============================================================================

describe("setupDomainEvents", () => {
  let mockApi: ReturnType<typeof createMockApi>;
  let mockStores: DomainStores;

  beforeEach(() => {
    mockApi = createMockApi();

    mockStores = {
      addProject: vi.fn(),
      removeProject: vi.fn(),
      addWorkspace: vi.fn(),
      removeWorkspace: vi.fn(),
      setActiveWorkspace: vi.fn(),
      updateAgentStatus: vi.fn(),
      updateWorkspaceMetadata: vi.fn(),
    };
  });

  describe("project events", () => {
    it("calls addProject when project:opened is emitted", () => {
      setupDomainEvents(mockApi.api, mockStores);

      mockApi.emit("project:opened", { project: TEST_PROJECT });

      expect(mockStores.addProject).toHaveBeenCalledWith(TEST_PROJECT);
    });

    it("calls removeProject when project:closed is emitted", () => {
      setupDomainEvents(mockApi.api, mockStores);

      mockApi.emit("project:closed", { projectId: TEST_PROJECT_ID });

      expect(mockStores.removeProject).toHaveBeenCalledWith(TEST_PROJECT_ID);
    });
  });

  describe("workspace events", () => {
    it("calls addWorkspace and setActiveWorkspace when workspace:created is emitted", () => {
      setupDomainEvents(mockApi.api, mockStores);

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
      setupDomainEvents(mockApi.api, mockStores);

      mockApi.emit("workspace:removed", TEST_WORKSPACE_REF);

      expect(mockStores.removeWorkspace).toHaveBeenCalledWith(TEST_WORKSPACE_REF);
    });

    it("calls setActiveWorkspace when workspace:switched is emitted", () => {
      setupDomainEvents(mockApi.api, mockStores);

      mockApi.emit("workspace:switched", TEST_WORKSPACE_REF);

      expect(mockStores.setActiveWorkspace).toHaveBeenCalledWith(TEST_WORKSPACE_REF);
    });

    it("calls setActiveWorkspace with null when workspace:switched emits null", () => {
      setupDomainEvents(mockApi.api, mockStores);

      mockApi.emit("workspace:switched", null);

      expect(mockStores.setActiveWorkspace).toHaveBeenCalledWith(null);
    });
  });

  describe("status events", () => {
    it("calls updateAgentStatus when workspace:status-changed is emitted", () => {
      setupDomainEvents(mockApi.api, mockStores);

      const status = {
        isDirty: false,
        unmergedCommits: 0,
        agent: { type: "idle" as const, counts: { idle: 1, busy: 0, total: 1 } },
      };
      const event = { ...TEST_WORKSPACE_REF, status };

      mockApi.emit("workspace:status-changed", event);

      expect(mockStores.updateAgentStatus).toHaveBeenCalledWith(event, status);
    });
  });

  describe("metadata events", () => {
    it("calls updateWorkspaceMetadata when workspace:metadata-changed sets a key", () => {
      setupDomainEvents(mockApi.api, mockStores);

      mockApi.emit("workspace:metadata-changed", {
        projectId: TEST_PROJECT_ID,
        workspaceName: TEST_WORKSPACE_NAME,
        key: "tags.bugfix",
        value: "{}",
      });

      expect(mockStores.updateWorkspaceMetadata).toHaveBeenCalledWith(
        TEST_PROJECT_ID,
        TEST_WORKSPACE_NAME,
        "tags.bugfix",
        "{}"
      );
    });

    it("calls updateWorkspaceMetadata when workspace:metadata-changed deletes a key", () => {
      setupDomainEvents(mockApi.api, mockStores);

      mockApi.emit("workspace:metadata-changed", {
        projectId: TEST_PROJECT_ID,
        workspaceName: TEST_WORKSPACE_NAME,
        key: "tags.bugfix",
        value: null,
      });

      expect(mockStores.updateWorkspaceMetadata).toHaveBeenCalledWith(
        TEST_PROJECT_ID,
        TEST_WORKSPACE_NAME,
        "tags.bugfix",
        null
      );
    });
  });

  describe("hooks", () => {
    it("calls onProjectOpenedHook after addProject when provided", () => {
      const hookSpy = vi.fn();

      setupDomainEvents(mockApi.api, mockStores, {
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
        setupDomainEvents(mockApi.api, mockStores);
      }).not.toThrow();

      mockApi.emit("project:opened", { project: TEST_PROJECT });

      expect(mockStores.addProject).toHaveBeenCalledWith(TEST_PROJECT);
    });
  });

  describe("cleanup", () => {
    it("returns cleanup function that unsubscribes all events", () => {
      const cleanup = setupDomainEvents(mockApi.api, mockStores);

      // Verify handlers were registered
      expect(mockApi.handlers.size).toBeGreaterThan(0);

      // Call cleanup
      cleanup();

      // Verify all handlers were removed
      expect(mockApi.handlers.size).toBe(0);
    });

    it("does not call stores after cleanup", () => {
      const cleanup = setupDomainEvents(mockApi.api, mockStores);

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

      setupDomainEvents(mockApi.api, mockStores, undefined, {
        notificationService: mockNotificationService,
      });

      const status = {
        isDirty: false,
        unmergedCommits: 0,
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

      setupDomainEvents(mockApi.api, mockStores, undefined, {
        notificationService: mockNotificationService,
      });

      const status = {
        isDirty: false,
        unmergedCommits: 0,
        agent: { type: "none" as const },
      };
      mockApi.emit("workspace:status-changed", { ...TEST_WORKSPACE_REF, status });

      expect(handleStatusChangeSpy).not.toHaveBeenCalled();
    });

    it("cleans up notification service when workspace is removed", () => {
      const removeWorkspaceSpy = vi.spyOn(mockNotificationService, "removeWorkspace");

      setupDomainEvents(mockApi.api, mockStores, undefined, {
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

      setupDomainEvents(mockApi.api, mockStores, undefined, {
        notificationService: mockNotificationService,
      });

      const status = {
        isDirty: false,
        unmergedCommits: 0,
        agent: { type: "busy" as const, counts: { idle: 0, busy: 2, total: 2 } },
      };
      mockApi.emit("workspace:status-changed", { ...TEST_WORKSPACE_REF, status });

      // Verify order: store update first, then notification
      expect(callOrder).toEqual(["store", "notification"]);
    });
  });
});
