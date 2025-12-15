// @vitest-environment node
/**
 * Integration tests for GitWorktreeProvider.
 * These tests use real git repositories to verify the implementation.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GitWorktreeProvider } from "./git-worktree-provider";
import { SimpleGitClient } from "./simple-git-client";
import { createTestGitRepo, createTempDir } from "../test-utils";
import { DefaultFileSystemLayer } from "../platform/filesystem";
import { simpleGit } from "simple-git";
import path from "path";

describe("GitWorktreeProvider integration", () => {
  let repoPath: string;
  let workspacesDir: string;
  let cleanup: () => Promise<void>;
  let cleanupWorkspacesDir: () => Promise<void>;
  let gitClient: SimpleGitClient;
  let fs: DefaultFileSystemLayer;

  beforeEach(async () => {
    const repo = await createTestGitRepo();
    repoPath = repo.path;
    cleanup = repo.cleanup;

    const wsDir = await createTempDir();
    workspacesDir = wsDir.path;
    cleanupWorkspacesDir = wsDir.cleanup;

    gitClient = new SimpleGitClient();
    fs = new DefaultFileSystemLayer();
  });

  afterEach(async () => {
    await cleanup();
    await cleanupWorkspacesDir();
  });

  describe("baseBranch persistence", () => {
    it("creates workspace with baseBranch and retrieves via discover()", async () => {
      const provider = await GitWorktreeProvider.create(repoPath, gitClient, workspacesDir, fs);

      // Create workspace with base branch "main"
      const created = await provider.createWorkspace("feature-x", "main");
      expect(created.baseBranch).toBe("main");

      // Discover should return same baseBranch
      const discovered = await provider.discover();
      expect(discovered).toHaveLength(1);
      expect(discovered[0]?.baseBranch).toBe("main");
    });

    it("baseBranch survives provider instance recreation", async () => {
      // Create with first provider instance
      const provider1 = await GitWorktreeProvider.create(repoPath, gitClient, workspacesDir, fs);
      await provider1.createWorkspace("feature-x", "main");

      // Create new provider instance and verify baseBranch persists
      const provider2 = await GitWorktreeProvider.create(repoPath, gitClient, workspacesDir, fs);
      const discovered = await provider2.discover();

      expect(discovered).toHaveLength(1);
      expect(discovered[0]?.baseBranch).toBe("main");
    });

    it("legacy workspace (no config) returns branch name as baseBranch", async () => {
      // Create a branch and worktree manually (no config set)
      const git = simpleGit(repoPath);
      await git.branch(["legacy-branch"]);
      const worktreePath = path.join(workspacesDir, "legacy-branch");
      await git.raw(["worktree", "add", worktreePath, "legacy-branch"]);

      // Discover should fall back to branch name
      const provider = await GitWorktreeProvider.create(repoPath, gitClient, workspacesDir, fs);
      const discovered = await provider.discover();

      expect(discovered).toHaveLength(1);
      expect(discovered[0]?.baseBranch).toBe("legacy-branch");
    });

    it("handles mixed state workspaces", async () => {
      const provider = await GitWorktreeProvider.create(repoPath, gitClient, workspacesDir, fs);

      // Create workspace with config
      await provider.createWorkspace("feature-with-config", "main");

      // Create legacy workspace manually (no config)
      const git = simpleGit(repoPath);
      await git.branch(["legacy-branch"]);
      const legacyPath = path.join(workspacesDir, "legacy-branch");
      await git.raw(["worktree", "add", legacyPath, "legacy-branch"]);

      // Discover should handle both correctly
      const discovered = await provider.discover();
      expect(discovered).toHaveLength(2);

      const featureWorkspace = discovered.find((w) => w.name === "feature-with-config");
      const legacyWorkspace = discovered.find((w) => w.name === "legacy-branch");

      expect(featureWorkspace?.baseBranch).toBe("main");
      expect(legacyWorkspace?.baseBranch).toBe("legacy-branch");
    });

    it("stores baseBranch in git config", async () => {
      const provider = await GitWorktreeProvider.create(repoPath, gitClient, workspacesDir, fs);
      await provider.createWorkspace("feature-x", "main");

      // Verify config was set using git command (codehydra.base is the namespaced key)
      const git = simpleGit(repoPath);
      const configValue = await git.raw(["config", "--get", "branch.feature-x.codehydra.base"]);
      expect(configValue.trim()).toBe("main");
    });
  });
});
