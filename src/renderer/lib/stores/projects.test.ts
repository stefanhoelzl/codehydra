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
  listProjects: vi.fn().mockResolvedValue([]),
  createWorkspace: vi.fn().mockResolvedValue(undefined),
  removeWorkspace: vi.fn().mockResolvedValue(undefined),
  switchWorkspace: vi.fn().mockResolvedValue(undefined),
  listBases: vi.fn().mockResolvedValue([]),
  updateBases: vi.fn().mockResolvedValue(undefined),
  isWorkspaceDirty: vi.fn().mockResolvedValue(false),
  setDialogMode: vi.fn().mockResolvedValue(undefined),
  onProjectOpened: vi.fn(() => vi.fn()),
  onProjectClosed: vi.fn(() => vi.fn()),
  onWorkspaceCreated: vi.fn(() => vi.fn()),
  onWorkspaceRemoved: vi.fn(() => vi.fn()),
  onWorkspaceSwitched: vi.fn(() => vi.fn()),
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
});
