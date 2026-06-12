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
import { asWorkspaceRef, createMockProject, createMockWorkspace } from "@shared/test-fixtures";

// Mock the API module before importing the setup function
vi.mock("$lib/api", () => ({
  emitEvent: vi.fn(),
  on: vi.fn(() => vi.fn()),
}));

import { setupDomainEventBindings, type DomainEventApi } from "./setup-domain-event-bindings";
import type { ApiEvents } from "@shared/api/interfaces";
import * as projectsStore from "$lib/stores/projects.svelte.js";
import * as bootstrapStore from "$lib/stores/bootstrap.svelte.js";
import * as agentStatusStore from "$lib/stores/agent-status.svelte.js";
import * as dialogsStore from "$lib/stores/dialogs.svelte.js";
import * as newWorkspaceViewStore from "$lib/stores/new-workspace-view.svelte.js";
import * as lifecycleStore from "$lib/stores/workspace-lifecycle.svelte.js";
import { AgentNotificationService } from "$lib/services/agent-notifications";

// =============================================================================
// Test Data
// =============================================================================

const TEST_PROJECT_ID = "my-project-a1b2c3d4" as ProjectId;
const TEST_PROJECT_PATH = "/test/project";
const TEST_WORKSPACE_NAME = "feature-branch" as WorkspaceName;
const TEST_WORKSPACE_PATH = "/test/project/.worktrees/feature";

const TEST_PROJECT: Project = createMockProject({
  id: TEST_PROJECT_ID,
  name: "my-project",
  path: TEST_PROJECT_PATH,
  workspaces: [],
});

const TEST_WORKSPACE: Workspace = createMockWorkspace({
  projectId: TEST_PROJECT_ID,
  name: TEST_WORKSPACE_NAME,
  metadata: { base: "main" },
  path: TEST_WORKSPACE_PATH,
});

