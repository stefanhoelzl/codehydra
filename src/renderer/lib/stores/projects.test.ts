/**
 * Tests for the projects store.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Api } from "@shared/electron-api";
import type { ProjectPath } from "@shared/ipc";
import type { ProjectId, Workspace } from "@shared/api/types";
import { createMockProject, createMockWorkspace } from "$lib/test-fixtures";
import { createMockApi } from "../test-utils";

// Create mock API (flat structure)
const mockApi: Api = createMockApi();

// Set up window.api before importing the store
window.api = mockApi;

// Import store after setting up mock
import {
  projects,
  activeWorkspacePath,
  loadingState,
  loadingError,
  activeProject,
  setProjects,
  addProject,
  removeProject,
  setActiveWorkspace,
  setLoaded,
  setError,
  addWorkspace,
  removeWorkspace,
  reset,
  getAllWorkspaces,
  findWorkspaceIndex,
  wrapIndex,
} from "./projects.svelte.js";

describe("projects store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reset();
  });

  describe("initial state", () => {
    it("initializes with empty projects array", () => {
      expect(projects.value).toEqual([]);
    });

    it("initializes with loadingState 'loading'", () => {
      expect(loadingState.value).toBe("loading");
    });

    it("initializes with loadingError null", () => {
      expect(loadingError.value).toBeNull();
    });

    it("initializes with activeWorkspacePath null", () => {
      expect(activeWorkspacePath.value).toBeNull();
    });
  });

  describe("setProjects", () => {
    it("sets projects array", () => {
      const mockProjects = [createMockProject()];
      setProjects(mockProjects);
      // Use toMatchObject since projects now include generated `id` field
      expect(projects.value).toHaveLength(1);
      expect(projects.value[0]).toMatchObject(mockProjects[0]!);
    });
  });

  describe("addProject", () => {
    it("adds project to array (immutable)", () => {
      const project1 = createMockProject({ path: "/test/project1" as ProjectPath });
      const project2 = createMockProject({ path: "/test/project2" as ProjectPath });

      addProject(project1);
      expect(projects.value).toHaveLength(1);

      addProject(project2);
      expect(projects.value).toHaveLength(2);
      // Use toMatchObject since projects now include generated `id` field
      expect(projects.value[0]).toMatchObject(project1);
      expect(projects.value[1]).toMatchObject(project2);
    });
  });

  describe("removeProject", () => {
    it("removes project from array", () => {
      const project = createMockProject({ path: "/test/project" as ProjectPath });
      addProject(project);
      expect(projects.value).toHaveLength(1);

      removeProject("/test/project" as ProjectPath);
      expect(projects.value).toHaveLength(0);
    });

    it("updates activeWorkspacePath if removed project contained active workspace", () => {
      const project1 = createMockProject({
        path: "/test/project1" as ProjectPath,
        workspaces: [createMockWorkspace({ path: "/test/project1/.worktrees/ws1" })],
      });
      const project2 = createMockProject({
        path: "/test/project2" as ProjectPath,
        workspaces: [createMockWorkspace({ path: "/test/project2/.worktrees/ws2" })],
      });

      addProject(project1);
      addProject(project2);
      setActiveWorkspace("/test/project1/.worktrees/ws1");

      expect(activeWorkspacePath.value).toBe("/test/project1/.worktrees/ws1");

      removeProject("/test/project1" as ProjectPath);

      // Active should switch to first available workspace
      expect(activeWorkspacePath.value).toBe("/test/project2/.worktrees/ws2");
    });

    it("sets activeWorkspacePath to null if no projects remain", () => {
      const project = createMockProject({
        path: "/test/project" as ProjectPath,
        workspaces: [createMockWorkspace({ path: "/test/project/.worktrees/ws1" })],
      });

      addProject(project);
      setActiveWorkspace("/test/project/.worktrees/ws1");
      removeProject("/test/project" as ProjectPath);

      expect(activeWorkspacePath.value).toBeNull();
    });
  });

  describe("setActiveWorkspace", () => {
    it("updates activeWorkspacePath", () => {
      setActiveWorkspace("/test/workspace");
      expect(activeWorkspacePath.value).toBe("/test/workspace");
    });
  });

  describe("activeProject derived", () => {
    it("returns correct project for active workspace", () => {
      const project = createMockProject({
        path: "/test/project" as ProjectPath,
        workspaces: [createMockWorkspace({ path: "/test/project/.worktrees/ws1" })],
      });

      addProject(project);
      setActiveWorkspace("/test/project/.worktrees/ws1");

      // activeProject now returns ProjectWithId (includes generated id)
      expect(activeProject.value).toMatchObject({
        ...project,
        // id is generated from path, just verify it exists
        id: expect.any(String),
      });
      expect(activeProject.value?.id).toBeDefined();
    });

    it("returns undefined when no match", () => {
      const project = createMockProject();
      addProject(project);
      setActiveWorkspace("/nonexistent/path");

      expect(activeProject.value).toBeUndefined();
    });
  });

  describe("setError", () => {
    it("sets loadingState to 'error' and stores message", () => {
      setError("Something went wrong");

      expect(loadingState.value).toBe("error");
      expect(loadingError.value).toBe("Something went wrong");
    });
  });

  describe("setLoaded", () => {
    it("sets loadingState to 'loaded'", () => {
      setLoaded();
      expect(loadingState.value).toBe("loaded");
    });
  });

  describe("addWorkspace", () => {
    it("adds workspace to correct project", () => {
      const project = createMockProject({
        path: "/test/project" as ProjectPath,
        workspaces: [],
      });
      addProject(project);

      const newWorkspace = createMockWorkspace({ path: "/test/project/.worktrees/new" });
      addWorkspace("/test/project" as ProjectPath, newWorkspace);

      expect(projects.value[0]?.workspaces).toHaveLength(1);
      expect(projects.value[0]?.workspaces[0]).toEqual(newWorkspace);
    });

    it("updates project defaultBaseBranch when provided", () => {
      const project = createMockProject({
        path: "/test/project" as ProjectPath,
        workspaces: [],
      });
      addProject(project);

      const newWorkspace = createMockWorkspace({ path: "/test/project/.worktrees/new" });
      addWorkspace("/test/project" as ProjectPath, newWorkspace, "develop");

      expect(projects.value[0]?.defaultBaseBranch).toBe("develop");
    });

    it("does not update defaultBaseBranch when not provided", () => {
      const project = createMockProject({
        path: "/test/project" as ProjectPath,
        workspaces: [],
        defaultBaseBranch: "main",
      });
      addProject(project);

      const newWorkspace = createMockWorkspace({ path: "/test/project/.worktrees/new" });
      addWorkspace("/test/project" as ProjectPath, newWorkspace);

      // Should preserve existing defaultBaseBranch
      expect(projects.value[0]?.defaultBaseBranch).toBe("main");
    });

    it("overwrites existing defaultBaseBranch when new value provided", () => {
      const project = createMockProject({
        path: "/test/project" as ProjectPath,
        workspaces: [],
        defaultBaseBranch: "main",
      });
      addProject(project);

      const newWorkspace = createMockWorkspace({ path: "/test/project/.worktrees/new" });
      addWorkspace("/test/project" as ProjectPath, newWorkspace, "feature/new-base");

      expect(projects.value[0]?.defaultBaseBranch).toBe("feature/new-base");
    });
  });

  describe("removeWorkspace", () => {
    it("removes workspace from correct project", () => {
      const ws = createMockWorkspace({ path: "/test/project/.worktrees/ws1" });
      const project = createMockProject({
        path: "/test/project" as ProjectPath,
        workspaces: [ws],
      });
      addProject(project);

      removeWorkspace("/test/project" as ProjectPath, "/test/project/.worktrees/ws1");

      expect(projects.value[0]?.workspaces).toHaveLength(0);
    });
  });

  describe("getAllWorkspaces", () => {
    it("should-return-flat-array-of-all-workspaces", () => {
      const ws1 = createMockWorkspace({ path: "/test/p1/ws1", name: "ws1" });
      const ws2 = createMockWorkspace({ path: "/test/p1/ws2", name: "ws2" });
      const ws3 = createMockWorkspace({ path: "/test/p2/ws3", name: "ws3" });

      addProject(
        createMockProject({
          path: "/test/p1" as ProjectPath,
          name: "project-a",
          workspaces: [ws1, ws2],
        })
      );
      addProject(
        createMockProject({
          path: "/test/p2" as ProjectPath,
          name: "project-b",
          workspaces: [ws3],
        })
      );

      const result = getAllWorkspaces();
      expect(result).toHaveLength(3);
      expect(result[0]).toEqual(ws1);
      expect(result[1]).toEqual(ws2);
      expect(result[2]).toEqual(ws3);
    });

    it("should-return-workspaces-in-alphabetical-order", () => {
      // Add projects in non-alphabetical order
      const wsZ1 = createMockWorkspace({ path: "/test/z/ws1", name: "z1" });
      const wsZ2 = createMockWorkspace({ path: "/test/z/ws2", name: "z2" });
      const wsA1 = createMockWorkspace({ path: "/test/a/ws1", name: "a1" });

      addProject(
        createMockProject({
          path: "/test/z" as ProjectPath,
          name: "Zeta",
          workspaces: [wsZ1, wsZ2],
        })
      );
      addProject(
        createMockProject({
          path: "/test/a" as ProjectPath,
          name: "Alpha",
          workspaces: [wsA1],
        })
      );

      // Should be sorted alphabetically: Alpha project first, then Zeta
      const result = getAllWorkspaces();
      expect(result.map((w: Workspace) => w.name)).toEqual(["a1", "z1", "z2"]);
    });

    it("should-sort-workspaces-within-project-alphabetically", () => {
      // Add workspaces in non-alphabetical order
      const wsC = createMockWorkspace({ path: "/test/p/wsC", name: "charlie" });
      const wsA = createMockWorkspace({ path: "/test/p/wsA", name: "alpha" });
      const wsB = createMockWorkspace({ path: "/test/p/wsB", name: "bravo" });

      addProject(
        createMockProject({
          path: "/test/p" as ProjectPath,
          name: "Project",
          workspaces: [wsC, wsA, wsB],
        })
      );

      const result = getAllWorkspaces();
      expect(result.map((w: Workspace) => w.name)).toEqual(["alpha", "bravo", "charlie"]);
    });

    it("should-return-empty-array-when-no-projects", () => {
      const result = getAllWorkspaces();
      expect(result).toEqual([]);
    });
  });

  describe("findWorkspaceIndex", () => {
    it("should-find-workspace-index-by-path-in-alphabetical-order", () => {
      // Add in non-alphabetical order to verify sorting
      const wsC = createMockWorkspace({ path: "/test/p2/wsC", name: "charlie" });
      const wsA = createMockWorkspace({ path: "/test/p1/wsA", name: "alpha" });
      const wsB = createMockWorkspace({ path: "/test/p1/wsB", name: "bravo" });

      addProject(
        createMockProject({
          path: "/test/p2" as ProjectPath,
          name: "project-b",
          workspaces: [wsC],
        })
      );
      addProject(
        createMockProject({
          path: "/test/p1" as ProjectPath,
          name: "project-a",
          workspaces: [wsB, wsA], // Add in non-alphabetical order
        })
      );

      // Should be sorted: project-a (alpha, bravo), project-b (charlie)
      expect(findWorkspaceIndex("/test/p1/wsA")).toBe(0); // alpha
      expect(findWorkspaceIndex("/test/p1/wsB")).toBe(1); // bravo
      expect(findWorkspaceIndex("/test/p2/wsC")).toBe(2); // charlie
    });

    it("should-return-negative-one-for-unknown-path", () => {
      const ws = createMockWorkspace({ path: "/test/p1/ws1" });
      addProject(
        createMockProject({
          path: "/test/p1" as ProjectPath,
          workspaces: [ws],
        })
      );

      expect(findWorkspaceIndex("/nonexistent/path")).toBe(-1);
    });

    it("returns -1 for null path", () => {
      expect(findWorkspaceIndex(null)).toBe(-1);
    });
  });

  describe("wrapIndex", () => {
    it("should-wrap-positive-overflow-to-start", () => {
      expect(wrapIndex(3, 3)).toBe(0);
      expect(wrapIndex(4, 3)).toBe(1);
      expect(wrapIndex(5, 3)).toBe(2);
    });

    it("should-wrap-negative-underflow-to-end", () => {
      expect(wrapIndex(-1, 3)).toBe(2);
      expect(wrapIndex(-2, 3)).toBe(1);
      expect(wrapIndex(-3, 3)).toBe(0);
    });

    it("should-leave-valid-indices-unchanged", () => {
      expect(wrapIndex(0, 3)).toBe(0);
      expect(wrapIndex(1, 3)).toBe(1);
      expect(wrapIndex(2, 3)).toBe(2);
    });
  });

  // =============================================================================
  // New v2 API Tests (Step 5.5 - TDD RED)
  // These tests use type assertions to test not-yet-implemented features.
  // =============================================================================

  describe("activeWorkspace (v2)", () => {
    it("returns null when no active workspace", async () => {
      // Dynamic import and cast to any to test not-yet-implemented feature
      const store = (await import("./projects.svelte.js")) as unknown as {
        reset: () => void;
        activeWorkspace: {
          value: { projectId: string; workspaceName: string; path: string } | null;
        };
      };
      store.reset();

      expect(store.activeWorkspace.value).toBeNull();
    });

    it("returns WorkspaceRef for active workspace", async () => {
      const store = (await import("./projects.svelte.js")) as unknown as {
        reset: () => void;
        addProject: (p: ReturnType<typeof createMockProject>) => void;
        setActiveWorkspace: (path: string) => void;
        activeWorkspace: {
          value: { projectId: string; workspaceName: string; path: string } | null;
        };
      };
      store.reset();

      const ws = createMockWorkspace({ path: "/test/project/.worktrees/ws1", name: "ws1" });
      const project = createMockProject({
        path: "/test/project" as ProjectPath,
        workspaces: [ws],
      });
      store.addProject(project);
      store.setActiveWorkspace("/test/project/.worktrees/ws1");

      const activeRef = store.activeWorkspace.value;
      expect(activeRef).not.toBeNull();
      expect(activeRef?.workspaceName).toBe("ws1");
      expect(activeRef?.path).toBe("/test/project/.worktrees/ws1");
      // Should include projectId (generated from project path)
      expect(activeRef?.projectId).toBeDefined();
    });
  });

  describe("getProjectById", () => {
    it("returns project by ID", async () => {
      const store = (await import("./projects.svelte.js")) as unknown as {
        reset: () => void;
        addProject: (p: ReturnType<typeof createMockProject>) => void;
        projects: { value: Array<{ id: ProjectId; path: string; name: string }> };
        getProjectById: (id: ProjectId) => { path: string; name: string } | undefined;
      };
      store.reset();

      const project = createMockProject({
        path: "/test/my-app" as ProjectPath,
        name: "my-app",
        workspaces: [createMockWorkspace({ path: "/test/my-app/.worktrees/ws1" })],
      });
      store.addProject(project);

      // Get projects to find the generated ID
      const projects = store.projects.value;
      expect(projects).toHaveLength(1);

      // The v2 projects should have IDs
      const projectWithId = projects[0];
      expect(projectWithId).toBeDefined();

      // Look up by ID
      const found = store.getProjectById(projectWithId!.id);
      expect(found).toBeDefined();
      expect(found?.path).toBe("/test/my-app");
    });

    it("returns undefined for unknown ID", async () => {
      const store = (await import("./projects.svelte.js")) as unknown as {
        reset: () => void;
        addProject: (p: ReturnType<typeof createMockProject>) => void;
        getProjectById: (id: ProjectId) => { path: string } | undefined;
      };
      store.reset();

      const project = createMockProject({ path: "/test/project" as ProjectPath });
      store.addProject(project);

      const found = store.getProjectById("unknown-12345678" as ProjectId);
      expect(found).toBeUndefined();
    });
  });
});
