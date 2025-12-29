// @vitest-environment node
/**
 * Integration tests for the services layer.
 * Tests full workflows with real git repos and filesystem.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestGitRepo, createTempDir } from "./test-utils";
import { SimpleGitClient } from "./git/simple-git-client";
import { GitWorktreeProvider } from "./git/git-worktree-provider";
import { ProjectStore } from "./project/project-store";
import { DefaultFileSystemLayer } from "./platform/filesystem";
import { SILENT_LOGGER } from "./logging";
import { createMockFileSystemLayer } from "./platform/filesystem.test-utils";
import { createGitWorktreeProvider } from "./index";
import { projectDirName } from "./platform/paths";
import { Path } from "./platform/path";
import path from "path";

describe("Services Integration", () => {
  describe("Full workflow", () => {
    let repoCleanup: () => Promise<void>;
    let tempCleanup: () => Promise<void>;
    let repoPath: string;
    let projectsDir: string;

    /** Get the workspaces directory for a project (using temp directory) */
    function getWorkspacesDir(projectPath: string): string {
      return path.join(projectsDir, projectDirName(projectPath), "workspaces");
    }

    beforeEach(async () => {
      const repo = await createTestGitRepo();
      repoPath = repo.path;
      repoCleanup = repo.cleanup;

      const tempDir = await createTempDir();
      projectsDir = path.join(tempDir.path, "projects");
      tempCleanup = tempDir.cleanup;
    });

    afterEach(async () => {
      await repoCleanup();
      await tempCleanup();
    });

    it("performs complete project and workspace workflow", async () => {
      // 1. Create project store and save project
      const fileSystemLayer = new DefaultFileSystemLayer(SILENT_LOGGER);
      const projectStore = new ProjectStore(projectsDir, fileSystemLayer);
      await projectStore.saveProject(repoPath);

      // Verify project is saved (paths are normalized by Path class)
      const savedProjects = await projectStore.loadAllProjects();
      expect(savedProjects).toContain(new Path(repoPath).toString());

      // 2. Create GitWorktreeProvider with SimpleGitClient
      const gitClient = new SimpleGitClient(SILENT_LOGGER);
      const workspacesDir = getWorkspacesDir(repoPath);
      const provider = await GitWorktreeProvider.create(
        new Path(repoPath),
        gitClient,
        new Path(workspacesDir),
        fileSystemLayer,
        SILENT_LOGGER
      );

      // 3. Discover workspaces (empty initially)
      const initialWorkspaces = await provider.discover();
      expect(initialWorkspaces).toHaveLength(0);

      // 4. Create workspace from main branch
      const workspace = await provider.createWorkspace("feature-test", "main");
      expect(workspace.name).toBe("feature-test");
      expect(workspace.branch).toBe("feature-test");

      // 5. Discover again (finds new workspace)
      const workspaces = await provider.discover();
      expect(workspaces).toHaveLength(1);
      expect(workspaces[0]?.name).toBe("feature-test");

      // 6. Check isDirty (false for clean workspace)
      const isDirty = await provider.isDirty(workspace.path);
      expect(isDirty).toBe(false);

      // 7. Remove workspace
      const result = await provider.removeWorkspace(workspace.path, true);
      expect(result.workspaceRemoved).toBe(true);

      // 8. Verify workspace is gone
      const finalWorkspaces = await provider.discover();
      expect(finalWorkspaces).toHaveLength(0);
    });

    it("handles multiple workspaces", async () => {
      const fileSystemLayer = new DefaultFileSystemLayer(SILENT_LOGGER);
      const gitClient = new SimpleGitClient(SILENT_LOGGER);
      const workspacesDir = getWorkspacesDir(repoPath);
      const provider = await GitWorktreeProvider.create(
        new Path(repoPath),
        gitClient,
        new Path(workspacesDir),
        fileSystemLayer,
        SILENT_LOGGER
      );

      // Create multiple workspaces
      const ws1 = await provider.createWorkspace("feature-1", "main");
      const ws2 = await provider.createWorkspace("feature-2", "main");

      // Should find both
      const workspaces = await provider.discover();
      expect(workspaces).toHaveLength(2);

      // Remove one
      await provider.removeWorkspace(ws1.path, true);

      // Should find only one
      const remaining = await provider.discover();
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.name).toBe("feature-2");

      // Cleanup
      await provider.removeWorkspace(ws2.path, true);
    });
  });

  describe("Factory function", () => {
    let repoCleanup: () => Promise<void>;
    let tempCleanup: () => Promise<void>;
    let repoPath: string;
    let tempDir: string;

    /** Get the workspaces directory for a project (using temp directory) */
    function getWorkspacesDir(projectPath: string): string {
      return path.join(tempDir, projectDirName(projectPath), "workspaces");
    }

    beforeEach(async () => {
      const repo = await createTestGitRepo();
      repoPath = repo.path;
      repoCleanup = repo.cleanup;

      const temp = await createTempDir();
      tempDir = temp.path;
      tempCleanup = temp.cleanup;
    });

    afterEach(async () => {
      await repoCleanup();
      await tempCleanup();
    });

    it("createGitWorktreeProvider creates provider successfully", async () => {
      const workspacesDir = getWorkspacesDir(repoPath);
      const fileSystemLayer = new DefaultFileSystemLayer(SILENT_LOGGER);
      const provider = await createGitWorktreeProvider(
        new Path(repoPath),
        new Path(workspacesDir),
        fileSystemLayer,
        SILENT_LOGGER,
        SILENT_LOGGER
      );

      expect(provider.projectRoot.toString()).toBe(repoPath);

      // Should be able to discover workspaces
      const workspaces = await provider.discover();
      expect(workspaces).toHaveLength(0);
    });

    it("createGitWorktreeProvider throws for non-git directory", async () => {
      const nonGitDir = await createTempDir();
      try {
        const workspacesDir = getWorkspacesDir(nonGitDir.path);
        const fileSystemLayer = new DefaultFileSystemLayer(SILENT_LOGGER);
        await expect(
          createGitWorktreeProvider(
            new Path(nonGitDir.path),
            new Path(workspacesDir),
            fileSystemLayer,
            SILENT_LOGGER,
            SILENT_LOGGER
          )
        ).rejects.toThrow();
      } finally {
        await nonGitDir.cleanup();
      }
    });
  });

  describe("Abstraction layer", () => {
    it("IWorkspaceProvider works with mocked IGitClient", async () => {
      // This test verifies the abstraction by using a mocked git client
      const mockGitClient = {
        isRepositoryRoot: async () => true,
        listWorktrees: async () => [
          { name: "main", path: new Path("/mock/repo"), branch: "main", isMain: true },
          {
            name: "feature",
            path: new Path("/mock/workspaces/feature"),
            branch: "feature",
            isMain: false,
          },
        ],
        addWorktree: async () => {},
        removeWorktree: async () => {},
        pruneWorktrees: async () => {},
        listBranches: async () => [
          { name: "main", isRemote: false },
          { name: "origin/main", isRemote: true },
        ],
        createBranch: async () => {},
        deleteBranch: async () => {},
        getCurrentBranch: async () => "main",
        getStatus: async () => ({
          isDirty: false,
          modifiedCount: 0,
          stagedCount: 0,
          untrackedCount: 0,
        }),
        fetch: async () => {},
        listRemotes: async () => ["origin"],
        getBranchConfig: async () => null,
        setBranchConfig: async () => {},
        getBranchConfigsByPrefix: async () => ({}),
        unsetBranchConfig: async () => {},
      };

      const mockFileSystemLayer = createMockFileSystemLayer();
      const provider = await GitWorktreeProvider.create(
        new Path("/mock/repo"),
        mockGitClient,
        new Path("/mock/workspaces"),
        mockFileSystemLayer,
        SILENT_LOGGER
      );

      // Should work with the mock
      const workspaces = await provider.discover();
      expect(workspaces).toHaveLength(1);
      expect(workspaces[0]?.name).toBe("feature");

      const bases = await provider.listBases();
      expect(bases).toHaveLength(2);
    });
  });

  describe("Error handling", () => {
    it("handles workspace with uncommitted changes", async () => {
      const repo = await createTestGitRepo({ dirty: true });
      const tempDir = await createTempDir();

      /** Get the workspaces directory for a project (using temp directory) */
      function getWorkspacesDir(projectPath: string): string {
        return path.join(tempDir.path, projectDirName(projectPath), "workspaces");
      }

      try {
        const fileSystemLayer = new DefaultFileSystemLayer(SILENT_LOGGER);
        const gitClient = new SimpleGitClient(SILENT_LOGGER);
        const workspacesDir = getWorkspacesDir(repo.path);
        const provider = await GitWorktreeProvider.create(
          new Path(repo.path),
          gitClient,
          new Path(workspacesDir),
          fileSystemLayer,
          SILENT_LOGGER
        );

        // Create a workspace
        const workspace = await provider.createWorkspace("dirty-feature", "main");

        // Initial workspace should be clean
        const isDirty = await provider.isDirty(workspace.path);
        expect(isDirty).toBe(false);

        // Main repo is dirty
        const mainDirty = await provider.isDirty(new Path(repo.path));
        expect(mainDirty).toBe(true);

        // Cleanup
        await provider.removeWorkspace(workspace.path, true);
      } finally {
        await repo.cleanup();
        await tempDir.cleanup();
      }
    });
  });
});
