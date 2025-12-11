// @vitest-environment node
import { describe, it, expect } from "vitest";
import { access, readFile, stat } from "fs/promises";
import { join } from "path";
import {
  createTempDir,
  createTestGitRepo,
  createTestGitRepoWithRemote,
  createCommitInRemote,
  withTempRepo,
  withTempDir,
  withTempRepoWithRemote,
} from "./test-utils";
import { simpleGit } from "simple-git";

describe("createTempDir", () => {
  it("creates a temporary directory", async () => {
    const { path, cleanup } = await createTempDir();

    try {
      const stats = await stat(path);
      expect(stats.isDirectory()).toBe(true);
      expect(path).toContain("codehydra-test-");
    } finally {
      await cleanup();
    }
  });

  it("cleanup removes the directory", async () => {
    const { path, cleanup } = await createTempDir();

    await cleanup();

    await expect(access(path)).rejects.toThrow();
  });
});

describe("createTestGitRepo", () => {
  it("creates a valid git repository", async () => {
    const { path, cleanup } = await createTestGitRepo();

    try {
      const git = simpleGit(path);
      const isRepo = await git.checkIsRepo();
      expect(isRepo).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("creates initial commit with README", async () => {
    const { path, cleanup } = await createTestGitRepo();

    try {
      const readmePath = join(path, "README.md");
      const content = await readFile(readmePath, "utf-8");
      expect(content).toBe("# Test Repository\n");

      const git = simpleGit(path);
      const log = await git.log();
      expect(log.total).toBe(1);
      expect(log.latest?.message).toBe("Initial commit");
    } finally {
      await cleanup();
    }
  });

  it("creates worktrees when requested", async () => {
    const { path, cleanup } = await createTestGitRepo({
      worktrees: ["feature-1", "feature-2"],
    });

    try {
      const git = simpleGit(path);
      const worktreeList = await git.raw(["worktree", "list", "--porcelain"]);

      expect(worktreeList).toContain("feature-1");
      expect(worktreeList).toContain("feature-2");
    } finally {
      await cleanup();
    }
  });

  it("creates dirty state when requested", async () => {
    const { path, cleanup } = await createTestGitRepo({ dirty: true });

    try {
      const git = simpleGit(path);
      const status = await git.status();

      expect(status.not_added).toContain("dirty-file.txt");
    } finally {
      await cleanup();
    }
  });

  it("creates detached HEAD when requested", async () => {
    const { path, cleanup } = await createTestGitRepo({ detached: true });

    try {
      const git = simpleGit(path);
      const status = await git.status();

      expect(status.detached).toBe(true);
    } finally {
      await cleanup();
    }
  });
});

describe("withTempRepo", () => {
  it("provides repo path and cleans up after", async () => {
    let savedPath: string | undefined;

    await withTempRepo(async (repoPath) => {
      savedPath = repoPath;
      const git = simpleGit(repoPath);
      const isRepo = await git.checkIsRepo();
      expect(isRepo).toBe(true);
    });

    // After withTempRepo, directory should be cleaned up
    expect(savedPath).toBeDefined();
    await expect(access(savedPath!)).rejects.toThrow();
  });

  it("cleans up even on test failure", async () => {
    let savedPath: string | undefined;

    await expect(
      withTempRepo(async (repoPath) => {
        savedPath = repoPath;
        throw new Error("Test failure");
      })
    ).rejects.toThrow("Test failure");

    // Directory should still be cleaned up
    expect(savedPath).toBeDefined();
    await expect(access(savedPath!)).rejects.toThrow();
  });
});

describe("withTempDir", () => {
  it("provides directory path and cleans up after", async () => {
    let savedPath: string | undefined;

    await withTempDir(async (dirPath) => {
      savedPath = dirPath;
      const stats = await stat(dirPath);
      expect(stats.isDirectory()).toBe(true);
    });

    // After withTempDir, directory should be cleaned up
    expect(savedPath).toBeDefined();
    await expect(access(savedPath!)).rejects.toThrow();
  });
});

describe("createTestGitRepoWithRemote", () => {
  it("creates a working git repository with origin configured", async () => {
    const { path, cleanup } = await createTestGitRepoWithRemote();

    try {
      const git = simpleGit(path);
      const isRepo = await git.checkIsRepo();
      expect(isRepo).toBe(true);

      // Verify origin is configured
      const remotes = await git.getRemotes();
      expect(remotes.map((r) => r.name)).toContain("origin");
    } finally {
      await cleanup();
    }
  });

  it("creates a bare remote repository at sibling path", async () => {
    const { remotePath, cleanup } = await createTestGitRepoWithRemote();

    try {
      // remotePath should be a bare repo
      const stats = await stat(remotePath);
      expect(stats.isDirectory()).toBe(true);

      // Verify it's a bare repo (has HEAD file directly, not .git/HEAD)
      const headPath = join(remotePath, "HEAD");
      await expect(access(headPath)).resolves.not.toThrow();
    } finally {
      await cleanup();
    }
  });

  it("cleanup removes both repo and remote directories", async () => {
    const { path, remotePath, cleanup } = await createTestGitRepoWithRemote();

    await cleanup();

    // Both directories should be removed
    await expect(access(path)).rejects.toThrow();
    await expect(access(remotePath)).rejects.toThrow();
  });

  it("has main pushed to origin", async () => {
    const { path, cleanup } = await createTestGitRepoWithRemote();

    try {
      const git = simpleGit(path);

      // origin/main should exist
      const branches = await git.branch(["-r"]);
      expect(branches.all).toContain("origin/main");
    } finally {
      await cleanup();
    }
  });
});

describe("createCommitInRemote", () => {
  it("creates a commit in the bare remote repository", async () => {
    const { path, remotePath, cleanup } = await createTestGitRepoWithRemote();

    try {
      await createCommitInRemote(remotePath, "Remote commit message");

      // Fetch and check the new commit
      const git = simpleGit(path);
      await git.fetch();

      const log = await git.log(["origin/main"]);
      expect(log.latest?.message).toBe("Remote commit message");
    } finally {
      await cleanup();
    }
  });
});

describe("withTempRepoWithRemote", () => {
  it("provides repo and remote paths and cleans up after", async () => {
    let savedPath: string | undefined;
    let savedRemotePath: string | undefined;

    await withTempRepoWithRemote(async (repoPath, remotePath) => {
      savedPath = repoPath;
      savedRemotePath = remotePath;

      const git = simpleGit(repoPath);
      const isRepo = await git.checkIsRepo();
      expect(isRepo).toBe(true);

      // Verify remote path is provided
      const stats = await stat(remotePath);
      expect(stats.isDirectory()).toBe(true);
    });

    // After withTempRepoWithRemote, both directories should be cleaned up
    expect(savedPath).toBeDefined();
    expect(savedRemotePath).toBeDefined();
    await expect(access(savedPath!)).rejects.toThrow();
    await expect(access(savedRemotePath!)).rejects.toThrow();
  });

  it("cleans up even on test failure", async () => {
    let savedPath: string | undefined;
    let savedRemotePath: string | undefined;

    await expect(
      withTempRepoWithRemote(async (repoPath, remotePath) => {
        savedPath = repoPath;
        savedRemotePath = remotePath;
        throw new Error("Test failure");
      })
    ).rejects.toThrow("Test failure");

    // Both directories should still be cleaned up
    expect(savedPath).toBeDefined();
    expect(savedRemotePath).toBeDefined();
    await expect(access(savedPath!)).rejects.toThrow();
    await expect(access(savedRemotePath!)).rejects.toThrow();
  });
});
