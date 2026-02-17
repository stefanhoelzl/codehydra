/**
 * Tests for setupDomainEventBindings setup function.
 * Uses behavioral mocks that verify state changes, not call tracking.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  Project,
  Workspace,
  WorkspaceRef,
  ProjectId,
  WorkspaceName,
  WorkspaceStatus,
} from "@shared/api/types";

// Mock the API module before importing the setup function
vi.mock("$lib/api", () => ({
  on: vi.fn(() => vi.fn()),
}));

import { setupDomainEventBindings } from "./setup-domain-event-bindings";
import type { DomainEventApi, ApiEvents } from "./domain-events";
import * as projectsStore from "$lib/stores/projects.svelte.js";
import * as agentStatusStore from "$lib/stores/agent-status.svelte.js";
import * as dialogsStore from "$lib/stores/dialogs.svelte.js";
import * as workspaceLoadingStore from "$lib/stores/workspace-loading.svelte.js";
import { AgentNotificationService } from "$lib/services/agent-notifications";

// =============================================================================
// Test Data
// =============================================================================

const TEST_PROJECT_ID = "my-project-a1b2c3d4" as ProjectId;
const TEST_PROJECT_PATH = "/test/project";
const TEST_WORKSPACE_NAME = "feature-branch" as WorkspaceName;
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

describe("setupDomainEventBindings", () => {
  let mockApi: ReturnType<typeof createMockApi>;
  let notificationService: AgentNotificationService;

  beforeEach(() => {
    mockApi = createMockApi();
    notificationService = new AgentNotificationService();
    projectsStore.reset();
    agentStatusStore.reset();
    dialogsStore.reset();
    workspaceLoadingStore.reset();
  });

  afterEach(() => {
    projectsStore.reset();
    agentStatusStore.reset();
    dialogsStore.reset();
    workspaceLoadingStore.reset();
    vi.restoreAllMocks();
  });

  describe("project events", () => {
    it("adds project to store when project:opened is emitted", () => {
      setupDomainEventBindings(notificationService, mockApi.api);

      mockApi.emit("project:opened", { project: TEST_PROJECT });

      expect(projectsStore.projects.value).toContainEqual(TEST_PROJECT);
    });

    it("removes project from store when project:closed is emitted", () => {
      // Setup: add project first
      projectsStore.setProjects([TEST_PROJECT]);
      expect(projectsStore.projects.value).toContainEqual(TEST_PROJECT);

      setupDomainEventBindings(notificationService, mockApi.api);

      mockApi.emit("project:closed", { projectId: TEST_PROJECT_ID });

      expect(projectsStore.projects.value).not.toContainEqual(TEST_PROJECT);
    });

    it("auto-opens create dialog when project with no workspaces is opened after loading", () => {
      // Simulate post-startup state (loading complete)
      projectsStore.setLoaded();

      setupDomainEventBindings(notificationService, mockApi.api);

      mockApi.emit("project:opened", { project: TEST_PROJECT });

      expect(dialogsStore.dialogState.value).toEqual({
        type: "create",
        projectId: TEST_PROJECT_ID,
      });
    });

    it("does not auto-open create dialog during initial loading", () => {
      // loadingState is "loading" by default after reset
      expect(projectsStore.loadingState.value).toBe("loading");

      setupDomainEventBindings(notificationService, mockApi.api);

      mockApi.emit("project:opened", { project: TEST_PROJECT });

      // Dialog should NOT open during initial loading
      expect(dialogsStore.dialogState.value).toEqual({ type: "closed" });
    });

    it("does not open create dialog when project has workspaces", () => {
      setupDomainEventBindings(notificationService, mockApi.api);

      const projectWithWorkspaces: Project = {
        ...TEST_PROJECT,
        workspaces: [TEST_WORKSPACE],
      };
      mockApi.emit("project:opened", { project: projectWithWorkspaces });

      expect(dialogsStore.dialogState.value).toEqual({ type: "closed" });
    });

    it("does not open create dialog when another dialog is already open", () => {
      dialogsStore.openCloseProjectDialog(TEST_PROJECT_ID);

      setupDomainEventBindings(notificationService, mockApi.api);

      mockApi.emit("project:opened", { project: TEST_PROJECT });

      // Should still show close-project dialog, not create
      expect(dialogsStore.dialogState.value.type).toBe("close-project");
    });
  });

  describe("workspace events", () => {
    beforeEach(() => {
      // Setup: add project first so workspace events can find it
      projectsStore.setProjects([TEST_PROJECT]);
    });

    it("adds workspace to store when workspace:created is emitted", () => {
      setupDomainEventBindings(notificationService, mockApi.api);

      mockApi.emit("workspace:created", {
        projectId: TEST_PROJECT_ID,
        workspace: TEST_WORKSPACE,
      });

      const project = projectsStore.projects.value.find((p) => p.id === TEST_PROJECT_ID);
      expect(project?.workspaces).toContainEqual(TEST_WORKSPACE);
    });

    it("sets active workspace when workspace:created is emitted", () => {
      setupDomainEventBindings(notificationService, mockApi.api);

      mockApi.emit("workspace:created", {
        projectId: TEST_PROJECT_ID,
        workspace: TEST_WORKSPACE,
      });

      expect(projectsStore.activeWorkspacePath.value).toBe(TEST_WORKSPACE_PATH);
    });

    it("marks workspace as loading when workspace:created is emitted", () => {
      // This prevents a race condition where workspace:loading-changed might arrive
      // after workspace:created, causing the loading overlay to not show.
      setupDomainEventBindings(notificationService, mockApi.api);

      // Verify workspace is not loading initially
      expect(workspaceLoadingStore.isWorkspaceLoading(TEST_WORKSPACE_PATH)).toBe(false);

      mockApi.emit("workspace:created", {
        projectId: TEST_PROJECT_ID,
        workspace: TEST_WORKSPACE,
      });

      // Workspace should be marked as loading even without workspace:loading-changed event
      expect(workspaceLoadingStore.isWorkspaceLoading(TEST_WORKSPACE_PATH)).toBe(true);
    });

    it("removes workspace from store when workspace:removed is emitted", () => {
      // Setup: add workspace first
      projectsStore.addWorkspace(TEST_PROJECT_PATH, TEST_WORKSPACE);
      const project = projectsStore.projects.value.find((p) => p.id === TEST_PROJECT_ID);
      expect(project?.workspaces).toContainEqual(TEST_WORKSPACE);

      setupDomainEventBindings(notificationService, mockApi.api);

      mockApi.emit("workspace:removed", TEST_WORKSPACE_REF);

      const updatedProject = projectsStore.projects.value.find((p) => p.id === TEST_PROJECT_ID);
      expect(updatedProject?.workspaces).not.toContainEqual(TEST_WORKSPACE);
    });

    it("updates active workspace when workspace:switched is emitted", () => {
      setupDomainEventBindings(notificationService, mockApi.api);

      mockApi.emit("workspace:switched", TEST_WORKSPACE_REF);

      expect(projectsStore.activeWorkspacePath.value).toBe(TEST_WORKSPACE_PATH);
    });

    it("clears active workspace when workspace:switched emits null", () => {
      projectsStore.setActiveWorkspace(TEST_WORKSPACE_PATH);

      setupDomainEventBindings(notificationService, mockApi.api);

      mockApi.emit("workspace:switched", null);

      expect(projectsStore.activeWorkspacePath.value).toBeNull();
    });
  });

  describe("status events", () => {
    beforeEach(() => {
      projectsStore.setProjects([TEST_PROJECT]);
    });

    it("updates agent status store when workspace:status-changed is emitted", () => {
      setupDomainEventBindings(notificationService, mockApi.api);

      const status: WorkspaceStatus = {
        isDirty: false,
        agent: { type: "idle", counts: { idle: 1, busy: 0, total: 1 } },
      };
      mockApi.emit("workspace:status-changed", { ...TEST_WORKSPACE_REF, status });

      const storedStatus = agentStatusStore.getStatus(TEST_WORKSPACE_PATH);
      expect(storedStatus).toEqual({ type: "idle", counts: { idle: 1, busy: 0, total: 1 } });
    });

    it("handles agent type none without error", () => {
      setupDomainEventBindings(notificationService, mockApi.api);

      const status: WorkspaceStatus = {
        isDirty: false,
        agent: { type: "none" },
      };
      mockApi.emit("workspace:status-changed", { ...TEST_WORKSPACE_REF, status });

      const storedStatus = agentStatusStore.getStatus(TEST_WORKSPACE_PATH);
      expect(storedStatus).toEqual({ type: "none" });
    });
  });

  describe("cleanup", () => {
    it("unsubscribes all events when cleanup is called", () => {
      const cleanup = setupDomainEventBindings(notificationService, mockApi.api);

      // Verify handlers were registered
      expect(mockApi.handlers.size).toBeGreaterThan(0);

      cleanup();

      // Verify all handlers were removed
      expect(mockApi.handlers.size).toBe(0);
    });

    it("does not update stores after cleanup", () => {
      const cleanup = setupDomainEventBindings(notificationService, mockApi.api);

      cleanup();

      // Try to emit events after cleanup
      mockApi.emit("project:opened", { project: TEST_PROJECT });

      expect(projectsStore.projects.value).not.toContainEqual(TEST_PROJECT);
    });
  });
});
