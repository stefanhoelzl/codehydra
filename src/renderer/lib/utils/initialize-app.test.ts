/**
 * Tests for initializeApp setup function.
 * Uses behavioral mocks that verify state changes, not call tracking.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Project, Workspace, ProjectId, WorkspaceName } from "@shared/api/types";
import { createMockProject, createMockWorkspace } from "@shared/test-fixtures";

vi.mock("$lib/api", () => ({
  lifecycle: { ready: vi.fn() },
}));

import { initializeApp, type InitializeAppApi, type InitializeAppOptions } from "./initialize-app";
import * as projectsStore from "$lib/stores/projects.svelte.js";
import * as bootstrapStore from "$lib/stores/bootstrap.svelte.js";
import * as agentStatusStore from "$lib/stores/agent-status.svelte.js";

const TEST_PROJECT_ID = "my-project-a1b2c3d4" as ProjectId;
const TEST_PROJECT_PATH = "/test/project";
const TEST_WORKSPACE_NAME = "feature-branch" as WorkspaceName;
const TEST_WORKSPACE_PATH = "/test/project/.worktrees/feature";

const TEST_WORKSPACE: Workspace = createMockWorkspace({
  projectId: TEST_PROJECT_ID,
  name: TEST_WORKSPACE_NAME,
  metadata: { base: "main" },
  path: TEST_WORKSPACE_PATH,
});

const TEST_PROJECT: Project = createMockProject({
  id: TEST_PROJECT_ID,
  name: "my-project",
  path: TEST_PROJECT_PATH,
  workspaces: [TEST_WORKSPACE],
});

function createMockApi(config?: {
  projects?: Project[];
  activeWorkspace?: { path: string } | null;
  projectsError?: Error;
}): InitializeAppApi {
  const projectList = config?.projects ?? [TEST_PROJECT];
  const activeWorkspace =
    config && "activeWorkspace" in config ? config.activeWorkspace : { path: TEST_WORKSPACE_PATH };

  return {
    lifecycle: {
      ready: vi.fn(async () => {
        if (config?.projectsError) {
          throw config.projectsError;
        }
        // Simulate event-driven store population (what event handlers do)
        for (const p of projectList) {
          projectsStore.addProject(p);
        }
        projectsStore.setActiveWorkspace(activeWorkspace?.path ?? null);
        return { defaultAgent: null, availableAgents: [] };
      }),
    },
  };
}

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

describe("initializeApp", () => {
  beforeEach(() => {
    projectsStore.reset();
    bootstrapStore.resetBootstrap();
    agentStatusStore.reset();
  });

  afterEach(() => {
    projectsStore.reset();
    bootstrapStore.resetBootstrap();
    agentStatusStore.reset();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  describe("project loading", () => {
    it("loads projects into store via lifecycle.ready()", async () => {
      const api = createMockApi({ projects: [TEST_PROJECT] });
      const options: InitializeAppOptions = { containerRef: undefined };

      await initializeApp(options, api);

      expect(projectsStore.projects.value).toContainEqual(TEST_PROJECT);
      expect(bootstrapStore.bootstrap.initialized).toBe(true);
    });

    it("sets active workspace from events", async () => {
      const api = createMockApi({
        projects: [TEST_PROJECT],
        activeWorkspace: { path: TEST_WORKSPACE_PATH },
      });
      const options: InitializeAppOptions = { containerRef: undefined };

      await initializeApp(options, api);

      expect(projectsStore.activeWorkspacePath.value).toBe(TEST_WORKSPACE_PATH);
    });

    it("handles null active workspace", async () => {
      projectsStore.reset();

      const api = createMockApi({
        projects: [TEST_PROJECT],
        activeWorkspace: null,
      });
      const options: InitializeAppOptions = { containerRef: undefined };

      await initializeApp(options, api);

      expect(projectsStore.activeWorkspacePath.value).toBeNull();
    });
  });

  describe("focus management", () => {
    it("focuses vscode-button element", async () => {
      const container = createMockContainer("vscode-button");
      const api = createMockApi({ projects: [TEST_PROJECT] });
      const options: InitializeAppOptions = { containerRef: container };

      await initializeApp(options, api);

      expect(document.activeElement?.tagName.toLowerCase()).toBe("vscode-button");
    });

    it("focuses native button element", async () => {
      const container = createMockContainer("button");
      const api = createMockApi({ projects: [TEST_PROJECT] });
      const options: InitializeAppOptions = { containerRef: container };

      await initializeApp(options, api);

      expect(document.activeElement?.tagName.toLowerCase()).toBe("button");
    });

    it("focuses input element", async () => {
      const container = createMockContainer("input");
      const api = createMockApi({ projects: [TEST_PROJECT] });
      const options: InitializeAppOptions = { containerRef: container };

      await initializeApp(options, api);

      expect(document.activeElement?.tagName.toLowerCase()).toBe("input");
    });

    it("handles missing container gracefully", async () => {
      const api = createMockApi({ projects: [TEST_PROJECT] });
      const options: InitializeAppOptions = { containerRef: undefined };

      await expect(initializeApp(options, api)).resolves.not.toThrow();
    });
  });

  describe("cleanup", () => {
    it("returns cleanup function for consistent composition", async () => {
      const api = createMockApi({ projects: [TEST_PROJECT] });
      const options: InitializeAppOptions = { containerRef: undefined };

      const cleanup = await initializeApp(options, api);

      expect(typeof cleanup).toBe("function");
      expect(() => cleanup()).not.toThrow();
    });
  });
});
