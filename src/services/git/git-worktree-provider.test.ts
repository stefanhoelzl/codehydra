// @vitest-environment node
/**
 * Fault injection tests for GitWorktreeProvider.
 * These tests use vi.fn() to override mock methods, testing error handling,
 * rollback, and defensive paths.
 */

import { describe, it, expect, vi } from "vitest";
import { GitWorktreeProvider } from "./git-worktree-provider";
import { WorkspaceError } from "../errors";
import {
  createFileSystemMock,
  createSpyFileSystemLayer,
  directory,
} from "../platform/filesystem.state-mock";
import { FileSystemError } from "../errors";
import { createMockLogger } from "../logging/logging.test-utils";
import { delay } from "@shared/test-fixtures";
import { Path } from "../platform/path";
import { createMockGitClient } from "./git-client.state-mock";

describe("GitWorktreeProvider error injection", () => {
  const PROJECT_ROOT = new Path("/home/user/projects/my-repo");
  const WORKSPACES_DIR = new Path("/home/user/app-data/projects/my-repo-abc12345/workspaces");
  const mockFs = createFileSystemMock();
  const mockLogger = createMockLogger();

  describe("create (factory)", () => {
    it("throws WorkspaceError when git client throws", async () => {
      // Create a mock that throws on isRepositoryRoot
      const mockClient = createMockGitClient({
        repositories: {},
      });
      // Override to throw an error
      mockClient.isRepositoryRoot = vi.fn().mockRejectedValue(new Error("Path does not exist"));

      await expect(
        GitWorktreeProvider.create(PROJECT_ROOT, mockClient, WORKSPACES_DIR, mockFs, mockLogger)
      ).rejects.toThrow(WorkspaceError);
    });
  });

  describe("discover", () => {
    it("logs warning and uses fallback when getBranchConfigsByPrefix throws", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main", "feature-x"],
            currentBranch: "main",
            worktrees: [
              { name: "feature-x", path: "/data/workspaces/feature-x", branch: "feature-x" },
            ],
          },
        },
      });
      // Override to throw an error
      mockClient.getBranchConfigsByPrefix = vi
        .fn()
        .mockRejectedValue(new Error("Config read failed"));

      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      const workspaces = await provider.discover(PROJECT_ROOT);

      expect(workspaces).toHaveLength(1);
      // Should fall back to branch name
      expect(workspaces[0]!.metadata.base).toBe("feature-x");
    });
  });

  describe("updateBases", () => {
    it("returns partial failure when some fetches fail", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main"],
            remotes: ["origin", "backup"],
            currentBranch: "main",
          },
        },
      });
      // Override fetch to fail for backup remote
      const originalFetch = mockClient.fetch.bind(mockClient);
      mockClient.fetch = vi.fn().mockImplementation(async (repoPath: Path, remote?: string) => {
        if (remote === "backup") {
          throw new Error("Network error");
        }
        return originalFetch(repoPath, remote);
      });

      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      const result = await provider.updateBases(PROJECT_ROOT);

      expect(result.fetchedRemotes).toContain("origin");
      expect(result.failedRemotes).toHaveLength(1);
      expect(result.failedRemotes[0]!.remote).toBe("backup");
      expect(result.failedRemotes[0]!.error).toContain("Network error");
    });

    it("removes stale remote refs after fetch (prune behavior)", async () => {
      // Setup: Repository has a remote branch that will be "deleted on remote"
      // The mock simulates prune by removing the stale branch when fetch is called
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main"],
            remoteBranches: ["origin/main", "origin/stale-feature"],
            remotes: ["origin"],
            currentBranch: "main",
          },
        },
      });

      // Verify stale branch exists before fetch
      const branchesBefore = await mockClient.listBranches(PROJECT_ROOT);
      expect(branchesBefore.find((b) => b.name === "origin/stale-feature")).toBeDefined();

      // Override fetch to simulate prune behavior: remove the stale remote branch
      const originalFetch = mockClient.fetch.bind(mockClient);
      mockClient.fetch = vi.fn().mockImplementation(async (repoPath: Path, remote?: string) => {
        // Simulate prune: remove the stale-feature branch from remoteBranches
        const repo = mockClient.$.repositories.get(PROJECT_ROOT.toString());
        if (repo) {
          // Access the mutable internal state to remove the stale branch
          (repo.remoteBranches as Set<string>).delete("origin/stale-feature");
        }
        return originalFetch(repoPath, remote);
      });

      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      // Act: Call updateBases which triggers fetch with prune
      await provider.updateBases(PROJECT_ROOT);

      // Assert: listBases should no longer return the stale branch
      const bases = await provider.listBases(PROJECT_ROOT);
      expect(bases.find((b) => b.name === "origin/stale-feature")).toBeUndefined();
      // origin/main should still exist
      expect(bases.find((b) => b.name === "origin/main")).toBeDefined();
    });
  });

  describe("createWorkspace", () => {
    it("rolls back branch on worktree creation failure", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main"],
            currentBranch: "main",
          },
        },
      });
      // Override addWorktree to fail
      mockClient.addWorktree = vi.fn().mockRejectedValue(new Error("Worktree creation failed"));

      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      await expect(provider.createWorkspace(PROJECT_ROOT, "feature-x", "main")).rejects.toThrow();

      // Branch should have been rolled back (deleted)
      expect(mockClient).not.toHaveBranch(PROJECT_ROOT, "feature-x");
    });

    it("throws WorkspaceError when git createBranch fails", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main"], // Branch doesn't exist - will try to create
            currentBranch: "main",
          },
        },
      });
      // Make createBranch fail
      mockClient.createBranch = vi.fn().mockRejectedValue(new Error("Git error"));

      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      await expect(provider.createWorkspace(PROJECT_ROOT, "feature-x", "main")).rejects.toThrow(
        WorkspaceError
      );
    });

    it("passes through error message without adding redundant prefix", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main"],
            currentBranch: "main",
          },
        },
      });
      mockClient.createBranch = vi
        .fn()
        .mockRejectedValue(
          new Error("Failed to create branch feature-x: fatal: not a valid object name: 'main'")
        );

      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      await expect(provider.createWorkspace(PROJECT_ROOT, "feature-x", "main")).rejects.toThrow(
        "Failed to create branch feature-x: fatal: not a valid object name: 'main'"
      );
    });

    it("does not rollback branch when worktree creation fails for existing branch", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main", "existing-branch"],
            currentBranch: "main",
          },
        },
      });
      // Override addWorktree to fail
      mockClient.addWorktree = vi.fn().mockRejectedValue(new Error("Worktree creation failed"));

      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      await expect(
        provider.createWorkspace(PROJECT_ROOT, "existing-branch", "existing-branch")
      ).rejects.toThrow();

      // Branch should NOT be deleted (it was pre-existing)
      expect(mockClient).toHaveBranch(PROJECT_ROOT, "existing-branch");
    });

    it("logs warning and continues if setBranchConfig fails", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main"],
            currentBranch: "main",
          },
        },
      });
      // Override setBranchConfig to fail
      mockClient.setBranchConfig = vi.fn().mockRejectedValue(new Error("Config write failed"));

      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      // Should NOT throw - workspace is created successfully
      const workspace = await provider.createWorkspace(PROJECT_ROOT, "feature-x", "main");

      expect(workspace.name).toBe("feature-x");
    });
  });

  describe("removeWorkspace", () => {
    it("falls back to rm + prune when git worktree remove fails", async () => {
      const worktreePath = new Path("/data/workspaces/feature-x");
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main", "feature-x"],
            currentBranch: "main",
            worktrees: [{ name: "feature-x", path: worktreePath.toString(), branch: "feature-x" }],
          },
        },
      });
      mockClient.removeWorktree = vi.fn().mockRejectedValue(new Error("git error"));
      const repo = mockClient.$.repositories.get(PROJECT_ROOT.toString());
      mockClient.pruneWorktrees = vi.fn().mockImplementation(async () => {
        repo?.worktrees.delete(worktreePath.toString());
      });
      mockClient.deleteBranch = vi.fn().mockImplementation(async () => {
        repo?.branches.delete("feature-x");
      });

      const spyFs = createSpyFileSystemLayer();
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        spyFs,
        mockLogger
      );

      const result = await provider.removeWorkspace(PROJECT_ROOT, worktreePath, true);

      expect(result.workspaceRemoved).toBe(true);
      expect(result.baseDeleted).toBe(true);
      expect(spyFs.rm).toHaveBeenCalledWith(worktreePath, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 200,
        timeout: 30_000,
      });
      expect(mockClient.pruneWorktrees).toHaveBeenCalledWith(PROJECT_ROOT);
    });

    it("throws original error when fallback also fails", async () => {
      const worktreePath = new Path("/data/workspaces/feature-x");
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main", "feature-x"],
            currentBranch: "main",
            worktrees: [{ name: "feature-x", path: worktreePath.toString(), branch: "feature-x" }],
          },
        },
      });
      mockClient.removeWorktree = vi.fn().mockRejectedValue(new Error("Worktree error"));
      mockClient.deleteBranch = vi.fn().mockRejectedValue(new Error("Branch error"));

      const spyFs = createSpyFileSystemLayer();
      spyFs.rm = vi.fn().mockRejectedValue(new Error("rm failed"));

      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        spyFs,
        mockLogger
      );

      // Should throw the original worktree error (not the rm error)
      await expect(provider.removeWorkspace(PROJECT_ROOT, worktreePath, true)).rejects.toThrow(
        "Worktree error"
      );
    });

    it("throws branch error when worktree succeeds but branch deletion fails", async () => {
      const worktreePath = new Path("/data/workspaces/feature-x");
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main", "feature-x"],
            currentBranch: "main",
            worktrees: [{ name: "feature-x", path: worktreePath.toString(), branch: "feature-x" }],
          },
        },
      });
      // Override deleteBranch to fail
      mockClient.deleteBranch = vi.fn().mockRejectedValue(new Error("Branch deletion failed"));

      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      // Should throw branch error since worktree succeeded
      await expect(provider.removeWorkspace(PROJECT_ROOT, worktreePath, true)).rejects.toThrow(
        "Branch deletion failed"
      );
    });

    it("rejects with original git error when fallback rm times out", async () => {
      const worktreePath = new Path("/data/workspaces/feature-x");
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main", "feature-x"],
            currentBranch: "main",
            worktrees: [{ name: "feature-x", path: worktreePath.toString(), branch: "feature-x" }],
          },
        },
      });
      mockClient.removeWorktree = vi.fn().mockRejectedValue(new Error("git worktree error"));

      const spyFs = createSpyFileSystemLayer();
      // Simulate rm rejecting with ETIMEDOUT (as DefaultFileSystemLayer.rm would on timeout)
      spyFs.rm = vi
        .fn()
        .mockRejectedValue(
          new FileSystemError(
            "UNKNOWN",
            worktreePath.toNative(),
            "rm timed out after 30000ms",
            undefined,
            "ETIMEDOUT"
          )
        );

      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        spyFs,
        mockLogger
      );

      // Should throw the original git error (not the ETIMEDOUT error)
      await expect(provider.removeWorkspace(PROJECT_ROOT, worktreePath, false)).rejects.toThrow(
        "git worktree error"
      );
    });
  });

  describe("defaultBase", () => {
    it("returns undefined when listBases() throws (error handling)", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main"],
            currentBranch: "main",
          },
        },
      });
      // Override listBranches to throw
      mockClient.listBranches = vi.fn().mockRejectedValue(new Error("Git error"));

      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      const result = await provider.defaultBase(PROJECT_ROOT);

      expect(result).toBeUndefined();
    });
  });

  describe("cleanupOrphanedWorkspaces", () => {
    it("re-checks registration before delete (TOCTOU protection)", async () => {
      let listWorktreesCallCount = 0;
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main"],
            currentBranch: "main",
          },
        },
      });
      // Override listWorktrees to add worktree on second call
      const originalListWorktrees = mockClient.listWorktrees.bind(mockClient);
      mockClient.listWorktrees = vi.fn().mockImplementation(async (repoPath: Path) => {
        listWorktreesCallCount++;
        if (listWorktreesCallCount > 1) {
          // On second call, pretend worktree was registered
          return [
            ...(await originalListWorktrees(repoPath)),
            {
              name: "orphan-workspace",
              path: new Path(WORKSPACES_DIR, "orphan-workspace"),
              branch: "orphan-workspace",
              isMain: false,
            },
          ];
        }
        return originalListWorktrees(repoPath);
      });

      const spyFs = createSpyFileSystemLayer({
        entries: {
          [WORKSPACES_DIR.toString()]: directory(),
          [new Path(WORKSPACES_DIR, "orphan-workspace").toString()]: directory(),
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        spyFs,
        mockLogger
      );

      const result = await provider.cleanupOrphanedWorkspaces(PROJECT_ROOT);

      // Should not delete because it's now registered
      expect(result.removedCount).toBe(0);
      expect(spyFs.rm).not.toHaveBeenCalled();
    });

    it("fails silently on rm error", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main"],
            currentBranch: "main",
          },
        },
      });
      const orphanPath = new Path(WORKSPACES_DIR, "orphan-workspace");
      const spyFs = createSpyFileSystemLayer({
        entries: {
          [WORKSPACES_DIR.toString()]: directory(),
          [orphanPath.toString()]: directory({ error: "EACCES" }),
        },
      });
      // Override rm to throw error
      spyFs.rm.mockRejectedValue(
        new FileSystemError("EACCES", orphanPath.toNative(), "Permission denied")
      );

      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        spyFs,
        mockLogger
      );

      // Should NOT throw
      const result = await provider.cleanupOrphanedWorkspaces(PROJECT_ROOT);

      expect(result.removedCount).toBe(0);
      expect(result.failedPaths).toHaveLength(1);
      expect(result.failedPaths[0]?.path).toBe(orphanPath.toString());
    });

    it("fails silently when listWorktrees throws", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main"],
            currentBranch: "main",
          },
        },
      });
      // Override listWorktrees to throw
      mockClient.listWorktrees = vi.fn().mockRejectedValue(new Error("Git error"));

      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      // Should NOT throw
      const result = await provider.cleanupOrphanedWorkspaces(PROJECT_ROOT);

      expect(result.removedCount).toBe(0);
      expect(result.failedPaths).toHaveLength(0);
    });

    it("returns early if already in progress", async () => {
      let slowResolve: (() => void) | null = null;
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main"],
            currentBranch: "main",
          },
        },
      });
      // Override listWorktrees to be slow on first call
      let callCount = 0;
      mockClient.listWorktrees = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // First call is slow
          await new Promise<void>((resolve) => {
            slowResolve = resolve;
          });
        }
        return [
          {
            name: "my-repo",
            path: PROJECT_ROOT,
            branch: "main",
            isMain: true,
          },
        ];
      });

      const mockFsWithOrphan = createSpyFileSystemLayer({
        entries: {
          [WORKSPACES_DIR.toString()]: directory(),
          [new Path(WORKSPACES_DIR, "orphan").toString()]: directory(),
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFsWithOrphan,
        mockLogger
      );

      // Start first cleanup (will hang on listWorktrees)
      const firstCleanup = provider.cleanupOrphanedWorkspaces(PROJECT_ROOT);

      // Give a moment for the first cleanup to start
      await delay(10);

      // Start second cleanup while first is in progress
      const secondCleanup = provider.cleanupOrphanedWorkspaces(PROJECT_ROOT);
      const secondResult = await secondCleanup;

      // Second cleanup should return immediately with empty result
      expect(secondResult.removedCount).toBe(0);
      expect(secondResult.failedPaths).toHaveLength(0);

      // Now resolve the first cleanup
      slowResolve!();
      await firstCleanup;
    });
  });
});
