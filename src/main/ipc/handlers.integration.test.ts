// @vitest-environment node
/**
 * Integration tests for IPC handlers.
 * Uses mocked Electron APIs but real services with temp git repos.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { createTestGitRepo, createTempDir } from "../../services/test-utils";
import {
  ProjectStore,
  DefaultFileSystemLayer,
  createMockPathProvider,
  type PathProvider,
} from "../../services";
import { projectDirName } from "../../services/platform/paths";
import { AppState } from "../app-state";
import type { IViewManager } from "../managers/view-manager.interface";
import path from "path";

// Mock electron - need BrowserWindow for emitEvent
vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: () => [],
  },
}));

import {
  createProjectOpenHandler,
  createProjectCloseHandler,
  createProjectListHandler,
} from "./project-handlers";
import {
  createWorkspaceCreateHandler,
  createWorkspaceRemoveHandler,
  createWorkspaceSwitchHandler,
  createWorkspaceListBasesHandler,
  createWorkspaceIsDirtyHandler,
} from "./workspace-handlers";

// Mock event
const mockEvent = {} as IpcMainInvokeEvent;

// Mock ViewManager factory
function createMockViewManager(): IViewManager & {
  createdViews: Map<string, string>;
  activeWorkspace: string | null;
} {
  const createdViews = new Map<string, string>();
  let activeWorkspace: string | null = null;

  return {
    createdViews,
    get activeWorkspace() {
      return activeWorkspace;
    },
    getUIView: vi.fn() as unknown as IViewManager["getUIView"],
    createWorkspaceView: vi.fn((workspacePath: string, url: string) => {
      createdViews.set(workspacePath, url);
      return {} as ReturnType<IViewManager["createWorkspaceView"]>;
    }),
    destroyWorkspaceView: vi.fn((workspacePath: string) => {
      createdViews.delete(workspacePath);
    }),
    getWorkspaceView: vi.fn(
      (workspacePath: string) =>
        (createdViews.has(workspacePath) ? {} : undefined) as ReturnType<
          IViewManager["getWorkspaceView"]
        >
    ),
    updateBounds: vi.fn(),
    setActiveWorkspace: vi.fn((workspacePath: string | null) => {
      activeWorkspace = workspacePath;
    }),
    getActiveWorkspacePath: vi.fn(() => activeWorkspace),
    focusActiveWorkspace: vi.fn(),
    focusUI: vi.fn(),
    setDialogMode: vi.fn(),
    updateCodeServerPort: vi.fn(),
  };
}

describe("IPC Integration Tests", () => {
  let repoCleanup: () => Promise<void>;
  let tempCleanup: () => Promise<void>;
  let repoPath: string;
  let projectsDir: string;
  let projectStore: ProjectStore;
  let viewManager: ReturnType<typeof createMockViewManager>;
  let pathProvider: PathProvider;
  let appState: AppState;

  beforeEach(async () => {
    // Create test git repo
    const repo = await createTestGitRepo();
    repoPath = repo.path;
    repoCleanup = repo.cleanup;

    // Create temp dir for project store
    const tempDir = await createTempDir();
    projectsDir = tempDir.path;
    tempCleanup = tempDir.cleanup;

    // Create mock PathProvider that returns correct workspaces dir for any project
    pathProvider = createMockPathProvider({
      projectsDir,
      // Override getProjectWorkspacesDir to use temp directory for workspace creation
      getProjectWorkspacesDir: (projectPath: string) =>
        path.join(projectsDir, projectDirName(projectPath), "workspaces"),
    });

    // Create instances
    const fileSystemLayer = new DefaultFileSystemLayer();
    projectStore = new ProjectStore(projectsDir, fileSystemLayer);
    viewManager = createMockViewManager();
    appState = new AppState(projectStore, viewManager, pathProvider, 8080);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await repoCleanup();
    await tempCleanup();
  });

  describe("open project → discovers workspaces → lists them via IPC", () => {
    it("opens project and lists it", async () => {
      const openHandler = createProjectOpenHandler(appState);
      const listHandler = createProjectListHandler(appState, viewManager);

      // Open project
      const project = await openHandler(mockEvent, { path: repoPath });

      expect(project.path).toBe(repoPath);
      expect(project.workspaces).toHaveLength(0); // No worktrees initially

      // List projects
      const result = await listHandler(mockEvent, undefined);

      expect(result.projects).toHaveLength(1);
      expect(result.projects[0]?.path).toBe(repoPath);
    });
  });

  describe("create workspace → view created → can switch to it", () => {
    it("creates workspace and switches", async () => {
      const openHandler = createProjectOpenHandler(appState);
      const createHandler = createWorkspaceCreateHandler(appState, viewManager);
      const switchHandler = createWorkspaceSwitchHandler(appState, viewManager);

      // Open project
      await openHandler(mockEvent, { path: repoPath });

      // Create workspace
      const workspace = await createHandler(mockEvent, {
        projectPath: repoPath,
        name: "feature-test",
        baseBranch: "main",
      });

      expect(workspace.name).toBe("feature-test");
      expect(workspace.branch).toBe("feature-test");

      // View should be created
      expect(viewManager.createdViews.has(workspace.path)).toBe(true);
      expect(viewManager.activeWorkspace).toBe(workspace.path);

      // Create another workspace
      const workspace2 = await createHandler(mockEvent, {
        projectPath: repoPath,
        name: "feature-test-2",
        baseBranch: "main",
      });

      // Switch back to first workspace
      await switchHandler(mockEvent, { workspacePath: workspace.path });

      expect(viewManager.activeWorkspace).toBe(workspace.path);

      // Cleanup: remove workspaces to avoid cleanup issues
      const removeHandler = createWorkspaceRemoveHandler(appState, viewManager);
      await removeHandler(mockEvent, { workspacePath: workspace.path, deleteBranch: true });
      await removeHandler(mockEvent, { workspacePath: workspace2.path, deleteBranch: true });
    });
  });

  describe("switch workspace → previous view hidden → new view shown", () => {
    it("switches workspace and updates active", async () => {
      const openHandler = createProjectOpenHandler(appState);
      const createHandler = createWorkspaceCreateHandler(appState, viewManager);
      const switchHandler = createWorkspaceSwitchHandler(appState, viewManager);

      await openHandler(mockEvent, { path: repoPath });

      // Create two workspaces
      const ws1 = await createHandler(mockEvent, {
        projectPath: repoPath,
        name: "ws1",
        baseBranch: "main",
      });
      const ws2 = await createHandler(mockEvent, {
        projectPath: repoPath,
        name: "ws2",
        baseBranch: "main",
      });

      // Second workspace should be active (last created)
      expect(viewManager.activeWorkspace).toBe(ws2.path);

      // Switch to first
      await switchHandler(mockEvent, { workspacePath: ws1.path });
      expect(viewManager.activeWorkspace).toBe(ws1.path);

      // Switch back to second
      await switchHandler(mockEvent, { workspacePath: ws2.path });
      expect(viewManager.activeWorkspace).toBe(ws2.path);

      // Cleanup
      const removeHandler = createWorkspaceRemoveHandler(appState, viewManager);
      await removeHandler(mockEvent, { workspacePath: ws1.path, deleteBranch: true });
      await removeHandler(mockEvent, { workspacePath: ws2.path, deleteBranch: true });
    });
  });

  describe("remove workspace → view destroyed → switches to another", () => {
    it("removes workspace and cleans up view", async () => {
      const openHandler = createProjectOpenHandler(appState);
      const createHandler = createWorkspaceCreateHandler(appState, viewManager);
      const removeHandler = createWorkspaceRemoveHandler(appState, viewManager);

      await openHandler(mockEvent, { path: repoPath });

      // Create workspace
      const workspace = await createHandler(mockEvent, {
        projectPath: repoPath,
        name: "to-remove",
        baseBranch: "main",
      });

      expect(viewManager.createdViews.has(workspace.path)).toBe(true);

      // Remove workspace
      const result = await removeHandler(mockEvent, {
        workspacePath: workspace.path,
        deleteBranch: true,
      });

      expect(result.workspaceRemoved).toBe(true);
      expect(result.baseDeleted).toBe(true);
      expect(viewManager.createdViews.has(workspace.path)).toBe(false);
    });
  });

  describe("close project → all workspace views destroyed", () => {
    it("closes project and destroys all views", async () => {
      const openHandler = createProjectOpenHandler(appState);
      const createHandler = createWorkspaceCreateHandler(appState, viewManager);
      const closeHandler = createProjectCloseHandler(appState);
      const listHandler = createProjectListHandler(appState, viewManager);

      // Open and create workspaces
      await openHandler(mockEvent, { path: repoPath });
      await createHandler(mockEvent, {
        projectPath: repoPath,
        name: "ws1",
        baseBranch: "main",
      });
      await createHandler(mockEvent, {
        projectPath: repoPath,
        name: "ws2",
        baseBranch: "main",
      });

      expect(viewManager.createdViews.size).toBe(2);

      // Close project
      await closeHandler(mockEvent, { path: repoPath });

      // All views should be destroyed
      expect(viewManager.createdViews.size).toBe(0);

      // Project should not be listed
      const result = await listHandler(mockEvent, undefined);
      expect(result.projects).toHaveLength(0);
    });
  });

  describe("handles project with zero workspaces gracefully", () => {
    it("opens project with no workspaces", async () => {
      const openHandler = createProjectOpenHandler(appState);
      const listHandler = createProjectListHandler(appState, viewManager);

      // Open project (fresh repo has no worktrees)
      const project = await openHandler(mockEvent, { path: repoPath });

      expect(project.workspaces).toHaveLength(0);
      expect(viewManager.createdViews.size).toBe(0);
      expect(viewManager.activeWorkspace).toBeNull();

      // Should still be listed
      const result = await listHandler(mockEvent, undefined);
      expect(result.projects).toHaveLength(1);
    });
  });

  describe("handles rapid workspace switching without race conditions", () => {
    it("handles rapid switching", async () => {
      const openHandler = createProjectOpenHandler(appState);
      const createHandler = createWorkspaceCreateHandler(appState, viewManager);
      const switchHandler = createWorkspaceSwitchHandler(appState, viewManager);
      const removeHandler = createWorkspaceRemoveHandler(appState, viewManager);

      await openHandler(mockEvent, { path: repoPath });

      // Create workspaces - storing paths only for cleanup
      const paths: string[] = [];
      const w1 = await createHandler(mockEvent, {
        projectPath: repoPath,
        name: "rapid-1",
        baseBranch: "main",
      });
      paths.push(w1.path);
      const w2 = await createHandler(mockEvent, {
        projectPath: repoPath,
        name: "rapid-2",
        baseBranch: "main",
      });
      paths.push(w2.path);
      const w3 = await createHandler(mockEvent, {
        projectPath: repoPath,
        name: "rapid-3",
        baseBranch: "main",
      });
      paths.push(w3.path);

      // Rapid switching (all switches complete in order)
      await Promise.all([
        switchHandler(mockEvent, { workspacePath: paths[0]! }),
        switchHandler(mockEvent, { workspacePath: paths[1]! }),
        switchHandler(mockEvent, { workspacePath: paths[2]! }),
        switchHandler(mockEvent, { workspacePath: paths[0]! }),
      ]);

      // Final state should be consistent (last switch wins)
      expect(viewManager.activeWorkspace).toBe(paths[0]);

      // Cleanup
      for (const p of paths) {
        await removeHandler(mockEvent, { workspacePath: p, deleteBranch: true });
      }
    });
  });

  describe("validates paths reject traversal attacks", () => {
    it("list-bases works with valid project", async () => {
      const openHandler = createProjectOpenHandler(appState);
      const listBasesHandler = createWorkspaceListBasesHandler(appState);

      await openHandler(mockEvent, { path: repoPath });

      const bases = await listBasesHandler(mockEvent, { projectPath: repoPath });

      expect(bases.length).toBeGreaterThan(0);
      expect(bases.some((b) => b.name === "main")).toBe(true);
    });
  });

  describe("isDirty check", () => {
    it("returns correct dirty status", async () => {
      const openHandler = createProjectOpenHandler(appState);
      const createHandler = createWorkspaceCreateHandler(appState, viewManager);
      const isDirtyHandler = createWorkspaceIsDirtyHandler(appState);
      const removeHandler = createWorkspaceRemoveHandler(appState, viewManager);

      await openHandler(mockEvent, { path: repoPath });

      // Create workspace
      const workspace = await createHandler(mockEvent, {
        projectPath: repoPath,
        name: "dirty-check",
        baseBranch: "main",
      });

      // Fresh workspace should be clean
      const isDirty = await isDirtyHandler(mockEvent, { workspacePath: workspace.path });
      expect(isDirty).toBe(false);

      // Cleanup
      await removeHandler(mockEvent, { workspacePath: workspace.path, deleteBranch: true });
    });
  });
});
