// @vitest-environment node
/**
 * Integration tests for the services layer.
 * Tests full workflows with real git repos and filesystem.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestGitRepo, createTempDir } from "./test-utils";
import { SimpleGitClient } from "./git/simple-git-client";
import { GitWorktreeProvider } from "./git/git-worktree-provider";
import { ProjectStore } from "./project/project-store";
import { createGitWorktreeProvider } from "./index";
import * as paths from "./platform/paths";
import { projectDirName } from "./platform/paths";
import path from "path";

describe("Services Integration", () => {
  describe("Full workflow", () => {
    let repoCleanup: () => Promise<void>;
    let tempCleanup: () => Promise<void>;
    let repoPath: string;
    let projectsDir: string;

    beforeEach(async () => {
      const repo = await createTestGitRepo();
      repoPath = repo.path;
      repoCleanup = repo.cleanup;

      const tempDir = await createTempDir();
      projectsDir = path.join(tempDir.path, "projects");
      tempCleanup = tempDir.cleanup;

      // Mock getProjectWorkspacesDir to use temp directory for workspace creation
      vi.spyOn(paths, "getProjectWorkspacesDir").mockImplementation((projectPath: string) =>
        path.join(projectsDir, projectDirName(projectPath), "workspaces")
      );
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      await repoCleanup();
      await tempCleanup();
    });

    it("performs complete project and workspace workflow", async () => {
      // 1. Create project store and save project
      const projectStore = new ProjectStore(projectsDir);
      await projectStore.saveProject(repoPath);

      // Verify project is saved
      const savedProjects = await projectStore.loadAllProjects();
      expect(savedProjects).toContain(repoPath);

      // 2. Create GitWorktreeProvider with SimpleGitClient
      const gitClient = new SimpleGitClient();
      const provider = await GitWorktreeProvider.create(repoPath, gitClient);

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
      expect(workspaces[0].name).toBe("feature-test");

      // 6. Check isDirty (false for clean workspace)
      const isDirty = await provider.isDirty(workspace.path);
      expect(isDirty).toBe(false);

      // 7. Check isMainWorkspace
      expect(provider.isMainWorkspace(repoPath)).toBe(true);
      expect(provider.isMainWorkspace(workspace.path)).toBe(false);

      // 8. Remove workspace
      const removal = await provider.removeWorkspace(workspace.path, true);
      expect(removal.workspaceRemoved).toBe(true);
      expect(removal.baseDeleted).toBe(true);

      // 9. Discover again (empty)
      const finalWorkspaces = await provider.discover();
      expect(finalWorkspaces).toHaveLength(0);
    });

    it("handles multiple workspaces", async () => {
      const gitClient = new SimpleGitClient();
      const provider = await GitWorktreeProvider.create(repoPath, gitClient);

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
      expect(remaining[0].name).toBe("feature-2");

      // Cleanup
      await provider.removeWorkspace(ws2.path, true);
    });
  });

  describe("Factory function", () => {
    let repoCleanup: () => Promise<void>;
    let repoPath: string;

    beforeEach(async () => {
      const repo = await createTestGitRepo();
      repoPath = repo.path;
      repoCleanup = repo.cleanup;
    });

    afterEach(async () => {
      await repoCleanup();
    });

    it("createGitWorktreeProvider creates provider successfully", async () => {
      const provider = await createGitWorktreeProvider(repoPath);

      expect(provider.projectRoot).toBe(repoPath);

      // Should be able to discover workspaces
      const workspaces = await provider.discover();
      expect(workspaces).toHaveLength(0);
    });

    it("createGitWorktreeProvider throws for non-git directory", async () => {
      const tempDir = await createTempDir();
      try {
        await expect(createGitWorktreeProvider(tempDir.path)).rejects.toThrow();
      } finally {
        await tempDir.cleanup();
      }
    });
  });

  describe("Abstraction layer", () => {
    it("IWorkspaceProvider works with mocked IGitClient", async () => {
      // This test verifies the abstraction by using a mocked git client
      const mockGitClient = {
        isGitRepository: async () => true,
        listWorktrees: async () => [
          { name: "main", path: "/mock/repo", branch: "main", isMain: true },
          {
            name: "feature",
            path: "/mock/workspaces/feature",
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
      };

      const provider = await GitWorktreeProvider.create("/mock/repo", mockGitClient);

      // Should work with the mock
      const workspaces = await provider.discover();
      expect(workspaces).toHaveLength(1);
      expect(workspaces[0].name).toBe("feature");

      const bases = await provider.listBases();
      expect(bases).toHaveLength(2);
    });
  });

  describe("Error handling", () => {
    it("handles workspace with uncommitted changes", async () => {
      const repo = await createTestGitRepo({ dirty: true });
      const tempDir = await createTempDir();

      // Mock getProjectWorkspacesDir to use temp directory for workspace creation
      vi.spyOn(paths, "getProjectWorkspacesDir").mockImplementation((projectPath: string) =>
        path.join(tempDir.path, projectDirName(projectPath), "workspaces")
      );

      try {
        const gitClient = new SimpleGitClient();
        const provider = await GitWorktreeProvider.create(repo.path, gitClient);

        // Create a workspace
        const workspace = await provider.createWorkspace("dirty-feature", "main");

        // Initial workspace should be clean
        const isDirty = await provider.isDirty(workspace.path);
        expect(isDirty).toBe(false);

        // Main repo is dirty
        const mainDirty = await provider.isDirty(repo.path);
        expect(mainDirty).toBe(true);

        // Cleanup
        await provider.removeWorkspace(workspace.path, true);
      } finally {
        vi.restoreAllMocks();
        await repo.cleanup();
        await tempDir.cleanup();
      }
    });
  });
});
