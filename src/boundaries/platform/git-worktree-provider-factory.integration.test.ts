// @vitest-environment node
/**
 * Integration tests for the services layer.
 * Tests full workflows with real git repos and filesystem.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestGitRepo, createTempDir, detachHead } from "../../utils/testing/test-utils";
import { SimpleGitClient } from "./simple-git-client";
import { GitWorktreeProvider } from "./git-worktree-provider";
import type { IGitClient } from "./git-client";
import type { FileSystemBoundary } from "./filesystem";
import type { Logger } from "./logging";
import { DefaultFileSystemBoundary } from "./filesystem";
import { SILENT_LOGGER } from "./logging";
import { createFileSystemMock, directory } from "./filesystem.state-mock";
import { createMockGitClient } from "./git-client.state-mock";
import { projectDirName } from "./paths";
import { Path } from "../../utils/path/path";
import path from "path";

/** Construct a provider the way production does: new + validateRepository + registerProject. */
async function createProvider(
  projectRoot: Path,
  gitClient: IGitClient,
  workspacesDir: Path,
  fileSystemLayer: FileSystemBoundary,
  logger: Logger
): Promise<GitWorktreeProvider> {
  const provider = new GitWorktreeProvider(gitClient, fileSystemLayer, logger);
  await provider.validateRepository(projectRoot);
  provider.registerProject(projectRoot, workspacesDir);
  return provider;
}

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
      // 1. Create GitWorktreeProvider with SimpleGitClient
      const fileSystemLayer = new DefaultFileSystemBoundary(SILENT_LOGGER);
      const gitClient = new SimpleGitClient(SILENT_LOGGER);
      const workspacesDir = getWorkspacesDir(repoPath);
      const provider = await createProvider(
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

    it("prunes codehydra config left behind by a hand-deleted branch", async () => {
      const fileSystemLayer = new DefaultFileSystemBoundary(SILENT_LOGGER);
      const gitClient = new SimpleGitClient(SILENT_LOGGER);
      const workspacesDir = getWorkspacesDir(repoPath);
      const provider = await createProvider(
        new Path(repoPath),
        gitClient,
        new Path(workspacesDir),
        fileSystemLayer,
        SILENT_LOGGER
      );
      const projectRoot = new Path(repoPath);

      const kept = await provider.createWorkspace(projectRoot, "still-here", "main");
      await provider.createWorkspace(projectRoot, "hand-deleted", "main");

      // Delete the branch the way a user would — the worktree and the
      // [branch "hand-deleted.codehydra"] section both survive this.
      await gitClient.removeWorktree(projectRoot, new Path(workspacesDir, "hand-deleted"));
      await gitClient.deleteBranch(projectRoot, "hand-deleted");
      const before = await gitClient.getGitConfig(projectRoot, {
        regex: `^branch\\.hand-deleted\\.codehydra\\.`,
      });
      expect(before.size).toBeGreaterThan(0);

      await provider.cleanupOrphanedWorkspaces(projectRoot);

      const after = await gitClient.getGitConfig(projectRoot, {
        regex: `^branch\\.hand-deleted\\.codehydra\\.`,
      });
      expect(after.size).toBe(0);
      // The surviving branch keeps both its branch and its metadata.
      const stillHere = await gitClient.getGitConfig(projectRoot, {
        regex: `^branch\\.still-here\\.codehydra\\.`,
      });
      expect(stillHere.size).toBeGreaterThan(0);
      expect(kept.branch).toBe("still-here");
    }, 15000);

    it("deletes the branch of a detached workspace and clears its metadata", async () => {
      // Regression: a rebase that stops on a conflict leaves HEAD detached, so
      // `git worktree list` reports no branch for it. The branch name was then
      // null, which skipped both the metadata cleanup and the branch delete —
      // the worktree went away, no error was raised, and the branch was orphaned.
      const fileSystemLayer = new DefaultFileSystemBoundary(SILENT_LOGGER);
      const gitClient = new SimpleGitClient(SILENT_LOGGER);
      const workspacesDir = getWorkspacesDir(repoPath);
      const provider = await createProvider(
        new Path(repoPath),
        gitClient,
        new Path(workspacesDir),
        fileSystemLayer,
        SILENT_LOGGER
      );
      const projectRoot = new Path(repoPath);

      const workspace = await provider.createWorkspace(projectRoot, "detach-me", "main");

      // Detach HEAD, exactly as an interrupted rebase leaves it.
      await detachHead(workspace.path.toNative());
      const worktrees = await gitClient.listWorktrees(projectRoot);
      expect(worktrees.find((wt) => wt.path.equals(workspace.path))?.branch).toBeNull();

      const result = await provider.removeWorkspace(projectRoot, workspace.path, true);

      expect(result.workspaceRemoved).toBe(true);
      expect(result.baseDeleted).toBe(true);
      const branches = await gitClient.listBranches(projectRoot);
      expect(branches.some((b) => b.name === "detach-me" && !b.isRemote)).toBe(false);
      const metadata = await gitClient.getGitConfig(projectRoot, {
        regex: `^branch\\.detach-me\\.codehydra\\.`,
      });
      expect(metadata.size).toBe(0);
    }, 15000);

    it("handles multiple workspaces", async () => {
      const fileSystemLayer = new DefaultFileSystemBoundary(SILENT_LOGGER);
      const gitClient = new SimpleGitClient(SILENT_LOGGER);
      const workspacesDir = getWorkspacesDir(repoPath);
      const provider = await createProvider(
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

  describe("Repository validation", () => {
    let tempDir: string;
    let tempCleanup: () => Promise<void>;

    /** Get the workspaces directory for a project (using temp directory) */
    function getWorkspacesDir(projectPath: string): string {
      return path.join(tempDir, projectDirName(projectPath), "workspaces");
    }

    beforeEach(async () => {
      const temp = await createTempDir();
      tempDir = temp.path;
      tempCleanup = temp.cleanup;
    });

    afterEach(async () => {
      await tempCleanup();
    });

    it("provider construction throws for non-git directory", async () => {
      const nonGitDir = await createTempDir();
      try {
        const workspacesDir = getWorkspacesDir(nonGitDir.path);
        const fileSystemLayer = new DefaultFileSystemBoundary(SILENT_LOGGER);
        const gitClient = new SimpleGitClient(SILENT_LOGGER);
        await expect(
          createProvider(
            new Path(nonGitDir.path),
            gitClient,
            new Path(workspacesDir),
            fileSystemLayer,
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

      const mockFileSystemBoundary = createFileSystemMock({
        entries: {
          "/mock/workspaces": directory(),
        },
      });
      const provider = await createProvider(
        new Path("/mock/repo"),
        mockGitClient,
        new Path("/mock/workspaces"),
        mockFileSystemBoundary,
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
        const fileSystemLayer = new DefaultFileSystemBoundary(SILENT_LOGGER);
        const gitClient = new SimpleGitClient(SILENT_LOGGER);
        const workspacesDir = getWorkspacesDir(repo.path);
        const provider = await createProvider(
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
