/**
 * Tests for initializeApp setup function.
 * Uses behavioral mocks that verify state changes, not call tracking.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  Project,
  Workspace,
  WorkspaceStatus,
  ProjectId,
  WorkspaceName,
} from "@shared/api/types";

// Mock the API module before importing the setup function
vi.mock("$lib/api", () => ({
  projects: { list: vi.fn() },
  workspaces: { getStatus: vi.fn() },
  ui: { getActiveWorkspace: vi.fn() },
}));

import { initializeApp, type InitializeAppApi, type InitializeAppOptions } from "./initialize-app";
import * as projectsStore from "$lib/stores/projects.svelte.js";
import * as agentStatusStore from "$lib/stores/agent-status.svelte.js";
import { AgentNotificationService } from "$lib/services/agent-notifications";

// =============================================================================
// Test Data
// =============================================================================

const TEST_PROJECT_ID = "my-project-a1b2c3d4" as ProjectId;
const TEST_PROJECT_PATH = "/test/project";
const TEST_WORKSPACE_NAME = "feature-branch" as WorkspaceName;
const TEST_WORKSPACE_PATH = "/test/project/.worktrees/feature";

const TEST_WORKSPACE: Workspace = {
  projectId: TEST_PROJECT_ID,
  name: TEST_WORKSPACE_NAME,
  branch: "feature-branch",
  metadata: { base: "main" },
  path: TEST_WORKSPACE_PATH,
};

const TEST_PROJECT: Project = {
  id: TEST_PROJECT_ID,
  name: "my-project",
  path: TEST_PROJECT_PATH,
  workspaces: [TEST_WORKSPACE],
};

const TEST_STATUS: WorkspaceStatus = {
  isDirty: false,
  agent: { type: "idle", counts: { idle: 1, busy: 0, total: 1 } },
};

// =============================================================================
// Mock API Factory
// =============================================================================

function createMockApi(config?: {
  projects?: Project[];
  activeWorkspace?: { path: string } | null;
  statusError?: Error;
  projectsError?: Error;
}): InitializeAppApi {
  const projectList = config?.projects ?? [TEST_PROJECT];
  // Use "in" check because ?? treats explicit null as needing fallback
  const activeWorkspace =
    config && "activeWorkspace" in config ? config.activeWorkspace : { path: TEST_WORKSPACE_PATH };

  return {
    projects: {
      list: vi.fn(async () => {
        if (config?.projectsError) {
          throw config.projectsError;
        }
        return projectList;
      }),
    },
    workspaces: {
      getStatus: vi.fn(async () => {
        if (config?.statusError) {
          throw config.statusError;
        }
        return TEST_STATUS;
      }),
    },
    ui: {
      getActiveWorkspace: vi.fn(async () => activeWorkspace),
    },
  };
}

// =============================================================================
// Mock Container Factory
// =============================================================================

function createMockContainer(focusableElement?: string): HTMLElement {
  const container = document.createElement("div");

  if (focusableElement === "vscode-button") {
    const button = document.createElement("vscode-button") as HTMLElement;
    button.setAttribute("tabindex", "0");
    container.appendChild(button);
  } else if (focusableElement === "button") {
    const button = document.createElement("button");
    container.appendChild(button);
  } else if (focusableElement === "input") {
    const input = document.createElement("input");
    container.appendChild(input);
  }

  document.body.appendChild(container);
  return container;
}

// =============================================================================
// Tests
// =============================================================================

describe("initializeApp", () => {
  let notificationService: AgentNotificationService;

  beforeEach(() => {
    notificationService = new AgentNotificationService();
    projectsStore.reset();
    agentStatusStore.reset();
  });

  afterEach(() => {
    projectsStore.reset();
    agentStatusStore.reset();
    vi.restoreAllMocks();
    // Clean up any containers
    document.body.innerHTML = "";
  });

  describe("project loading", () => {
    it("loads projects into store", async () => {
      const api = createMockApi({ projects: [TEST_PROJECT] });
      const options: InitializeAppOptions = {
        containerRef: undefined,
        notificationService,
      };

      await initializeApp(options, api);

      expect(projectsStore.projects.value).toContainEqual(TEST_PROJECT);
      expect(projectsStore.loadingState.value).toBe("loaded");
    });

    it("sets active workspace from API response", async () => {
      const api = createMockApi({
        projects: [TEST_PROJECT],
        activeWorkspace: { path: TEST_WORKSPACE_PATH },
      });
      const options: InitializeAppOptions = {
        containerRef: undefined,
        notificationService,
      };

      await initializeApp(options, api);

      expect(projectsStore.activeWorkspacePath.value).toBe(TEST_WORKSPACE_PATH);
    });

    it("handles null active workspace", async () => {
      // Explicitly reset to ensure clean state
      projectsStore.reset();

      const api = createMockApi({
        projects: [TEST_PROJECT],
        activeWorkspace: null,
      });
      const options: InitializeAppOptions = {
        containerRef: undefined,
        notificationService,
      };

      await initializeApp(options, api);

      expect(projectsStore.activeWorkspacePath.value).toBeNull();
    });

    it("sets error state when project loading fails", async () => {
      const api = createMockApi({
        projectsError: new Error("Network error"),
      });
      const options: InitializeAppOptions = {
        containerRef: undefined,
        notificationService,
      };

      await initializeApp(options, api);

      expect(projectsStore.loadingState.value).toBe("error");
      expect(projectsStore.loadingError.value).toBe("Network error");
    });
  });

  describe("agent status fetching", () => {
    it("fetches and sets agent statuses for all workspaces", async () => {
      const api = createMockApi({ projects: [TEST_PROJECT] });
      const options: InitializeAppOptions = {
        containerRef: undefined,
        notificationService,
      };

      await initializeApp(options, api);

      const status = agentStatusStore.getStatus(TEST_WORKSPACE_PATH);
      expect(status).toEqual(TEST_STATUS.agent);
    });

    it("seeds notification service with initial counts", async () => {
      const seedSpy = vi.spyOn(notificationService, "seedInitialCounts");
      const api = createMockApi({ projects: [TEST_PROJECT] });
      const options: InitializeAppOptions = {
        containerRef: undefined,
        notificationService,
      };

      await initializeApp(options, api);

      // This tests integration behavior, not just call tracking:
      // We verify the notification service was seeded with the correctly transformed
      // agent status data (counts extracted from the status response). This ensures
      // the initialization flow properly integrates the status fetch with the
      // notification system's chime detection baseline.
      expect(seedSpy).toHaveBeenCalledWith({
        [TEST_WORKSPACE_PATH]: { idle: 1, busy: 0 },
      });
    });

    it("continues initialization when status fetch fails", async () => {
      const api = createMockApi({
        projects: [TEST_PROJECT],
        statusError: new Error("Status fetch failed"),
      });
      const options: InitializeAppOptions = {
        containerRef: undefined,
        notificationService,
      };

      await initializeApp(options, api);

      // Projects should still be loaded
      expect(projectsStore.projects.value).toContainEqual(TEST_PROJECT);
      expect(projectsStore.loadingState.value).toBe("loaded");
    });
  });

  describe("auto-open project picker", () => {
    it("calls onAutoOpenProject when no projects exist", async () => {
      const api = createMockApi({ projects: [] });
      const onAutoOpenProject = vi.fn();
      const options: InitializeAppOptions = {
        containerRef: undefined,
        notificationService,
        onAutoOpenProject,
      };

      await initializeApp(options, api);

      expect(onAutoOpenProject).toHaveBeenCalled();
    });

    it("does not call onAutoOpenProject when projects exist", async () => {
      const api = createMockApi({ projects: [TEST_PROJECT] });
      const onAutoOpenProject = vi.fn();
      const options: InitializeAppOptions = {
        containerRef: undefined,
        notificationService,
        onAutoOpenProject,
      };

      await initializeApp(options, api);

      expect(onAutoOpenProject).not.toHaveBeenCalled();
    });

    it("does not fail when onAutoOpenProject is not provided", async () => {
      const api = createMockApi({ projects: [] });
      const options: InitializeAppOptions = {
        containerRef: undefined,
        notificationService,
      };

      await expect(initializeApp(options, api)).resolves.not.toThrow();
    });
  });

  describe("focus management", () => {
    it("focuses vscode-button element", async () => {
      const container = createMockContainer("vscode-button");
      const api = createMockApi({ projects: [TEST_PROJECT] });
      const options: InitializeAppOptions = {
        containerRef: container,
        notificationService,
      };

      await initializeApp(options, api);

      expect(document.activeElement?.tagName.toLowerCase()).toBe("vscode-button");
    });

    it("focuses native button element", async () => {
      const container = createMockContainer("button");
      const api = createMockApi({ projects: [TEST_PROJECT] });
      const options: InitializeAppOptions = {
        containerRef: container,
        notificationService,
      };

      await initializeApp(options, api);

      expect(document.activeElement?.tagName.toLowerCase()).toBe("button");
    });

    it("focuses input element", async () => {
      const container = createMockContainer("input");
      const api = createMockApi({ projects: [TEST_PROJECT] });
      const options: InitializeAppOptions = {
        containerRef: container,
        notificationService,
      };

      await initializeApp(options, api);

      expect(document.activeElement?.tagName.toLowerCase()).toBe("input");
    });

    it("handles missing container gracefully", async () => {
      const api = createMockApi({ projects: [TEST_PROJECT] });
      const options: InitializeAppOptions = {
        containerRef: undefined,
        notificationService,
      };

      await expect(initializeApp(options, api)).resolves.not.toThrow();
    });
  });

  describe("cleanup", () => {
    it("returns cleanup function for consistent composition", async () => {
      const api = createMockApi({ projects: [TEST_PROJECT] });
      const options: InitializeAppOptions = {
        containerRef: undefined,
        notificationService,
      };

      const cleanup = await initializeApp(options, api);

      expect(typeof cleanup).toBe("function");
      // Cleanup is no-op but should not throw
      expect(() => cleanup()).not.toThrow();
    });
  });
});
