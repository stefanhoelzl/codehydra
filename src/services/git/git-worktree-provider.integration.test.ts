// @vitest-environment node
/**
 * Integration tests for GitWorktreeProvider.
 * These tests use real git repositories to verify the implementation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GitWorktreeProvider } from "./git-worktree-provider";
import { SimpleGitClient } from "./simple-git-client";
import { createTestGitRepo, createTempDir } from "../test-utils";
import { DefaultFileSystemLayer } from "../platform/filesystem";
import { createSilentLogger } from "../logging";
import { simpleGit } from "simple-git";
import path, { join } from "node:path";
import { mkdir as nodeMkdir, writeFile as nodeWriteFile } from "node:fs/promises";
import { KeepFilesService } from "../keepfiles/keepfiles-service";
import { execSync } from "node:child_process";

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

    gitClient = new SimpleGitClient(createSilentLogger());
    fs = new DefaultFileSystemLayer(createSilentLogger());
  });

  afterEach(async () => {
    await cleanup();
    await cleanupWorkspacesDir();
  });

  describe("metadata.base persistence", () => {
    it("creates workspace with metadata.base and retrieves via discover()", async () => {
      const provider = await GitWorktreeProvider.create(repoPath, gitClient, workspacesDir, fs);

      // Create workspace with base branch "main"
      const created = await provider.createWorkspace("feature-x", "main");
      expect(created.metadata.base).toBe("main");

      // Discover should return same metadata.base
      const discovered = await provider.discover();
      expect(discovered).toHaveLength(1);
      expect(discovered[0]?.metadata.base).toBe("main");
    });

    it("metadata.base survives provider instance recreation", async () => {
      // Create with first provider instance
      const provider1 = await GitWorktreeProvider.create(repoPath, gitClient, workspacesDir, fs);
      await provider1.createWorkspace("feature-x", "main");

      // Create new provider instance and verify metadata.base persists
      const provider2 = await GitWorktreeProvider.create(repoPath, gitClient, workspacesDir, fs);
      const discovered = await provider2.discover();

      expect(discovered).toHaveLength(1);
      expect(discovered[0]?.metadata.base).toBe("main");
    });

    it("legacy workspace (no config) returns branch name as metadata.base", async () => {
      // Create a branch and worktree manually (no config set)
      const git = simpleGit(repoPath);
      await git.branch(["legacy-branch"]);
      const worktreePath = path.join(workspacesDir, "legacy-branch");
      await git.raw(["worktree", "add", worktreePath, "legacy-branch"]);

      // Discover should fall back to branch name
      const provider = await GitWorktreeProvider.create(repoPath, gitClient, workspacesDir, fs);
      const discovered = await provider.discover();

      expect(discovered).toHaveLength(1);
      expect(discovered[0]?.metadata.base).toBe("legacy-branch");
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

      expect(featureWorkspace?.metadata.base).toBe("main");
      expect(legacyWorkspace?.metadata.base).toBe("legacy-branch");
    });

    it("stores metadata.base in git config", async () => {
      const provider = await GitWorktreeProvider.create(repoPath, gitClient, workspacesDir, fs);
      await provider.createWorkspace("feature-x", "main");

      // Verify config was set using git command (codehydra.base is the namespaced key)
      const git = simpleGit(repoPath);
      const configValue = await git.raw(["config", "--get", "branch.feature-x.codehydra.base"]);
      expect(configValue.trim()).toBe("main");
    });
  });

  describe("metadata setMetadata/getMetadata", () => {
    it("setMetadata persists and getMetadata retrieves", async () => {
      const provider = await GitWorktreeProvider.create(repoPath, gitClient, workspacesDir, fs);
      const workspace = await provider.createWorkspace("feature-x", "main");

      await provider.setMetadata(workspace.path, "note", "WIP feature");

      const metadata = await provider.getMetadata(workspace.path);
      expect(metadata.note).toBe("WIP feature");
      expect(metadata.base).toBe("main");
    });

    it("metadata survives provider recreation", async () => {
      const provider1 = await GitWorktreeProvider.create(repoPath, gitClient, workspacesDir, fs);
      const workspace = await provider1.createWorkspace("feature-x", "main");
      await provider1.setMetadata(workspace.path, "note", "test note");

      const provider2 = await GitWorktreeProvider.create(repoPath, gitClient, workspacesDir, fs);
      const metadata = await provider2.getMetadata(workspace.path);

      expect(metadata.note).toBe("test note");
      expect(metadata.base).toBe("main");
    });

    it("base fallback applies in getMetadata for legacy workspace", async () => {
      // Create legacy workspace manually (no config set)
      const git = simpleGit(repoPath);
      await git.branch(["legacy-branch"]);
      const worktreePath = path.join(workspacesDir, "legacy-branch");
      await git.raw(["worktree", "add", worktreePath, "legacy-branch"]);

      const provider = await GitWorktreeProvider.create(repoPath, gitClient, workspacesDir, fs);
      const metadata = await provider.getMetadata(worktreePath);

      // Should fall back to branch name
      expect(metadata.base).toBe("legacy-branch");
    });

    it("invalid key format throws WorkspaceError with INVALID_METADATA_KEY code", async () => {
      const provider = await GitWorktreeProvider.create(repoPath, gitClient, workspacesDir, fs);
      const workspace = await provider.createWorkspace("feature-x", "main");

      const { WorkspaceError } = await import("../errors");
      try {
        await provider.setMetadata(workspace.path, "my_key", "value");
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(WorkspaceError);
        expect((error as InstanceType<typeof WorkspaceError>).code).toBe("INVALID_METADATA_KEY");
      }
    });

    it("setMetadata with null deletes the key", async () => {
      const provider = await GitWorktreeProvider.create(repoPath, gitClient, workspacesDir, fs);
      const workspace = await provider.createWorkspace("feature-x", "main");

      await provider.setMetadata(workspace.path, "note", "test note");
      let metadata = await provider.getMetadata(workspace.path);
      expect(metadata.note).toBe("test note");

      await provider.setMetadata(workspace.path, "note", null);
      metadata = await provider.getMetadata(workspace.path);
      expect(metadata.note).toBeUndefined();
    });

    it("concurrent setMetadata calls for different keys both succeed", async () => {
      const provider = await GitWorktreeProvider.create(repoPath, gitClient, workspacesDir, fs);
      const workspace = await provider.createWorkspace("feature-x", "main");

      // Set multiple keys concurrently
      await Promise.all([
        provider.setMetadata(workspace.path, "note", "note value"),
        provider.setMetadata(workspace.path, "model", "claude-4"),
      ]);

      const metadata = await provider.getMetadata(workspace.path);
      expect(metadata.note).toBe("note value");
      expect(metadata.model).toBe("claude-4");
      expect(metadata.base).toBe("main");
    });
  });
});

describe("GitWorktreeProvider with KeepFilesService (integration)", () => {
  let tempDir: { path: string; cleanup: () => Promise<void> };
  let projectRoot: string;
  let workspacesDir: string;
  let fs: DefaultFileSystemLayer;

  /**
   * Initialize a git repository in the given directory.
   */
  async function initGitRepo(dir: string): Promise<void> {
    execSync("git init --initial-branch=main", { cwd: dir, stdio: "ignore" });
    execSync('git config user.email "test@test.com"', { cwd: dir, stdio: "ignore" });
    execSync('git config user.name "Test"', { cwd: dir, stdio: "ignore" });
    // Create initial commit so branches work
    await nodeWriteFile(join(dir, ".gitignore"), "# ignore\n.env\n", "utf-8");
    execSync("git add .", { cwd: dir, stdio: "ignore" });
    execSync('git commit -m "Initial commit"', { cwd: dir, stdio: "ignore" });
  }

  beforeEach(async () => {
    tempDir = await createTempDir();
    projectRoot = join(tempDir.path, "project");
    workspacesDir = join(tempDir.path, "workspaces");
    await nodeMkdir(projectRoot);
    await nodeMkdir(workspacesDir);
    fs = new DefaultFileSystemLayer(createSilentLogger());

    // Initialize git repo
    await initGitRepo(projectRoot);
  });

  afterEach(async () => {
    // Clean up any worktrees before removing temp dir
    try {
      execSync("git worktree prune", { cwd: projectRoot, stdio: "ignore" });
    } catch {
      // Ignore cleanup errors
    }
    await tempDir.cleanup();
  });

  describe("full flow", () => {
    it(".keepfiles read from correct location and files copied to worktree", async () => {
      // Create .keepfiles in project root
      await nodeWriteFile(join(projectRoot, ".keepfiles"), ".env\nconfig/\n", "utf-8");

      // Create files to be copied
      await nodeWriteFile(join(projectRoot, ".env"), "SECRET=value", "utf-8");
      await nodeMkdir(join(projectRoot, "config"));
      await nodeWriteFile(join(projectRoot, "config", "app.json"), '{"key": "value"}', "utf-8");

      // Create a file that shouldn't be copied
      await nodeWriteFile(join(projectRoot, "README.md"), "# README", "utf-8");

      const gitClient = new SimpleGitClient(createSilentLogger());
      const keepFilesService = new KeepFilesService(fs, createSilentLogger());
      const provider = await GitWorktreeProvider.create(projectRoot, gitClient, workspacesDir, fs, {
        keepFilesService,
      });

      // Create workspace
      const workspace = await provider.createWorkspace("feature-test", "main");

      expect(workspace.name).toBe("feature-test");
      expect(workspace.path).toContain("feature-test");

      // Verify files were copied
      const envContent = await fs.readFile(join(workspace.path, ".env"));
      expect(envContent).toBe("SECRET=value");

      const configContent = await fs.readFile(join(workspace.path, "config", "app.json"));
      expect(configContent).toBe('{"key": "value"}');

      // README should NOT be copied
      await expect(fs.readFile(join(workspace.path, "README.md"))).rejects.toThrow();
    });

    it("error handling does not fail workspace creation", async () => {
      // Create .keepfiles with a pattern that will cause errors
      await nodeWriteFile(join(projectRoot, ".keepfiles"), "nonexistent.txt\n.env\n", "utf-8");

      // Create only .env (nonexistent.txt doesn't exist, but that shouldn't cause an error)
      await nodeWriteFile(join(projectRoot, ".env"), "SECRET=value", "utf-8");

      const gitClient = new SimpleGitClient(createSilentLogger());
      const keepFilesService = new KeepFilesService(fs, createSilentLogger());
      const provider = await GitWorktreeProvider.create(projectRoot, gitClient, workspacesDir, fs, {
        keepFilesService,
      });

      // Should not throw
      const workspace = await provider.createWorkspace("feature-error-test", "main");

      expect(workspace.name).toBe("feature-error-test");

      // .env should still be copied
      const envContent = await fs.readFile(join(workspace.path, ".env"));
      expect(envContent).toBe("SECRET=value");
    });
  });

  describe("concurrent workspace creation", () => {
    it("two workspaces created in parallel both get correct files", async () => {
      // Create .keepfiles
      await nodeWriteFile(join(projectRoot, ".keepfiles"), ".env\n", "utf-8");
      await nodeWriteFile(join(projectRoot, ".env"), "SHARED=value", "utf-8");

      const gitClient = new SimpleGitClient(createSilentLogger());
      const keepFilesService = new KeepFilesService(fs, createSilentLogger());
      const provider = await GitWorktreeProvider.create(projectRoot, gitClient, workspacesDir, fs, {
        keepFilesService,
      });

      // Create two workspaces in parallel
      const [workspace1, workspace2] = await Promise.all([
        provider.createWorkspace("feature-a", "main"),
        provider.createWorkspace("feature-b", "main"),
      ]);

      expect(workspace1.name).toBe("feature-a");
      expect(workspace2.name).toBe("feature-b");

      // Both should have .env copied
      const env1 = await fs.readFile(join(workspace1.path, ".env"));
      const env2 = await fs.readFile(join(workspace2.path, ".env"));

      expect(env1).toBe("SHARED=value");
      expect(env2).toBe("SHARED=value");
    });
  });

  describe("timing verification", () => {
    it("keep files copied after worktree creation succeeds", async () => {
      await nodeWriteFile(join(projectRoot, ".keepfiles"), ".env\n", "utf-8");
      await nodeWriteFile(join(projectRoot, ".env"), "SECRET=value", "utf-8");

      const gitClient = new SimpleGitClient(createSilentLogger());
      const keepFilesService = new KeepFilesService(fs, createSilentLogger());

      // Spy on copyToWorkspace to verify timing
      const copyToWorkspaceSpy = vi.spyOn(keepFilesService, "copyToWorkspace");

      const provider = await GitWorktreeProvider.create(projectRoot, gitClient, workspacesDir, fs, {
        keepFilesService,
      });

      const workspace = await provider.createWorkspace("feature-timing", "main");

      // Verify copyToWorkspace was called with the correct arguments
      expect(copyToWorkspaceSpy).toHaveBeenCalledWith(projectRoot, workspace.path);

      // The fact that we can read .env in the workspace proves it was called after worktree creation
      const envContent = await fs.readFile(join(workspace.path, ".env"));
      expect(envContent).toBe("SECRET=value");
    });
  });
});
