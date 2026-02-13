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
import { createFileSystemMock, directory } from "./platform/filesystem.state-mock";
import { createMockGitClient } from "./git/git-client.state-mock";
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

      const projectRoot = new Path(repoPath);

      // 3. Discover workspaces (empty initially)
      const initialWorkspaces = await provider.discover(projectRoot);
      expect(initialWorkspaces).toHaveLength(0);

      // 4. Create workspace from main branch
      const workspace = await provider.createWorkspace(projectRoot, "feature-test", "main");
      expect(workspace.name).toBe("feature-test");
      expect(workspace.branch).toBe("feature-test");

      // 5. Discover again (finds new workspace)
      const workspaces = await provider.discover(projectRoot);
      expect(workspaces).toHaveLength(1);
      expect(workspaces[0]?.name).toBe("feature-test");

      // 6. Check isDirty (false for clean workspace)
      const isDirty = await provider.isDirty(workspace.path);
      expect(isDirty).toBe(false);

      // 7. Remove workspace
      const result = await provider.removeWorkspace(projectRoot, workspace.path, true);
      expect(result.workspaceRemoved).toBe(true);

      // 8. Verify workspace is gone
      const finalWorkspaces = await provider.discover(projectRoot);
      expect(finalWorkspaces).toHaveLength(0);
    }, 15000);

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

      const projectRoot = new Path(repoPath);

      // Create multiple workspaces
      const ws1 = await provider.createWorkspace(projectRoot, "feature-1", "main");
      const ws2 = await provider.createWorkspace(projectRoot, "feature-2", "main");

      // Should find both
      const workspaces = await provider.discover(projectRoot);
      expect(workspaces).toHaveLength(2);

      // Remove one
      await provider.removeWorkspace(projectRoot, ws1.path, true);

      // Should find only one
      const remaining = await provider.discover(projectRoot);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.name).toBe("feature-2");

      // Cleanup
      await provider.removeWorkspace(projectRoot, ws2.path, true);
    }, 15000);
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

      expect(provider).toBeInstanceOf(GitWorktreeProvider);

      // Should be able to discover workspaces
      const workspaces = await provider.discover(new Path(repoPath));
      expect(workspaces).toHaveLength(0);
    }, 10000);

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
    }, 10000);
  });

  describe("Abstraction layer", () => {
    it("GitWorktreeProvider works with mocked IGitClient", async () => {
      // This test verifies the abstraction by using a behavioral mock git client
      const mockGitClient = createMockGitClient({
        repositories: {
          "/mock/repo": {
            branches: ["main", "feature"],
            remoteBranches: ["origin/main"],
            remotes: ["origin"],
            currentBranch: "main",
            worktrees: [
              {
                name: "feature",
                path: "/mock/workspaces/feature",
                branch: "feature",
              },
            ],
          },
        },
      });

      const mockFileSystemLayer = createFileSystemMock({
        entries: {
          "/mock/workspaces": directory(),
        },
      });
      const provider = await GitWorktreeProvider.create(
        new Path("/mock/repo"),
        mockGitClient,
        new Path("/mock/workspaces"),
        mockFileSystemLayer,
        SILENT_LOGGER
      );

      const projectRoot = new Path("/mock/repo");

      // Should work with the mock
      const workspaces = await provider.discover(projectRoot);
      expect(workspaces).toHaveLength(1);
      expect(workspaces[0]?.name).toBe("feature");

      const bases = await provider.listBases(projectRoot);
      expect(bases).toHaveLength(3); // main, feature (local), origin/main (remote)
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

        const projectRoot = new Path(repo.path);

        // Create a workspace
        const workspace = await provider.createWorkspace(projectRoot, "dirty-feature", "main");

        // Initial workspace should be clean
        const isDirty = await provider.isDirty(workspace.path);
        expect(isDirty).toBe(false);

        // Main repo is dirty
        const mainDirty = await provider.isDirty(projectRoot);
        expect(mainDirty).toBe(true);

        // Cleanup
        await provider.removeWorkspace(projectRoot, workspace.path, true);
      } finally {
        await repo.cleanup();
        await tempDir.cleanup();
      }
    }, 15000);
  });
});