const TEST_WORKSPACE_REF: WorkspaceRef = asWorkspaceRef(
  TEST_PROJECT_ID,
  TEST_WORKSPACE_NAME,
  TEST_WORKSPACE_PATH
);

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
    bootstrapStore.resetBootstrap();
    agentStatusStore.reset();
    dialogsStore.reset();
    newWorkspaceViewStore.reset();
  });

  afterEach(() => {
    projectsStore.reset();
    bootstrapStore.resetBootstrap();
    agentStatusStore.reset();
    dialogsStore.reset();
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

    it("never auto-opens the New workspace view on project:opened (background clones land silently)", () => {
      // Simulate post-startup state (loading complete)
      bootstrapStore.setBootstrap({ defaultAgent: null, availableAgents: [] });

      setupDomainEventBindings(notificationService, mockApi.api);

      mockApi.emit("project:opened", { project: TEST_PROJECT });

      expect(projectsStore.projects.value).toContainEqual(TEST_PROJECT);
      expect(newWorkspaceViewStore.newWorkspaceView.isOpen).toBe(false);
    });
  });

  describe("bases-updated events", () => {
    it("updates the project's defaultBaseBranch when project:bases-updated is emitted", () => {
      projectsStore.setProjects([{ ...TEST_PROJECT, defaultBaseBranch: "origin/master" }]);
      setupDomainEventBindings(notificationService, mockApi.api);

      mockApi.emit("project:bases-updated", {
        projectId: TEST_PROJECT_ID,
        projectPath: TEST_PROJECT.path,
        bases: [{ name: "origin/main", isRemote: true }],
        defaultBaseBranch: "origin/main",
      });

      expect(projectsStore.projects.value[0]?.defaultBaseBranch).toBe("origin/main");
    });

    it("clears the project's defaultBaseBranch when the event carries none", () => {
      projectsStore.setProjects([{ ...TEST_PROJECT, defaultBaseBranch: "origin/master" }]);
      setupDomainEventBindings(notificationService, mockApi.api);

      mockApi.emit("project:bases-updated", {
        projectId: TEST_PROJECT_ID,
        projectPath: TEST_PROJECT.path,
        bases: [{ name: "develop", isRemote: false }],
      });

      expect(projectsStore.projects.value[0]?.defaultBaseBranch).toBeUndefined();
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
        unmergedCommits: 0,
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
        unmergedCommits: 0,
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

  describe("workspace:loading optimistic placeholder", () => {
    const pendingPath = lifecycleStore.createPendingPath(TEST_PROJECT_PATH, "new-feature");

    beforeEach(() => {
      lifecycleStore.reset();
      projectsStore.addProject(TEST_PROJECT);
    });

    it("creates the placeholder, marks it creating, switches to it, and closes the view", () => {
      newWorkspaceViewStore.openNewWorkspaceView();
      setupDomainEventBindings(notificationService, mockApi.api);

      mockApi.emit("workspace:loading", {
        workspaceName: "new-feature",
        projectPath: TEST_PROJECT_PATH,
        base: "main",
      });

      const project = projectsStore.projects.value.find((p) => p.path === TEST_PROJECT_PATH)!;
      const placeholder = project.workspaces.find((w) => w.path === pendingPath);
      expect(placeholder).toMatchObject({ name: "new-feature", branch: "main" });
      expect(lifecycleStore.getLifecycle(pendingPath)).toBe("creating");
      expect(projectsStore.activeWorkspacePath.value).toBe(pendingPath);
      expect(newWorkspaceViewStore.newWorkspaceView.isOpen).toBe(false);
    });

    it("skips wakes/reopens: a workspace with that name already exists", () => {
      projectsStore.addWorkspace(TEST_PROJECT_PATH, {
        ...TEST_WORKSPACE,
        name: "new-feature" as WorkspaceName,
        path: "/test/project/.worktrees/new-feature",
      });
      setupDomainEventBindings(notificationService, mockApi.api);

      mockApi.emit("workspace:loading", {
        workspaceName: "new-feature",
        projectPath: TEST_PROJECT_PATH,
      });

      const project = projectsStore.projects.value.find((p) => p.path === TEST_PROJECT_PATH)!;
      expect(project.workspaces.some((w) => w.path === pendingPath)).toBe(false);
      expect(lifecycleStore.getLifecycle(pendingPath)).toBe("none");
    });

    it("ignores events for unknown projects", () => {
      setupDomainEventBindings(notificationService, mockApi.api);

      mockApi.emit("workspace:loading", {
        workspaceName: "new-feature",
        projectPath: "/unknown/project",
      });

      expect(lifecycleStore.lifecycleEntries.value.size).toBe(0);
    });

    it("workspace:create-failed rolls back the placeholder", () => {
      setupDomainEventBindings(notificationService, mockApi.api);

      mockApi.emit("workspace:loading", {
        workspaceName: "new-feature",
        projectPath: TEST_PROJECT_PATH,
        base: "main",
      });
      expect(projectsStore.activeWorkspacePath.value).toBe(pendingPath);

      mockApi.emit("workspace:create-failed", {
        workspaceName: "new-feature",
        projectPath: TEST_PROJECT_PATH,
        error: "boom",
      });

      const project = projectsStore.projects.value.find((p) => p.path === TEST_PROJECT_PATH)!;
      expect(project.workspaces.some((w) => w.path === pendingPath)).toBe(false);
      expect(lifecycleStore.getLifecycle(pendingPath)).toBe("none");
      expect(projectsStore.activeWorkspacePath.value).toBeNull();
    });

    it("workspace:create-failed without a placeholder is a no-op", () => {
      setupDomainEventBindings(notificationService, mockApi.api);

      mockApi.emit("workspace:create-failed", {
        workspaceName: "never-started",
        projectPath: TEST_PROJECT_PATH,
        error: "boom",
      });

      expect(lifecycleStore.lifecycleEntries.value.size).toBe(0);
    });
  });
});
