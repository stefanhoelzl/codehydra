/**
 * Tests for domain event subscription helper.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  Project,
  ProjectPath,
  AgentStatusChangedEvent,
  WorkspaceRemovedEvent,
  WorkspaceCreatedEvent,
  WorkspacePath,
} from "@shared/ipc";
import { setupDomainEvents, type DomainEventApi, type DomainStores } from "./domain-events";
import { AgentNotificationService } from "$lib/services/agent-notifications";

// Helper to create typed ProjectPath
function asProjectPath(path: string): ProjectPath {
  return path as ProjectPath;
}

describe("setupDomainEvents", () => {
  let mockApi: DomainEventApi;
  let mockStores: DomainStores;
  let projectOpenedCallback: ((event: { project: Project }) => void) | null = null;

  beforeEach(() => {
    projectOpenedCallback = null;

    // Create mock API with captured callbacks
    mockApi = {
      onProjectOpened: vi.fn((cb) => {
        projectOpenedCallback = cb;
        return vi.fn();
      }),
      onProjectClosed: vi.fn(() => vi.fn()),
      onWorkspaceCreated: vi.fn(() => vi.fn()),
      onWorkspaceRemoved: vi.fn(() => vi.fn()),
      onWorkspaceSwitched: vi.fn(() => vi.fn()),
      onAgentStatusChanged: vi.fn(() => vi.fn()),
    };

    // Create mock stores
    mockStores = {
      addProject: vi.fn(),
      removeProject: vi.fn(),
      addWorkspace: vi.fn(),
      removeWorkspace: vi.fn(),
      setActiveWorkspace: vi.fn(),
      updateAgentStatus: vi.fn(),
    };
  });

  describe("hooks", () => {
    it("calls onProjectOpenedHook after addProject when provided", () => {
      const hookSpy = vi.fn();

      setupDomainEvents(mockApi, mockStores, {
        onProjectOpenedHook: hookSpy,
      });

      // Simulate project opened event
      const newProject: Project = {
        path: asProjectPath("/test/project"),
        name: "test-project",
        workspaces: [],
      };
      projectOpenedCallback!({ project: newProject });

      // Verify addProject was called first
      expect(mockStores.addProject).toHaveBeenCalledWith(newProject);
      // Verify hook was called with the project
      expect(hookSpy).toHaveBeenCalledWith(newProject);
    });

    it("works without hooks (backward compatible)", () => {
      // Should not throw when no hooks provided
      expect(() => {
        setupDomainEvents(mockApi, mockStores);
      }).not.toThrow();

      // Simulate project opened event
      const newProject: Project = {
        path: asProjectPath("/test/project"),
        name: "test-project",
        workspaces: [],
      };
      projectOpenedCallback!({ project: newProject });

      // Verify addProject was still called
      expect(mockStores.addProject).toHaveBeenCalledWith(newProject);
    });

    it("does not call hook when not provided", () => {
      setupDomainEvents(mockApi, mockStores);

      // Simulate project opened event
      const newProject: Project = {
        path: asProjectPath("/test/project"),
        name: "test-project",
        workspaces: [],
      };

      // This should not throw even though no hook is provided
      expect(() => {
        projectOpenedCallback!({ project: newProject });
      }).not.toThrow();
    });
  });

  describe("cleanup", () => {
    it("returns cleanup function that unsubscribes all events", () => {
      const unsubFns = {
        projectOpened: vi.fn(),
        projectClosed: vi.fn(),
        workspaceCreated: vi.fn(),
        workspaceRemoved: vi.fn(),
        workspaceSwitched: vi.fn(),
        agentStatusChanged: vi.fn(),
      };

      mockApi.onProjectOpened = vi.fn(() => unsubFns.projectOpened);
      mockApi.onProjectClosed = vi.fn(() => unsubFns.projectClosed);
      mockApi.onWorkspaceCreated = vi.fn(() => unsubFns.workspaceCreated);
      mockApi.onWorkspaceRemoved = vi.fn(() => unsubFns.workspaceRemoved);
      mockApi.onWorkspaceSwitched = vi.fn(() => unsubFns.workspaceSwitched);
      mockApi.onAgentStatusChanged = vi.fn(() => unsubFns.agentStatusChanged);

      const cleanup = setupDomainEvents(mockApi, mockStores);

      // Call cleanup
      cleanup();

      // Verify all unsubscribe functions were called
      expect(unsubFns.projectOpened).toHaveBeenCalled();
      expect(unsubFns.projectClosed).toHaveBeenCalled();
      expect(unsubFns.workspaceCreated).toHaveBeenCalled();
      expect(unsubFns.workspaceRemoved).toHaveBeenCalled();
      expect(unsubFns.workspaceSwitched).toHaveBeenCalled();
      expect(unsubFns.agentStatusChanged).toHaveBeenCalled();
    });
  });

  describe("agent notifications", () => {
    let agentStatusCallback: ((event: AgentStatusChangedEvent) => void) | null = null;
    let mockNotificationService: AgentNotificationService;

    beforeEach(() => {
      agentStatusCallback = null;
      // Create a fresh mock notification service for each test
      mockNotificationService = new AgentNotificationService();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("calls notification service on agent status change", () => {
      const handleStatusChangeSpy = vi.spyOn(mockNotificationService, "handleStatusChange");

      mockApi.onAgentStatusChanged = vi.fn((cb) => {
        agentStatusCallback = cb;
        return vi.fn();
      });

      setupDomainEvents(mockApi, mockStores, undefined, {
        notificationService: mockNotificationService,
      });

      // Simulate agent status change event
      const event: AgentStatusChangedEvent = {
        workspacePath: "/test/workspace" as WorkspacePath,
        status: { status: "idle", counts: { idle: 1, busy: 0 } },
      };
      agentStatusCallback!(event);

      // Verify notification service was called with workspace path and counts
      expect(handleStatusChangeSpy).toHaveBeenCalledWith("/test/workspace", { idle: 1, busy: 0 });
    });

    it("calls notification service after updating store", () => {
      const callOrder: string[] = [];

      mockStores.updateAgentStatus = vi.fn(() => {
        callOrder.push("store");
      });

      vi.spyOn(mockNotificationService, "handleStatusChange").mockImplementation(() => {
        callOrder.push("notification");
      });

      mockApi.onAgentStatusChanged = vi.fn((cb) => {
        agentStatusCallback = cb;
        return vi.fn();
      });

      setupDomainEvents(mockApi, mockStores, undefined, {
        notificationService: mockNotificationService,
      });

      // Simulate agent status change event
      const event: AgentStatusChangedEvent = {
        workspacePath: "/test/workspace" as WorkspacePath,
        status: { status: "busy", counts: { idle: 0, busy: 2 } },
      };
      agentStatusCallback!(event);

      // Verify order: store update first, then notification
      expect(callOrder).toEqual(["store", "notification"]);
    });
  });

  describe("workspace creation", () => {
    let workspaceCreatedCallback: ((event: WorkspaceCreatedEvent) => void) | null = null;

    beforeEach(() => {
      workspaceCreatedCallback = null;
      mockApi.onWorkspaceCreated = vi.fn((cb) => {
        workspaceCreatedCallback = cb;
        return vi.fn();
      });
    });

    it("adds workspace and sets it as active when created", () => {
      setupDomainEvents(mockApi, mockStores);

      const event: WorkspaceCreatedEvent = {
        projectPath: "/test/project" as ProjectPath,
        workspace: {
          path: "/test/project/.worktrees/feature",
          name: "feature",
          branch: "feature",
        },
      };
      workspaceCreatedCallback!(event);

      // Verify workspace was added (with undefined defaultBaseBranch since not in event)
      expect(mockStores.addWorkspace).toHaveBeenCalledWith(
        "/test/project",
        event.workspace,
        undefined
      );
      // Verify it was set as active (UI decides new workspace should be selected)
      expect(mockStores.setActiveWorkspace).toHaveBeenCalledWith(
        "/test/project/.worktrees/feature"
      );
    });

    it("passes defaultBaseBranch to addWorkspace when provided in event", () => {
      setupDomainEvents(mockApi, mockStores);

      const event: WorkspaceCreatedEvent = {
        projectPath: "/test/project" as ProjectPath,
        workspace: {
          path: "/test/project/.worktrees/feature",
          name: "feature",
          branch: "feature",
        },
        defaultBaseBranch: "develop",
      };
      workspaceCreatedCallback!(event);

      // Verify workspace was added with defaultBaseBranch
      expect(mockStores.addWorkspace).toHaveBeenCalledWith(
        "/test/project",
        event.workspace,
        "develop"
      );
    });
  });

  describe("workspace removal cleanup", () => {
    let workspaceRemovedCallback: ((event: WorkspaceRemovedEvent) => void) | null = null;
    let mockNotificationService: AgentNotificationService;

    beforeEach(() => {
      workspaceRemovedCallback = null;
      mockNotificationService = new AgentNotificationService();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("cleans up notification service when workspace is removed", () => {
      const removeWorkspaceSpy = vi.spyOn(mockNotificationService, "removeWorkspace");

      mockApi.onWorkspaceRemoved = vi.fn((cb) => {
        workspaceRemovedCallback = cb;
        return vi.fn();
      });

      setupDomainEvents(mockApi, mockStores, undefined, {
        notificationService: mockNotificationService,
      });

      // Simulate workspace removed event
      const event: WorkspaceRemovedEvent = {
        projectPath: "/test/project" as ProjectPath,
        workspacePath: "/test/workspace" as WorkspacePath,
      };
      workspaceRemovedCallback!(event);

      // Verify notification service cleanup was called
      expect(removeWorkspaceSpy).toHaveBeenCalledWith("/test/workspace");
    });
  });
});
