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
import nodePath from "path";
import { simpleGit } from "simple-git";
import { SILENT_LOGGER } from "../logging";
import { Path } from "../platform/path";

describe("SimpleGitClient", () => {
  let client: SimpleGitClient;
  let cleanup: () => Promise<void>;
  let repoPath: Path;

  beforeEach(async () => {
    client = new SimpleGitClient(SILENT_LOGGER);
    const result = await createTestGitRepo();
    repoPath = new Path(result.path);
    cleanup = result.cleanup;
  });

  afterEach(async () => {
    await cleanup();
  });

  describe("isRepositoryRoot", () => {
    it("returns true for a git repository root", async () => {
      const result = await client.isRepositoryRoot(repoPath);

      expect(result).toBe(true);
    });

    it("returns false for a subdirectory within a git repository", async () => {
      // Create a subdirectory
      const subDir = new Path(repoPath, "subdir");
      await fs.mkdir(subDir.toNative());

      const result = await client.isRepositoryRoot(subDir);

      expect(result).toBe(false);
    });

    it("returns false for a non-git directory", async () => {
      const tempDir = await createTempDir();
      try {
        const result = await client.isRepositoryRoot(new Path(tempDir.path));
        expect(result).toBe(false);
      } finally {
        await tempDir.cleanup();
      }
    });

    it("throws GitError for non-existent path", async () => {
      const nonExistentPath = new Path(repoPath, "non-existent");

      await expect(client.isRepositoryRoot(nonExistentPath)).rejects.toThrow(GitError);
    });
  });

  describe("listWorktrees", () => {
    it("lists main worktree", async () => {
      const worktrees = await client.listWorktrees(repoPath);

      expect(worktrees).toHaveLength(1);
      expect(worktrees[0]!.isMain).toBe(true);
      expect(worktrees[0]!.path.equals(repoPath)).toBe(true);
    });

    it("includes branch information", async () => {
      const worktrees = await client.listWorktrees(repoPath);

      expect(worktrees[0]!.branch).toBe("main");
    });

    it("throws GitError for non-git directory", async () => {
      const tempDir = await createTempDir();
      try {
        await expect(client.listWorktrees(new Path(tempDir.path))).rejects.toThrow(GitError);
      } finally {
        await tempDir.cleanup();
      }
    });
  });

  describe("addWorktree and removeWorktree", () => {
    let worktreePath: Path;

    beforeEach(async () => {
      // Create a branch to use for the worktree
      await client.createBranch(repoPath, "feature-branch", "main");
      worktreePath = new Path(repoPath.dirname, "worktree-test");
    });

    afterEach(async () => {
      // Clean up worktree if it exists
      try {
        await fs.rm(worktreePath.toNative(), { recursive: true, force: true });
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
      expect(newWorktree!.path.equals(worktreePath)).toBe(true);
      expect(newWorktree!.branch).toBe("feature-branch");
    });

    it("removes a worktree", async () => {
      await client.addWorktree(repoPath, worktreePath, "feature-branch");
      await client.removeWorktree(repoPath, worktreePath);

      const worktrees = await client.listWorktrees(repoPath);
      expect(worktrees).toHaveLength(1);
      expect(worktrees[0]!.isMain).toBe(true);
    });

    it("throws GitError when adding worktree with non-existent branch", async () => {
      await expect(
        client.addWorktree(repoPath, worktreePath, "non-existent-branch")
      ).rejects.toThrow(GitError);
    });

    it("throws GitError when removing non-existent worktree", async () => {
      const nonExistentPath = new Path(repoPath.dirname, "non-existent");
      await expect(client.removeWorktree(repoPath, nonExistentPath)).rejects.toThrow(GitError);
    });
  });

  describe("pruneWorktrees", () => {
    it("prunes stale worktree entries", async () => {
      // Create a worktree
      await client.createBranch(repoPath, "prune-test", "main");
      const worktreePath = new Path(repoPath.dirname, "worktree-prune");
      await client.addWorktree(repoPath, worktreePath, "prune-test");

      // Manually delete the worktree directory (simulating stale entry)
      await fs.rm(worktreePath.toNative(), { recursive: true, force: true });

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
        const branch = await client.getCurrentBranch(new Path(detachedRepo.path));
        expect(branch).toBeNull();
      } finally {
        await detachedRepo.cleanup();
      }
    });

    it("throws GitError for non-git directory", async () => {
      const tempDir = await createTempDir();
      try {
        await expect(client.getCurrentBranch(new Path(tempDir.path))).rejects.toThrow(GitError);
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
        const status = await client.getStatus(new Path(dirtyRepo.path));

        expect(status.isDirty).toBe(true);
        expect(status.modifiedCount + status.untrackedCount).toBeGreaterThan(0);
      } finally {
        await dirtyRepo.cleanup();
      }
    });

    it("counts untracked files", async () => {
      // Create an untracked file
      await fs.writeFile(nodePath.join(repoPath.toNative(), "untracked.txt"), "untracked content");

      const status = await client.getStatus(repoPath);

      expect(status.untrackedCount).toBe(1);
      expect(status.isDirty).toBe(true);
    });

    it("counts staged files", async () => {
      // Create and stage a file
      const filePath = nodePath.join(repoPath.toNative(), "staged.txt");
      await fs.writeFile(filePath, "staged content");

      // Use simple-git directly to stage the file
      const git = simpleGit(repoPath.toNative());
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
        await expect(client.fetch(new Path(path))).resolves.not.toThrow();
      });
    }, 15000);

    it("fetches new commits from remote", async () => {
      await withTempRepoWithRemote(async (path, remotePath) => {
        // Create commit in remote
        await createCommitInRemote(remotePath, "Remote commit");

        await client.fetch(new Path(path));

        // Verify remote ref is updated (origin/main has new commit)
        const git = simpleGit(path);
        const log = await git.log(["origin/main"]);
        expect(log.latest?.message).toBe("Remote commit");
      });
    }, 15000);

    it("fetches with explicit remote name", async () => {
      await withTempRepoWithRemote(async (path) => {
        await expect(client.fetch(new Path(path), "origin")).resolves.not.toThrow();
      });
    }, 15000);

    it("throws GitError when fetching from non-existent remote", async () => {
      await withTempRepoWithRemote(async (path) => {
        await expect(client.fetch(new Path(path), "nonexistent")).rejects.toThrow(GitError);
      });
    }, 15000);

    it("prunes stale remote-tracking branches after fetch", async () => {
      await withTempRepoWithRemote(async (path, remotePath) => {
        // Create a branch in remote, fetch it, then delete from remote
        const tempClone = await createTempDir();
        try {
          const cloneGit = simpleGit(tempClone.path);
          await cloneGit.clone(remotePath, ".", ["--branch", "main"]);
          await cloneGit.addConfig("user.email", "test@test.com");
          await cloneGit.addConfig("user.name", "Test User");
          await cloneGit.checkoutLocalBranch("feature-to-delete");
          await fs.writeFile(nodePath.join(tempClone.path, "temp.txt"), "temp");
          await cloneGit.add("temp.txt");
          await cloneGit.commit("Temp commit");
          await cloneGit.push(["-u", "origin", "feature-to-delete"]);

          // Fetch in working repo to get the remote branch
          await client.fetch(new Path(path), "origin");

          // Verify remote-tracking branch exists
          let branches = await client.listBranches(new Path(path));
          const hasRemoteBranch = branches.some(
            (b) => b.name === "origin/feature-to-delete" && b.isRemote
          );
          expect(hasRemoteBranch).toBe(true);

          // Delete branch from remote
          await cloneGit.push(["origin", "--delete", "feature-to-delete"]);

          // Fetch with prune - should remove stale remote-tracking branch
          await client.fetch(new Path(path), "origin");

          // Verify remote-tracking branch is gone
          branches = await client.listBranches(new Path(path));
          const stillHasRemoteBranch = branches.some(
            (b) => b.name === "origin/feature-to-delete" && b.isRemote
          );
          expect(stillHasRemoteBranch).toBe(false);
        } finally {
          await tempClone.cleanup();
        }
      });
    }, 30000);
  });

  describe("listRemotes", () => {
    it("returns empty array for repo without remotes", async () => {
      const remotes = await client.listRemotes(repoPath);

      expect(remotes).toEqual([]);
    });

    it("returns configured remotes", async () => {
      await withTempRepoWithRemote(async (path) => {
        const remotes = await client.listRemotes(new Path(path));
        expect(remotes).toEqual(["origin"]);
      });
    });

    it("returns multiple remotes when configured", async () => {
      await withTempRepoWithRemote(async (path) => {
        // Add second remote
        const git = simpleGit(path);
        await git.addRemote("upstream", "../upstream.git");

        const remotes = await client.listRemotes(new Path(path));
        expect(remotes).toHaveLength(2);
        expect(remotes).toContain("origin");
        expect(remotes).toContain("upstream");
      });
    });
  });

  describe("getBranchConfigsByPrefix", () => {
    it("returns all codehydra.* configs for a branch", async () => {
      // Set multiple config values with codehydra prefix
      await client.setBranchConfig(repoPath, "main", "codehydra.base", "develop");
      await client.setBranchConfig(repoPath, "main", "codehydra.note", "WIP feature");

      const configs = await client.getBranchConfigsByPrefix(repoPath, "main", "codehydra");

      expect(configs).toEqual({
        base: "develop",
        note: "WIP feature",
      });
    });

    it("returns empty object when no configs exist", async () => {
      const configs = await client.getBranchConfigsByPrefix(repoPath, "main", "codehydra");

      expect(configs).toEqual({});
    });

    it("handles values with spaces", async () => {
      await client.setBranchConfig(
        repoPath,
        "main",
        "codehydra.note",
        "Work in progress with spaces"
      );

      const configs = await client.getBranchConfigsByPrefix(repoPath, "main", "codehydra");

      expect(configs.note).toBe("Work in progress with spaces");
    });

    it("handles values with equals signs", async () => {
      await client.setBranchConfig(repoPath, "main", "codehydra.equation", "x=y+z");

      const configs = await client.getBranchConfigsByPrefix(repoPath, "main", "codehydra");

      expect(configs.equation).toBe("x=y+z");
    });

    it("only returns configs matching the prefix", async () => {
      // Set configs with different prefixes
      await client.setBranchConfig(repoPath, "main", "codehydra.base", "develop");
      await client.setBranchConfig(repoPath, "main", "other.key", "value");

      const configs = await client.getBranchConfigsByPrefix(repoPath, "main", "codehydra");

      expect(configs).toEqual({ base: "develop" });
      expect(configs).not.toHaveProperty("key");
    });

    it("throws GitError for non-repo path", async () => {
      const tempDir = await createTempDir();
      try {
        await expect(
          client.getBranchConfigsByPrefix(new Path(tempDir.path), "main", "codehydra")
        ).rejects.toThrow(GitError);
      } finally {
        await tempDir.cleanup();
      }
    });
  });

  describe("unsetBranchConfig", () => {
    it("removes a config key", async () => {
      // Set config first
      await client.setBranchConfig(repoPath, "main", "codehydra.note", "to be removed");
      const before = await client.getBranchConfig(repoPath, "main", "codehydra.note");
      expect(before).toBe("to be removed");

      // Unset it
      await client.unsetBranchConfig(repoPath, "main", "codehydra.note");

      // Verify it's gone
      const after = await client.getBranchConfig(repoPath, "main", "codehydra.note");
      expect(after).toBeNull();
    });

    it("does not throw for non-existent key", async () => {
      // Should handle gracefully
      await expect(
        client.unsetBranchConfig(repoPath, "main", "codehydra.nonexistent")
      ).resolves.not.toThrow();
    });

    it("throws GitError for non-repo path", async () => {
      const tempDir = await createTempDir();
      try {
        await expect(
          client.unsetBranchConfig(new Path(tempDir.path), "main", "codehydra.note")
        ).rejects.toThrow(GitError);
      } finally {
        await tempDir.cleanup();
      }
    });
  });

  describe("getBranchConfig and setBranchConfig", () => {
    it("getBranchConfig returns null for non-existent config", async () => {
      const value = await client.getBranchConfig(repoPath, "main", "nonexistent");

      expect(value).toBeNull();
    });

    it("setBranchConfig stores value retrievable by getBranchConfig", async () => {
      await client.setBranchConfig(repoPath, "main", "base", "develop");

      const value = await client.getBranchConfig(repoPath, "main", "base");
      expect(value).toBe("develop");
    });

    it("config persists across client instances", async () => {
      await client.setBranchConfig(repoPath, "main", "base", "feature-branch");

      // Create a new client instance
      const newClient = new SimpleGitClient(SILENT_LOGGER);
      const value = await newClient.getBranchConfig(repoPath, "main", "base");
      expect(value).toBe("feature-branch");
    });

    it("config works with branch names containing slashes", async () => {
      // Create a branch with slashes
      await client.createBranch(repoPath, "feature/foo/bar", "main");

      await client.setBranchConfig(repoPath, "feature/foo/bar", "base", "main");

      const value = await client.getBranchConfig(repoPath, "feature/foo/bar", "base");
      expect(value).toBe("main");
    });

    it("setBranchConfig succeeds for non-existent branch", async () => {
      // Git allows setting config for non-existent branches
      // (config is just a key-value store)
      await expect(
        client.setBranchConfig(repoPath, "nonexistent-branch", "base", "main")
      ).resolves.not.toThrow();

      const value = await client.getBranchConfig(repoPath, "nonexistent-branch", "base");
      expect(value).toBe("main");
    });

    it("getBranchConfig throws GitError for non-repo path", async () => {
      const tempDir = await createTempDir();
      try {
        await expect(
          client.getBranchConfig(new Path(tempDir.path), "main", "base")
        ).rejects.toThrow(GitError);
      } finally {
        await tempDir.cleanup();
      }
    });
  });

  describe("clone", () => {
    it("clones a bare repository from local path", async () => {
      // Create a temp dir with a source repo
      const sourceRepo = await createTestGitRepo();
      const targetDir = await createTempDir();
      const targetPath = new Path(targetDir.path, "cloned.git");

      try {
        await client.clone(sourceRepo.path, targetPath);

        // Verify it's a bare repo by checking for typical bare repo structure
        const { readdir, stat } = await import("fs/promises");
        const entries = await readdir(targetPath.toNative());
        // Bare repos have HEAD, config, objects, refs at root (not in .git subdir)
        expect(entries).toContain("HEAD");
        expect(entries).toContain("config");
        expect(entries).toContain("objects");
        expect(entries).toContain("refs");
        // Should NOT have .git directory (that's for non-bare repos)
        expect(entries).not.toContain(".git");

        // Verify HEAD exists (bare repos have it at root)
        const headStat = await stat(nodePath.join(targetPath.toNative(), "HEAD"));
        expect(headStat.isFile()).toBe(true);
      } finally {
        await sourceRepo.cleanup();
        await targetDir.cleanup();
      }
    });

    it("sets up remote-tracking branches and removes local branches", async () => {
      // Create a source repo with multiple branches
      const sourceRepo = await createTestGitRepo();
      const sourceGit = simpleGit(sourceRepo.path);
      await sourceGit.checkoutLocalBranch("feature-a");
      await sourceGit.checkout("main");
      await sourceGit.checkoutLocalBranch("feature-b");
      await sourceGit.checkout("main");

      const targetDir = await createTempDir();
      const targetPath = new Path(targetDir.path, "cloned.git");

      try {
        await client.clone(sourceRepo.path, targetPath);

        // After clone, should have ONLY remote-tracking branches, no local branches
        const branches = await client.listBranches(targetPath);

        // Should have remote branches (origin/main, origin/feature-a, origin/feature-b)
        const remoteBranches = branches.filter((b) => b.isRemote);
        expect(remoteBranches.length).toBeGreaterThanOrEqual(3);
        expect(remoteBranches.some((b) => b.name === "origin/main")).toBe(true);
        expect(remoteBranches.some((b) => b.name === "origin/feature-a")).toBe(true);
        expect(remoteBranches.some((b) => b.name === "origin/feature-b")).toBe(true);

        // Should have NO local branches (all were deleted after clone)
        const localBranches = branches.filter((b) => !b.isRemote);
        expect(localBranches).toHaveLength(0);
      } finally {
        await sourceRepo.cleanup();
        await targetDir.cleanup();
      }
    });

    it("throws GitError for invalid URL", async () => {
      const targetDir = await createTempDir();
      const targetPath = new Path(targetDir.path, "cloned.git");

      try {
        await expect(client.clone("not-a-valid-url-at-all", targetPath)).rejects.toThrow(GitError);
      } finally {
        await targetDir.cleanup();
      }
    });

    it("throws GitError when target already exists", async () => {
      const sourceRepo = await createTestGitRepo();
      const targetDir = await createTempDir();
      const targetPath = new Path(targetDir.path, "cloned.git");

      try {
        // Clone once - should succeed
        await client.clone(sourceRepo.path, targetPath);

        // Clone again to same target - should fail
        await expect(client.clone(sourceRepo.path, targetPath)).rejects.toThrow(GitError);
      } finally {
        await sourceRepo.cleanup();
        await targetDir.cleanup();
      }
    });
  });

  /**
   * Git POSIX Path Output Verification
   *
   * This test verifies that git returns POSIX-style paths (forward slashes) even on Windows.
   * This is critical for the path normalization strategy:
   * - Git outputs: "C:/Users/..." (POSIX style)
   * - We can wrap directly with new Path() without conversion
   * - Avoids the current bug of converting to native then back to POSIX
   *
   * Note: On Unix, paths are already POSIX-style, so this test primarily matters for Windows CI.
   */
  describe("git POSIX path output format (raw git output)", () => {
    it("git worktree list --porcelain returns POSIX paths", async () => {
      // Test raw git output directly (bypass our client)
      const git = simpleGit(repoPath.toNative());
      const rawOutput = await git.raw(["worktree", "list", "--porcelain"]);

      // Parse worktree paths from raw output
      const lines = rawOutput.split("\n");
      const worktreePaths: string[] = [];
      for (const line of lines) {
        if (line.startsWith("worktree ")) {
          worktreePaths.push(line.substring("worktree ".length));
        }
      }

      expect(worktreePaths.length).toBeGreaterThanOrEqual(1);

      for (const wtPath of worktreePaths) {
        // Git on all platforms returns forward slashes (POSIX format)
        // Even on Windows: "C:/Users/..." not "C:\Users\..."
        expect(wtPath).not.toContain("\\");
        // Path should be absolute
        expect(nodePath.isAbsolute(wtPath)).toBe(true);
        // Raw git output should be directly usable with Path class
        expect(() => new Path(wtPath)).not.toThrow();
      }
    });

    it("git rev-parse --show-toplevel returns POSIX path", async () => {
      // Test raw git output for repository root
      const git = simpleGit(repoPath.toNative());
      const rawOutput = await git.raw(["rev-parse", "--show-toplevel"]);
      const rootPath = rawOutput.trim();

      // Git returns POSIX format on all platforms
      expect(rootPath).not.toContain("\\");
      // Path should be absolute
      expect(nodePath.isAbsolute(rootPath)).toBe(true);
      // Should be directly usable with Path class
      expect(() => new Path(rootPath)).not.toThrow();
    });
  });

  /**
   * Long Path Handling (Windows MAX_PATH workaround)
   *
   * On Windows, paths exceeding 260 characters (MAX_PATH) can cause failures.
   * The client configures git with core.longpaths=true to handle this.
   * These tests verify git operations work with paths exceeding 260 characters.
   */
  describe("long path handling", () => {
    // Generate path segments that will exceed 260 characters when combined
    // Each segment is 25 characters, we use 12 segments = 300+ chars just for segments
    const longPathSegments = Array.from(
      { length: 12 },
      (_, i) => `deeply_nested_directory_${i.toString().padStart(2, "0")}`
    );

    it("handles paths exceeding 260 characters (Windows MAX_PATH)", async () => {
      // Create a deeply nested directory structure that exceeds MAX_PATH
      let currentPath = repoPath;

      for (const segment of longPathSegments) {
        currentPath = new Path(currentPath, segment);
      }

      // Verify the path exceeds 260 characters
      const fullPath = currentPath.toNative();
      expect(fullPath.length).toBeGreaterThan(260);

      // Create the directory structure
      await fs.mkdir(currentPath.toNative(), { recursive: true });

      // Create a file in the deeply nested directory
      const testFile = nodePath.join(currentPath.toNative(), "test-file.txt");
      await fs.writeFile(testFile, "test content for long path testing");

      // Git operations should work without errors despite long paths
      const status = await client.getStatus(repoPath);

      expect(status.isDirty).toBe(true);
      expect(status.untrackedCount).toBeGreaterThan(0);
    });
  });
});
