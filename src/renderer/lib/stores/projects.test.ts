/**
 * Tests for the projects store.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Api } from "@shared/electron-api";
import type { ProjectPath, Workspace } from "@shared/ipc";
import { createMockProject, createMockWorkspace } from "$lib/test-fixtures";

// Create mock API
const mockApi: Api = {
  selectFolder: vi.fn().mockResolvedValue(null),
  openProject: vi.fn().mockResolvedValue(undefined),
  closeProject: vi.fn().mockResolvedValue(undefined),
  listProjects: vi.fn().mockResolvedValue({ projects: [], activeWorkspacePath: null }),
  createWorkspace: vi.fn().mockResolvedValue(undefined),
  removeWorkspace: vi.fn().mockResolvedValue(undefined),
  switchWorkspace: vi.fn().mockResolvedValue(undefined),
  listBases: vi.fn().mockResolvedValue([]),
  updateBases: vi.fn().mockResolvedValue(undefined),
  isWorkspaceDirty: vi.fn().mockResolvedValue(false),
  setDialogMode: vi.fn().mockResolvedValue(undefined),
  focusActiveWorkspace: vi.fn().mockResolvedValue(undefined),
  getAgentStatus: vi.fn().mockResolvedValue({ status: "none", counts: { idle: 0, busy: 0 } }),
  getAllAgentStatuses: vi.fn().mockResolvedValue({}),
  refreshAgentStatus: vi.fn().mockResolvedValue(undefined),
  setupReady: vi.fn().mockResolvedValue(undefined),
  setupRetry: vi.fn().mockResolvedValue(undefined),
  setupQuit: vi.fn().mockResolvedValue(undefined),
  onProjectOpened: vi.fn(() => vi.fn()),
  onProjectClosed: vi.fn(() => vi.fn()),
  onWorkspaceCreated: vi.fn(() => vi.fn()),
  onWorkspaceRemoved: vi.fn(() => vi.fn()),
  onWorkspaceSwitched: vi.fn(() => vi.fn()),
  onShortcutEnable: vi.fn(() => vi.fn()),
  onShortcutDisable: vi.fn(() => vi.fn()),
  onAgentStatusChanged: vi.fn(() => vi.fn()),
  onSetupProgress: vi.fn(() => vi.fn()),
  onSetupComplete: vi.fn(() => vi.fn()),
  onSetupError: vi.fn(() => vi.fn()),
};

// Set up window.api before importing the store
window.api = mockApi;

// Import store after setting up mock
import {
  projects,
  activeWorkspacePath,
  loadingState,
  loadingError,
  activeProject,
  flatWorkspaceList,
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
  getWorkspaceByIndex,
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
      expect(projects.value).toEqual(mockProjects);
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
      expect(projects.value[0]).toEqual(project1);
      expect(projects.value[1]).toEqual(project2);
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

      expect(activeProject.value).toEqual(project);
    });

    it("returns undefined when no match", () => {
      const project = createMockProject();
      addProject(project);
      setActiveWorkspace("/nonexistent/path");

      expect(activeProject.value).toBeUndefined();
    });
  });

  describe("flatWorkspaceList derived", () => {
    it("flattens all workspaces from all projects", () => {
      const ws1: Workspace = createMockWorkspace({ path: "/test/project1/.worktrees/ws1" });
      const ws2: Workspace = createMockWorkspace({ path: "/test/project1/.worktrees/ws2" });
      const ws3: Workspace = createMockWorkspace({ path: "/test/project2/.worktrees/ws3" });

      const project1 = createMockProject({
        path: "/test/project1" as ProjectPath,
        workspaces: [ws1, ws2],
      });
      const project2 = createMockProject({
        path: "/test/project2" as ProjectPath,
        workspaces: [ws3],
      });

      addProject(project1);
      addProject(project2);

      expect(flatWorkspaceList.value).toHaveLength(3);
      expect(flatWorkspaceList.value[0]).toEqual({
        projectPath: "/test/project1",
        workspace: ws1,
      });
      expect(flatWorkspaceList.value[1]).toEqual({
        projectPath: "/test/project1",
        workspace: ws2,
      });
      expect(flatWorkspaceList.value[2]).toEqual({
        projectPath: "/test/project2",
        workspace: ws3,
      });
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

  describe("getWorkspaceByIndex", () => {
    it("should-return-workspace-at-global-index-in-alphabetical-order", () => {
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
      expect(getWorkspaceByIndex(0)?.name).toBe("alpha");
      expect(getWorkspaceByIndex(1)?.name).toBe("bravo");
      expect(getWorkspaceByIndex(2)?.name).toBe("charlie");
    });

    it("should-return-undefined-for-out-of-range-index", () => {
      const ws = createMockWorkspace({ path: "/test/p1/ws1" });
      addProject(
        createMockProject({
          path: "/test/p1" as ProjectPath,
          workspaces: [ws],
        })
      );

      expect(getWorkspaceByIndex(-1)).toBeUndefined();
      expect(getWorkspaceByIndex(1)).toBeUndefined();
      expect(getWorkspaceByIndex(100)).toBeUndefined();
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
});
