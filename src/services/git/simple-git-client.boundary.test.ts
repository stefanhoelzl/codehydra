// @vitest-environment node
/**
 * Boundary tests for SimpleGitClient.
 * These tests use real git repositories to verify the implementation.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SimpleGitClient } from "./simple-git-client";
import { GitError } from "../errors";
import {
  createTestGitRepo,
  createCommitInRemote,
  createTempDir,
  withTempRepoWithRemote,
} from "../test-utils";
import { promises as fs } from "fs";
import path from "path";
import { simpleGit } from "simple-git";

describe("SimpleGitClient", () => {
  let client: SimpleGitClient;
  let cleanup: () => Promise<void>;
  let repoPath: string;

  beforeEach(async () => {
    client = new SimpleGitClient();
    const result = await createTestGitRepo();
    repoPath = result.path;
    cleanup = result.cleanup;
  });

  afterEach(async () => {
    await cleanup();
  });

  describe("isGitRepository", () => {
    it("returns true for a git repository", async () => {
      const result = await client.isGitRepository(repoPath);

      expect(result).toBe(true);
    });

    it("returns false for a non-git directory", async () => {
      const tempDir = await createTempDir();
      try {
        const result = await client.isGitRepository(tempDir.path);
        expect(result).toBe(false);
      } finally {
        await tempDir.cleanup();
      }
    });

    it("throws GitError for non-existent path", async () => {
      const nonExistentPath = path.join(repoPath, "non-existent");

      await expect(client.isGitRepository(nonExistentPath)).rejects.toThrow(GitError);
    });
  });

  describe("listWorktrees", () => {
    it("lists main worktree", async () => {
      const worktrees = await client.listWorktrees(repoPath);

      expect(worktrees).toHaveLength(1);
      expect(worktrees[0].isMain).toBe(true);
      expect(worktrees[0].path).toBe(repoPath);
    });

    it("includes branch information", async () => {
      const worktrees = await client.listWorktrees(repoPath);

      expect(worktrees[0].branch).toBe("main");
    });

    it("throws GitError for non-git directory", async () => {
      const tempDir = await createTempDir();
      try {
        await expect(client.listWorktrees(tempDir.path)).rejects.toThrow(GitError);
      } finally {
        await tempDir.cleanup();
      }
    });
  });

  describe("addWorktree and removeWorktree", () => {
    let worktreePath: string;

    beforeEach(async () => {
      // Create a branch to use for the worktree
      await client.createBranch(repoPath, "feature-branch", "main");
      worktreePath = path.join(path.dirname(repoPath), "worktree-test");
    });

    afterEach(async () => {
      // Clean up worktree if it exists
      try {
        await fs.rm(worktreePath, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    });

    it("adds a worktree", async () => {
      await client.addWorktree(repoPath, worktreePath, "feature-branch");

      const worktrees = await client.listWorktrees(repoPath);
      expect(worktrees).toHaveLength(2);

      const newWorktree = worktrees.find((w) => !w.isMain);
      expect(newWorktree).toBeDefined();
      expect(newWorktree!.path).toBe(worktreePath);
      expect(newWorktree!.branch).toBe("feature-branch");
    });

    it("removes a worktree", async () => {
      await client.addWorktree(repoPath, worktreePath, "feature-branch");
      await client.removeWorktree(repoPath, worktreePath);

      const worktrees = await client.listWorktrees(repoPath);
      expect(worktrees).toHaveLength(1);
      expect(worktrees[0].isMain).toBe(true);
    });

    it("throws GitError when adding worktree with non-existent branch", async () => {
      await expect(
        client.addWorktree(repoPath, worktreePath, "non-existent-branch")
      ).rejects.toThrow(GitError);
    });

    it("throws GitError when removing non-existent worktree", async () => {
      await expect(client.removeWorktree(repoPath, "/non/existent/path")).rejects.toThrow(GitError);
    });
  });

  describe("pruneWorktrees", () => {
    it("prunes stale worktree entries", async () => {
      // Create a worktree
      await client.createBranch(repoPath, "prune-test", "main");
      const worktreePath = path.join(path.dirname(repoPath), "worktree-prune");
      await client.addWorktree(repoPath, worktreePath, "prune-test");

      // Manually delete the worktree directory (simulating stale entry)
      await fs.rm(worktreePath, { recursive: true, force: true });

      // Prune should not throw
      await expect(client.pruneWorktrees(repoPath)).resolves.not.toThrow();
    });
  });

  describe("listBranches", () => {
    it("lists local branches", async () => {
      const branches = await client.listBranches(repoPath);

      expect(branches.length).toBeGreaterThanOrEqual(1);
      const mainBranch = branches.find((b) => b.name === "main" && !b.isRemote);
      expect(mainBranch).toBeDefined();
    });

    it("includes newly created branches", async () => {
      await client.createBranch(repoPath, "new-feature", "main");

      const branches = await client.listBranches(repoPath);

      const newBranch = branches.find((b) => b.name === "new-feature" && !b.isRemote);
      expect(newBranch).toBeDefined();
    });
  });

  describe("createBranch and deleteBranch", () => {
    it("creates a branch", async () => {
      await client.createBranch(repoPath, "test-branch", "main");

      const branches = await client.listBranches(repoPath);
      const created = branches.find((b) => b.name === "test-branch");
      expect(created).toBeDefined();
    });

    it("deletes a branch", async () => {
      await client.createBranch(repoPath, "to-delete", "main");
      await client.deleteBranch(repoPath, "to-delete");

      const branches = await client.listBranches(repoPath);
      const deleted = branches.find((b) => b.name === "to-delete");
      expect(deleted).toBeUndefined();
    });

    it("throws GitError when creating branch that already exists", async () => {
      await client.createBranch(repoPath, "duplicate", "main");

      await expect(client.createBranch(repoPath, "duplicate", "main")).rejects.toThrow(GitError);
    });

    it("throws GitError when deleting non-existent branch", async () => {
      await expect(client.deleteBranch(repoPath, "non-existent")).rejects.toThrow(GitError);
    });

    it("throws GitError when deleting currently checked out branch", async () => {
      // main is the current branch
      await expect(client.deleteBranch(repoPath, "main")).rejects.toThrow(GitError);
    });
  });

  describe("getCurrentBranch", () => {
    it("returns current branch name", async () => {
      const branch = await client.getCurrentBranch(repoPath);

      expect(branch).toBe("main");
    });

    it("returns null for detached HEAD", async () => {
      const detachedRepo = await createTestGitRepo({ detached: true });
      try {
        const branch = await client.getCurrentBranch(detachedRepo.path);
        expect(branch).toBeNull();
      } finally {
        await detachedRepo.cleanup();
      }
    });

    it("throws GitError for non-git directory", async () => {
      const tempDir = await createTempDir();
      try {
        await expect(client.getCurrentBranch(tempDir.path)).rejects.toThrow(GitError);
      } finally {
        await tempDir.cleanup();
      }
    });
  });

  describe("getStatus", () => {
    it("returns clean status for clean repo", async () => {
      const status = await client.getStatus(repoPath);

      expect(status.isDirty).toBe(false);
      expect(status.modifiedCount).toBe(0);
      expect(status.stagedCount).toBe(0);
      expect(status.untrackedCount).toBe(0);
    });

    it("detects dirty state", async () => {
      const dirtyRepo = await createTestGitRepo({ dirty: true });
      try {
        const status = await client.getStatus(dirtyRepo.path);

        expect(status.isDirty).toBe(true);
        expect(status.modifiedCount + status.untrackedCount).toBeGreaterThan(0);
      } finally {
        await dirtyRepo.cleanup();
      }
    });

    it("counts untracked files", async () => {
      // Create an untracked file
      await fs.writeFile(path.join(repoPath, "untracked.txt"), "untracked content");

      const status = await client.getStatus(repoPath);

      expect(status.untrackedCount).toBe(1);
      expect(status.isDirty).toBe(true);
    });

    it("counts staged files", async () => {
      // Create and stage a file
      const filePath = path.join(repoPath, "staged.txt");
      await fs.writeFile(filePath, "staged content");

      // Use simple-git directly to stage the file
      const simpleGit = (await import("simple-git")).default;
      const git = simpleGit(repoPath);
      await git.add("staged.txt");

      const status = await client.getStatus(repoPath);

      expect(status.stagedCount).toBe(1);
      expect(status.isDirty).toBe(true);
    });
  });

  describe("fetch", () => {
    it("does not throw for repo without remotes", async () => {
      // Fresh repo has no remotes
      await expect(client.fetch(repoPath)).resolves.not.toThrow();
    });

    it("fetches from configured origin", async () => {
      await withTempRepoWithRemote(async (path) => {
        await expect(client.fetch(path)).resolves.not.toThrow();
      });
    });

    it("fetches new commits from remote", async () => {
      await withTempRepoWithRemote(async (path, remotePath) => {
        // Create commit in remote
        await createCommitInRemote(remotePath, "Remote commit");

        await client.fetch(path);

        // Verify remote ref is updated (origin/main has new commit)
        const git = simpleGit(path);
        const log = await git.log(["origin/main"]);
        expect(log.latest?.message).toBe("Remote commit");
      });
    });

    it("fetches with explicit remote name", async () => {
      await withTempRepoWithRemote(async (path) => {
        await expect(client.fetch(path, "origin")).resolves.not.toThrow();
      });
    });

    it("throws GitError when fetching from non-existent remote", async () => {
      await withTempRepoWithRemote(async (path) => {
        await expect(client.fetch(path, "nonexistent")).rejects.toThrow(GitError);
      });
    });
  });

  describe("listRemotes", () => {
    it("returns empty array for repo without remotes", async () => {
      const remotes = await client.listRemotes(repoPath);

      expect(remotes).toEqual([]);
    });

    it("returns configured remotes", async () => {
      await withTempRepoWithRemote(async (path) => {
        const remotes = await client.listRemotes(path);
        expect(remotes).toEqual(["origin"]);
      });
    });

    it("returns multiple remotes when configured", async () => {
      await withTempRepoWithRemote(async (path) => {
        // Add second remote
        const git = simpleGit(path);
        await git.addRemote("upstream", "../upstream.git");

        const remotes = await client.listRemotes(path);
        expect(remotes).toHaveLength(2);
        expect(remotes).toContain("origin");
        expect(remotes).toContain("upstream");
      });
    });
  });
});
