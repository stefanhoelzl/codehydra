// @vitest-environment node
/**
 * Tests for GitWorktreeProvider using behavioral mock for IGitClient.
 * Uses state-based assertions instead of call-tracking mocks.
 */

import { describe, it, expect, vi } from "vitest";
import { GitWorktreeProvider } from "./git-worktree-provider";
import { ProjectScopedWorkspaceProvider } from "./project-scoped-provider";
import { WorkspaceError } from "../errors";
import {
  createFileSystemMock,
  createSpyFileSystemLayer,
  directory,
  symlink,
  file,
} from "../platform/filesystem.state-mock";
import { FileSystemError } from "../errors";
import { createMockLogger } from "../logging/logging.test-utils";
import { delay } from "@shared/test-fixtures";
import { Path } from "../platform/path";
import { createMockGitClient } from "./git-client.state-mock";

describe("GitWorktreeProvider", () => {
  const PROJECT_ROOT = new Path("/home/user/projects/my-repo");
  const WORKSPACES_DIR = new Path("/home/user/app-data/projects/my-repo-abc12345/workspaces");
  const mockFs = createFileSystemMock();
  const mockLogger = createMockLogger();

  describe("create (factory)", () => {
    it("creates provider for valid git repository", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main"],
            currentBranch: "main",
          },
        },
      });

      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      expect(provider).toBeInstanceOf(ProjectScopedWorkspaceProvider);
      expect(provider.projectRoot.toString()).toBe(PROJECT_ROOT.toString());
    });

    it("throws error for relative project path (Path constructor rejects)", () => {
      // Path constructor throws for relative paths - this is tested in path.test.ts
      // Verifying that the pattern works as expected
      expect(() => new Path("relative/path")).toThrow(/must be absolute/);
    });

    it("throws error for relative workspacesDir (Path constructor rejects)", () => {
      // Path constructor throws for relative paths - this is tested in path.test.ts
      expect(() => new Path("relative/workspaces")).toThrow(/must be absolute/);
    });

    it("throws WorkspaceError when path is not a git repository root", async () => {
      // Empty repositories = path is not a repository
      const mockClient = createMockGitClient({
        repositories: {},
      });

      await expect(
        GitWorktreeProvider.create(PROJECT_ROOT, mockClient, WORKSPACES_DIR, mockFs, mockLogger)
      ).rejects.toThrow(WorkspaceError);
    });

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
    it("returns empty array when only main worktree exists", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main"],
            currentBranch: "main",
          },
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      const workspaces = await provider.discover();

      expect(workspaces).toHaveLength(0);
    });

    it("excludes main worktree from results", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main", "feature-branch"],
            currentBranch: "main",
            worktrees: [
              {
                name: "feature-branch",
                path: "/data/workspaces/feature-branch",
                branch: "feature-branch",
              },
            ],
          },
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      const workspaces = await provider.discover();

      expect(workspaces).toHaveLength(1);
      expect(workspaces[0]!.name).toBe("feature-branch");
    });

    it("handles detached HEAD workspaces", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main"],
            currentBranch: "main",
            worktrees: [
              {
                name: "detached-workspace",
                path: "/data/workspaces/detached",
                branch: null,
              },
            ],
          },
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      const workspaces = await provider.discover();

      expect(workspaces).toHaveLength(1);
      expect(workspaces[0]!.branch).toBeNull();
    });

    it("returns multiple workspaces", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main", "feature-a", "feature-b"],
            currentBranch: "main",
            worktrees: [
              { name: "feature-a", path: "/data/workspaces/feature-a", branch: "feature-a" },
              { name: "feature-b", path: "/data/workspaces/feature-b", branch: "feature-b" },
            ],
          },
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      const workspaces = await provider.discover();

      expect(workspaces).toHaveLength(2);
    });

    it("skips corrupted worktree entries without throwing", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main", "feature-valid", "unnamed-branch"],
            currentBranch: "main",
            worktrees: [
              {
                name: "feature-valid",
                path: "/data/workspaces/feature-valid",
                branch: "feature-valid",
              },
              { name: "", path: "/data/workspaces/unnamed", branch: "unnamed-branch" },
            ],
          },
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      // Should not throw and should handle gracefully
      const workspaces = await provider.discover();

      // Should include valid worktrees
      expect(Array.isArray(workspaces)).toBe(true);
      expect(workspaces.some((w) => w.name === "feature-valid")).toBe(true);
    });

    it("returns baseBranch from config when set", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main", "feature-x"],
            currentBranch: "main",
            worktrees: [
              { name: "feature-x", path: "/data/workspaces/feature-x", branch: "feature-x" },
            ],
            branchConfigs: {
              "feature-x": { "codehydra.base": "develop" },
            },
          },
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      const workspaces = await provider.discover();

      expect(workspaces).toHaveLength(1);
      expect(workspaces[0]!.metadata.base).toBe("develop");
    });

    it("falls back to branch name when config returns null", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main", "feature-x"],
            currentBranch: "main",
            worktrees: [
              { name: "feature-x", path: "/data/workspaces/feature-x", branch: "feature-x" },
            ],
            // No config set
          },
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      const workspaces = await provider.discover();

      expect(workspaces).toHaveLength(1);
      expect(workspaces[0]!.metadata.base).toBe("feature-x");
    });

    it("falls back to workspace name when detached HEAD (branch is null)", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main"],
            currentBranch: "main",
            worktrees: [
              {
                name: "detached-workspace",
                path: "/data/workspaces/detached-workspace",
                branch: null,
              },
            ],
          },
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      const workspaces = await provider.discover();

      expect(workspaces).toHaveLength(1);
      expect(workspaces[0]!.metadata.base).toBe("detached-workspace");
    });

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

      const workspaces = await provider.discover();

      expect(workspaces).toHaveLength(1);
      // Should fall back to branch name
      expect(workspaces[0]!.metadata.base).toBe("feature-x");
    });

    it("fallback priority: config > branch > name", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main", "branch-a", "branch-b"],
            currentBranch: "main",
            worktrees: [
              // Has config - should use config value
              { name: "workspace-a", path: "/data/workspaces/workspace-a", branch: "branch-a" },
              // No config - should use branch
              { name: "workspace-b", path: "/data/workspaces/workspace-b", branch: "branch-b" },
              // No config, no branch (detached) - should use name
              { name: "workspace-c", path: "/data/workspaces/workspace-c", branch: null },
            ],
            branchConfigs: {
              "branch-a": { "codehydra.base": "configured-base" },
            },
          },
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      const workspaces = await provider.discover();

      expect(workspaces).toHaveLength(3);

      const workspaceA = workspaces.find((w) => w.name === "workspace-a");
      const workspaceB = workspaces.find((w) => w.name === "workspace-b");
      const workspaceC = workspaces.find((w) => w.name === "workspace-c");

      expect(workspaceA?.metadata.base).toBe("configured-base"); // Uses config
      expect(workspaceB?.metadata.base).toBe("branch-b"); // Uses branch
      expect(workspaceC?.metadata.base).toBe("workspace-c"); // Uses name
    });
  });

  describe("listBases", () => {
    it("returns local and remote branches", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main", "feature"],
            remoteBranches: ["origin/main"],
            currentBranch: "main",
          },
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      const bases = await provider.listBases();

      expect(bases).toHaveLength(3);
      expect(bases.find((b) => b.name === "main" && !b.isRemote)).toBeDefined();
      expect(bases.find((b) => b.name === "origin/main" && b.isRemote)).toBeDefined();
    });

    it("returns derives for local branch without worktree", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main", "feature-x"],
            currentBranch: "main",
            // No worktrees for feature-x
          },
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      const bases = await provider.listBases();

      const featureX = bases.find((b) => b.name === "feature-x");
      expect(featureX?.derives).toBe("feature-x");
    });

    it("excludes derives for local branch with worktree", async () => {
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
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      const bases = await provider.listBases();

      const featureX = bases.find((b) => b.name === "feature-x");
      expect(featureX?.derives).toBeUndefined();
    });

    it("returns derives for remote without local counterpart", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main"],
            remoteBranches: ["origin/feature-payments"],
            currentBranch: "main",
          },
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      const bases = await provider.listBases();

      const remote = bases.find((b) => b.name === "origin/feature-payments");
      expect(remote?.derives).toBe("feature-payments");
    });

    it("excludes derives for remote with local counterpart", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main", "feature-payments"],
            remoteBranches: ["origin/feature-payments"],
            currentBranch: "main",
          },
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      const bases = await provider.listBases();

      const remote = bases.find((b) => b.name === "origin/feature-payments");
      expect(remote?.derives).toBeUndefined();
    });

    it("deduplicates remotes for derives (prefers origin)", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main"],
            remoteBranches: ["origin/feature-x", "upstream/feature-x"],
            currentBranch: "main",
          },
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      const bases = await provider.listBases();

      const originBranch = bases.find((b) => b.name === "origin/feature-x");
      const upstreamBranch = bases.find((b) => b.name === "upstream/feature-x");

      // Origin should get derives, upstream should not
      expect(originBranch?.derives).toBe("feature-x");
      expect(upstreamBranch?.derives).toBeUndefined();
    });

    it("returns base from codehydra.base config for local branch", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main", "feature-x"],
            currentBranch: "main",
            branchConfigs: {
              "feature-x": { "codehydra.base": "develop" },
            },
          },
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      const bases = await provider.listBases();

      const featureX = bases.find((b) => b.name === "feature-x");
      expect(featureX?.base).toBe("develop");
    });

    it("returns base from matching remote when no config", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main", "feature-x"],
            remoteBranches: ["origin/feature-x"],
            currentBranch: "main",
            // No config for feature-x
          },
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      const bases = await provider.listBases();

      const featureX = bases.find((b) => b.name === "feature-x" && !b.isRemote);
      expect(featureX?.base).toBe("origin/feature-x");
    });

    it("returns undefined base when no config and no matching remote", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main", "feature-x"],
            currentBranch: "main",
            // No config, no matching remote
          },
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      const bases = await provider.listBases();

      const featureX = bases.find((b) => b.name === "feature-x");
      expect(featureX?.base).toBeUndefined();
    });

    it("returns full ref as base for remote branches", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main"],
            remoteBranches: ["origin/feature-x"],
            currentBranch: "main",
          },
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      const bases = await provider.listBases();

      const remote = bases.find((b) => b.name === "origin/feature-x");
      expect(remote?.base).toBe("origin/feature-x");
    });

    it("handles remote branch with slashes in name", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main"],
            remoteBranches: ["origin/feature/login"],
            currentBranch: "main",
          },
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      const bases = await provider.listBases();

      const remote = bases.find((b) => b.name === "origin/feature/login");
      expect(remote?.derives).toBe("feature/login");
    });
  });

  describe("updateBases", () => {
    it("returns success when fetch succeeds", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main"],
            remotes: ["origin"],
            currentBranch: "main",
          },
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      const result = await provider.updateBases();

      expect(result.fetchedRemotes).toContain("origin");
      expect(result.failedRemotes).toHaveLength(0);
    });

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

      const result = await provider.updateBases();

      expect(result.fetchedRemotes).toContain("origin");
      expect(result.failedRemotes).toHaveLength(1);
      expect(result.failedRemotes[0]!.remote).toBe("backup");
      expect(result.failedRemotes[0]!.error).toContain("Network error");
    });

    it("returns empty arrays when no remotes exist", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main"],
            remotes: [],
            currentBranch: "main",
          },
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      const result = await provider.updateBases();

      expect(result.fetchedRemotes).toHaveLength(0);
      expect(result.failedRemotes).toHaveLength(0);
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
      await provider.updateBases();

      // Assert: listBases should no longer return the stale branch
      const bases = await provider.listBases();
      expect(bases.find((b) => b.name === "origin/stale-feature")).toBeUndefined();
      // origin/main should still exist
      expect(bases.find((b) => b.name === "origin/main")).toBeDefined();
    });
  });

  describe("createWorkspace", () => {
    it("creates workspace and returns workspace info", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main"],
            currentBranch: "main",
          },
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      const workspace = await provider.createWorkspace("feature-x", "main");

      expect(workspace.name).toBe("feature-x");
      expect(workspace.branch).toBe("feature-x");
      // Behavioral assertion: branch should exist in mock state
      expect(mockClient).toHaveBranch(PROJECT_ROOT, "feature-x");
    });

    it("sanitizes branch names with slashes", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main"],
            currentBranch: "main",
          },
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      const workspace = await provider.createWorkspace("user/feature", "main");

      // The directory name should have sanitized slashes
      expect(workspace.name).toBe("user/feature");
      // Behavioral assertion: branch should be created
      expect(mockClient).toHaveBranch(PROJECT_ROOT, "user/feature");
    });

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

      await expect(provider.createWorkspace("feature-x", "main")).rejects.toThrow();

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

      await expect(provider.createWorkspace("feature-x", "main")).rejects.toThrow(WorkspaceError);
    });

    it("creates workspace using existing branch when baseBranch matches branch name", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main", "existing-branch"],
            currentBranch: "main",
          },
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      const workspace = await provider.createWorkspace("existing-branch", "existing-branch");

      expect(workspace.name).toBe("existing-branch");
      expect(workspace.branch).toBe("existing-branch");
      // Branch already existed, should still have exactly these branches
      const branches = await mockClient.listBranches(PROJECT_ROOT);
      const localBranches = branches.filter((b) => !b.isRemote);
      expect(localBranches).toHaveLength(2);
    });

    it("creates workspace for existing branch with different baseBranch and saves base in config", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main", "existing-branch"],
            currentBranch: "main",
          },
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      // Should succeed even though baseBranch differs from branch name
      const workspace = await provider.createWorkspace("existing-branch", "main");

      expect(workspace.name).toBe("existing-branch");
      expect(workspace.branch).toBe("existing-branch");
      // The base branch should be saved in metadata
      expect(workspace.metadata.base).toBe("main");
    });

    it("throws WorkspaceError when branch is already checked out in worktree", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main", "checked-out-branch"],
            currentBranch: "main",
            worktrees: [
              {
                name: "existing-workspace",
                path: "/data/workspaces/existing-workspace",
                branch: "checked-out-branch",
              },
            ],
          },
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      await expect(
        provider.createWorkspace("checked-out-branch", "checked-out-branch")
      ).rejects.toThrow(WorkspaceError);
      await expect(
        provider.createWorkspace("checked-out-branch", "checked-out-branch")
      ).rejects.toThrow(/already checked out.*\/data\/workspaces\/existing-workspace/);
    });

    it("throws WorkspaceError when branch is checked out in main worktree", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main"],
            currentBranch: "main",
          },
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      await expect(provider.createWorkspace("main", "main")).rejects.toThrow(WorkspaceError);
      await expect(provider.createWorkspace("main", "main")).rejects.toThrow(
        /already checked out.*\/home\/user\/projects\/my-repo/
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
        provider.createWorkspace("existing-branch", "existing-branch")
      ).rejects.toThrow();

      // Branch should NOT be deleted (it was pre-existing)
      expect(mockClient).toHaveBranch(PROJECT_ROOT, "existing-branch");
    });

    it("ignores remote branches when checking for existing branch", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main"],
            remoteBranches: ["origin/feature-x"], // Remote branch with same name
            currentBranch: "main",
          },
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      // Should create new local branch even though remote exists
      const workspace = await provider.createWorkspace("origin/feature-x", "main");

      expect(workspace.name).toBe("origin/feature-x");
      expect(mockClient).toHaveBranch(PROJECT_ROOT, "origin/feature-x");
    });

    it("sets branch config with correct args after creating workspace", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main"],
            currentBranch: "main",
          },
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      await provider.createWorkspace("feature-x", "main");

      // Behavioral assertion: config should be set
      expect(mockClient).toHaveBranchConfig(PROJECT_ROOT, "feature-x", "codehydra.base", "main");
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
      const workspace = await provider.createWorkspace("feature-x", "main");

      expect(workspace.name).toBe("feature-x");
    });

    it("returns workspace with metadata.base set", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main"],
            currentBranch: "main",
          },
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      const workspace = await provider.createWorkspace("feature-x", "main");

      expect(workspace.metadata.base).toBe("main");
    });
  });

  describe("removeWorkspace", () => {
    it("removes workspace without deleting branch", async () => {
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
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      const result = await provider.removeWorkspace(worktreePath, false);

      expect(result.workspaceRemoved).toBe(true);
      expect(result.baseDeleted).toBe(false);
      expect(mockClient).not.toHaveWorktree(PROJECT_ROOT, worktreePath);
      // Branch should still exist
      expect(mockClient).toHaveBranch(PROJECT_ROOT, "feature-x");
    });

    it("deletes branch even when worktree removal fails", async () => {
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
      // Override removeWorktree to fail
      mockClient.removeWorktree = vi
        .fn()
        .mockRejectedValue(new Error("Permission denied: files locked"));
      // Override deleteBranch to remove branch from state (bypasses checkout check for this test)
      const repo = mockClient.$.repositories.get(PROJECT_ROOT.toString());
      mockClient.deleteBranch = vi.fn().mockImplementation(async () => {
        repo?.branches.delete("feature-x");
      });

      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      // Should throw because worktree removal failed
      await expect(provider.removeWorkspace(worktreePath, true)).rejects.toThrow(
        "Permission denied: files locked"
      );

      // But branch should still be deleted before the error is thrown
      expect(mockClient).not.toHaveBranch(PROJECT_ROOT, "feature-x");
    });

    it("throws worktree error even when branch deletion succeeds", async () => {
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
      // Override removeWorktree to fail
      mockClient.removeWorktree = vi.fn().mockRejectedValue(new Error("Removal failed"));
      // Override deleteBranch to remove branch from state (bypasses checkout check for this test)
      const repo = mockClient.$.repositories.get(PROJECT_ROOT.toString());
      mockClient.deleteBranch = vi.fn().mockImplementation(async () => {
        repo?.branches.delete("feature-x");
      });

      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      // Should throw worktree error after branch is deleted
      await expect(provider.removeWorkspace(worktreePath, true)).rejects.toThrow("Removal failed");
      // Branch should still be deleted
      expect(mockClient).not.toHaveBranch(PROJECT_ROOT, "feature-x");
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
      await expect(provider.removeWorkspace(worktreePath, true)).rejects.toThrow(
        "Branch deletion failed"
      );
    });

    it("throws worktree error when both worktree and branch deletion fail", async () => {
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
      // Override both to fail
      mockClient.removeWorktree = vi.fn().mockRejectedValue(new Error("Worktree error"));
      mockClient.deleteBranch = vi.fn().mockRejectedValue(new Error("Branch error"));

      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      // Should throw worktree error (takes precedence)
      await expect(provider.removeWorkspace(worktreePath, true)).rejects.toThrow("Worktree error");
    });

    it("removes workspace and deletes branch when requested", async () => {
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
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      const result = await provider.removeWorkspace(worktreePath, true);

      expect(result.workspaceRemoved).toBe(true);
      expect(result.baseDeleted).toBe(true);
      expect(mockClient).not.toHaveBranch(PROJECT_ROOT, "feature-x");
    });

    it("throws WorkspaceError when trying to remove main worktree", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main"],
            currentBranch: "main",
          },
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      await expect(provider.removeWorkspace(PROJECT_ROOT, false)).rejects.toThrow(WorkspaceError);
    });

    it("handles detached HEAD workspace (no branch to delete)", async () => {
      const worktreePath = new Path("/data/workspaces/detached");
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main"],
            currentBranch: "main",
            worktrees: [{ name: "detached", path: worktreePath.toString(), branch: null }],
          },
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      const result = await provider.removeWorkspace(worktreePath, true);

      expect(result.workspaceRemoved).toBe(true);
      expect(result.baseDeleted).toBe(false);
    });

    it("returns success when worktree already removed (idempotent)", async () => {
      const worktreePath = new Path("/data/workspaces/feature-x");
      // Worktree is NOT in the list - already removed
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main"],
            currentBranch: "main",
            // No worktrees
          },
        },
      });

      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      // Should NOT throw - returns success (worktree already gone)
      const result = await provider.removeWorkspace(worktreePath, false);

      expect(result.workspaceRemoved).toBe(true);
    });

    it("deletes branch on retry when worktree already unregistered", async () => {
      const worktreePath = new Path("/data/workspaces/feature-x");
      // Worktree is NOT in the list - already unregistered from previous attempt
      // But branch still exists
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main", "feature-x"],
            currentBranch: "main",
            // No worktrees
          },
        },
      });

      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      const result = await provider.removeWorkspace(worktreePath, true);

      expect(result.workspaceRemoved).toBe(true);
      expect(result.baseDeleted).toBe(true);
      // Branch name extracted from path basename
      expect(mockClient).not.toHaveBranch(PROJECT_ROOT, "feature-x");
    });

    it("returns success when branch already deleted (idempotent)", async () => {
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

      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      // First call - actually removes
      const result1 = await provider.removeWorkspace(worktreePath, true);
      expect(result1.workspaceRemoved).toBe(true);
      expect(result1.baseDeleted).toBe(true);

      // Second call - idempotent, returns success without operations
      const result2 = await provider.removeWorkspace(worktreePath, true);
      expect(result2.workspaceRemoved).toBe(true);
      expect(result2.baseDeleted).toBe(true); // Branch already deleted, treat as success
    });
  });

  describe("isDirty", () => {
    it("returns false for clean workspace", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main", "feature-x"],
            currentBranch: "main",
            worktrees: [
              {
                name: "feature-x",
                path: "/data/workspaces/feature-x",
                branch: "feature-x",
                isDirty: false,
              },
            ],
          },
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      const dirty = await provider.isDirty(new Path("/data/workspaces/feature-x"));

      expect(dirty).toBe(false);
    });

    it("returns true when workspace has modified files", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main", "feature-x"],
            currentBranch: "main",
            worktrees: [
              {
                name: "feature-x",
                path: "/data/workspaces/feature-x",
                branch: "feature-x",
                isDirty: true,
              },
            ],
          },
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      const dirty = await provider.isDirty(new Path("/data/workspaces/feature-x"));

      expect(dirty).toBe(true);
    });

    it("returns true when main worktree is dirty", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main"],
            currentBranch: "main",
            mainIsDirty: true,
          },
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      const dirty = await provider.isDirty(PROJECT_ROOT);

      expect(dirty).toBe(true);
    });
  });

  describe("isMainWorkspace", () => {
    it("returns true for project root path", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main"],
            currentBranch: "main",
          },
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      const isMain = provider.isMainWorkspace(PROJECT_ROOT);

      expect(isMain).toBe(true);
    });

    it("returns false for other paths", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main"],
            currentBranch: "main",
          },
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      const isMain = provider.isMainWorkspace(new Path("/data/workspaces/feature-x"));

      expect(isMain).toBe(false);
    });

    it("handles path normalization", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main"],
            currentBranch: "main",
          },
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      // Path with trailing slash normalizes to same value - Path handles this automatically
      const pathWithTrailingSlash = new Path(PROJECT_ROOT.toString() + "/");
      const isMain = provider.isMainWorkspace(pathWithTrailingSlash);

      expect(isMain).toBe(true);
    });
  });

  describe("path normalization", () => {
    it("Path class removes trailing slashes", async () => {
      const worktreePath = new Path("/data/workspaces/feature-x/");
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
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      // Should match despite trailing slash in input
      const result = await provider.removeWorkspace(worktreePath, false);

      expect(result.workspaceRemoved).toBe(true);
    });

    it("Path class handles mixed separators", async () => {
      // Path normalizes ./ components
      const worktreePath = new Path("/data/workspaces/./feature-x");
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
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      // Should match despite ./ in path
      const result = await provider.removeWorkspace(worktreePath, false);

      expect(result.workspaceRemoved).toBe(true);
    });

    it("Path class normalizes paths when comparing", async () => {
      const worktreePath = new Path("/data/workspaces/feature-x");
      // Worktree stored with trailing slash
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main", "feature-x"],
            currentBranch: "main",
            worktrees: [
              { name: "feature-x", path: "/data/workspaces/feature-x/", branch: "feature-x" },
            ],
          },
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      // Should find the branch name even though stored path has trailing slash
      const result = await provider.removeWorkspace(worktreePath, true);

      expect(result.workspaceRemoved).toBe(true);
      // Should have found the branch to delete
      expect(mockClient).not.toHaveBranch(PROJECT_ROOT, "feature-x");
    });
  });

  describe("defaultBase", () => {
    it("prefers origin/main over local main", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main", "feature"],
            remoteBranches: ["origin/main"],
            currentBranch: "main",
          },
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      const result = await provider.defaultBase();

      expect(result).toBe("origin/main");
    });

    it("returns local main when origin/main does not exist", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main", "feature"],
            currentBranch: "main",
          },
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      const result = await provider.defaultBase();

      expect(result).toBe("main");
    });

    it("prefers origin/master over local master when no main exists", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["master", "feature"],
            remoteBranches: ["origin/master"],
            currentBranch: "master",
          },
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      const result = await provider.defaultBase();

      expect(result).toBe("origin/master");
    });

    it("returns local master when only master exists (no main or remotes)", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["master", "feature"],
            currentBranch: "master",
          },
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      const result = await provider.defaultBase();

      expect(result).toBe("master");
    });

    it("returns origin/main when both main and master exist", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["master", "main", "feature"],
            remoteBranches: ["origin/main", "origin/master"],
            currentBranch: "main",
          },
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      const result = await provider.defaultBase();

      expect(result).toBe("origin/main");
    });

    it("returns undefined when neither main nor master exists", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["feature", "develop"],
            currentBranch: "feature",
          },
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      const result = await provider.defaultBase();

      expect(result).toBeUndefined();
    });

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

      const result = await provider.defaultBase();

      expect(result).toBeUndefined();
    });
  });

  describe("cleanupOrphanedWorkspaces", () => {
    it("removes orphaned directories", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main", "feature-x"],
            currentBranch: "main",
            worktrees: [
              {
                name: "feature-x",
                path: new Path(WORKSPACES_DIR, "feature-x").toString(),
                branch: "feature-x",
              },
            ],
          },
        },
      });
      // Mock fs with registered worktree and an orphan
      const spyFs = createSpyFileSystemLayer({
        entries: {
          [WORKSPACES_DIR.toString()]: directory(),
          [new Path(WORKSPACES_DIR, "feature-x").toString()]: directory(),
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

      const result = await provider.cleanupOrphanedWorkspaces();

      expect(result.removedCount).toBe(1);
      expect(result.failedPaths).toHaveLength(0);
      expect(spyFs.rm).toHaveBeenCalledWith(new Path(WORKSPACES_DIR, "orphan-workspace"), {
        recursive: true,
        force: true,
      });
    });

    it("skips registered workspaces", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main", "feature-x"],
            currentBranch: "main",
            worktrees: [
              {
                name: "feature-x",
                path: new Path(WORKSPACES_DIR, "feature-x").toString(),
                branch: "feature-x",
              },
            ],
          },
        },
      });
      const spyFs = createSpyFileSystemLayer({
        entries: {
          [WORKSPACES_DIR.toString()]: directory(),
          [new Path(WORKSPACES_DIR, "feature-x").toString()]: directory(),
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        spyFs,
        mockLogger
      );

      const result = await provider.cleanupOrphanedWorkspaces();

      expect(result.removedCount).toBe(0);
      expect(spyFs.rm).not.toHaveBeenCalled();
    });

    it("skips symlinks", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main"],
            currentBranch: "main",
          },
        },
      });
      const spyFs = createSpyFileSystemLayer({
        entries: {
          [WORKSPACES_DIR.toString()]: directory(),
          [new Path(WORKSPACES_DIR, "symlink-entry").toString()]: symlink("/target"),
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        spyFs,
        mockLogger
      );

      const result = await provider.cleanupOrphanedWorkspaces();

      expect(result.removedCount).toBe(0);
      expect(spyFs.rm).not.toHaveBeenCalled();
    });

    it("skips files", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main"],
            currentBranch: "main",
          },
        },
      });
      const spyFs = createSpyFileSystemLayer({
        entries: {
          [WORKSPACES_DIR.toString()]: directory(),
          [new Path(WORKSPACES_DIR, "some-file.txt").toString()]: file(""),
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        spyFs,
        mockLogger
      );

      const result = await provider.cleanupOrphanedWorkspaces();

      expect(result.removedCount).toBe(0);
      expect(spyFs.rm).not.toHaveBeenCalled();
    });

    it("validates paths stay within workspacesDir", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main"],
            currentBranch: "main",
          },
        },
      });
      const spyFs = createSpyFileSystemLayer({
        entries: {
          [WORKSPACES_DIR.toString()]: directory(),
        },
      });
      // Manually add an entry with a suspicious name using setEntry
      spyFs.$.setEntry(new Path(WORKSPACES_DIR, "../../../etc"), directory());

      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        spyFs,
        mockLogger
      );

      const result = await provider.cleanupOrphanedWorkspaces();

      expect(result.removedCount).toBe(0);
      expect(spyFs.rm).not.toHaveBeenCalled();
    });

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

      const result = await provider.cleanupOrphanedWorkspaces();

      // Should not delete because it's now registered
      expect(result.removedCount).toBe(0);
      expect(spyFs.rm).not.toHaveBeenCalled();
    });

    it("returns CleanupResult with counts", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main"],
            currentBranch: "main",
          },
        },
      });
      const spyFs = createSpyFileSystemLayer({
        entries: {
          [WORKSPACES_DIR.toString()]: directory(),
          [new Path(WORKSPACES_DIR, "orphan-1").toString()]: directory(),
          [new Path(WORKSPACES_DIR, "orphan-2").toString()]: directory(),
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        spyFs,
        mockLogger
      );

      const result = await provider.cleanupOrphanedWorkspaces();

      expect(result.removedCount).toBe(2);
      expect(result.failedPaths).toHaveLength(0);
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
      const result = await provider.cleanupOrphanedWorkspaces();

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
      const result = await provider.cleanupOrphanedWorkspaces();

      expect(result.removedCount).toBe(0);
      expect(result.failedPaths).toHaveLength(0);
    });

    it("handles missing workspacesDir", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main"],
            currentBranch: "main",
          },
        },
      });
      // Empty mock - no workspacesDir means readdir throws ENOENT
      const mockFsNotFound = createFileSystemMock();
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFsNotFound,
        mockLogger
      );

      const result = await provider.cleanupOrphanedWorkspaces();

      expect(result.removedCount).toBe(0);
      expect(result.failedPaths).toHaveLength(0);
    });

    it("handles empty workspacesDir", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main"],
            currentBranch: "main",
          },
        },
      });
      // Workspaces dir exists but is empty
      const mockFsEmpty = createFileSystemMock({
        entries: {
          [WORKSPACES_DIR.toString()]: directory(),
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFsEmpty,
        mockLogger
      );

      const result = await provider.cleanupOrphanedWorkspaces();

      expect(result.removedCount).toBe(0);
      expect(result.failedPaths).toHaveLength(0);
    });

    it("normalizes paths when comparing", async () => {
      // Worktree path has trailing slash - Path normalizes it automatically
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main", "feature-x"],
            currentBranch: "main",
            worktrees: [
              {
                name: "feature-x",
                path: WORKSPACES_DIR.toString() + "/feature-x/",
                branch: "feature-x",
              },
            ],
          },
        },
      });
      const spyFs = createSpyFileSystemLayer({
        entries: {
          [WORKSPACES_DIR.toString()]: directory(),
          [new Path(WORKSPACES_DIR, "feature-x").toString()]: directory(),
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        spyFs,
        mockLogger
      );

      const result = await provider.cleanupOrphanedWorkspaces();

      // Should NOT delete because it matches registered worktree
      expect(result.removedCount).toBe(0);
      expect(spyFs.rm).not.toHaveBeenCalled();
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
      const firstCleanup = provider.cleanupOrphanedWorkspaces();

      // Give a moment for the first cleanup to start
      await delay(10);

      // Start second cleanup while first is in progress
      const secondCleanup = provider.cleanupOrphanedWorkspaces();
      const secondResult = await secondCleanup;

      // Second cleanup should return immediately with empty result
      expect(secondResult.removedCount).toBe(0);
      expect(secondResult.failedPaths).toHaveLength(0);

      // Now resolve the first cleanup
      slowResolve!();
      await firstCleanup;
    });
  });

  describe("discover - metadata property", () => {
    it("returns metadata with base from config", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main", "feature-x"],
            currentBranch: "main",
            worktrees: [
              { name: "feature-x", path: "/data/workspaces/feature-x", branch: "feature-x" },
            ],
            branchConfigs: {
              "feature-x": { "codehydra.base": "develop" },
            },
          },
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      const workspaces = await provider.discover();

      expect(workspaces).toHaveLength(1);
      expect(workspaces[0]!.metadata.base).toBe("develop");
    });

    it("returns metadata with base fallback to branch when no config", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main", "feature-x"],
            currentBranch: "main",
            worktrees: [
              { name: "feature-x", path: "/data/workspaces/feature-x", branch: "feature-x" },
            ],
            // No config
          },
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      const workspaces = await provider.discover();

      expect(workspaces).toHaveLength(1);
      expect(workspaces[0]!.metadata.base).toBe("feature-x"); // Falls back to branch
    });

    it("returns metadata with base fallback to name when no branch (detached HEAD)", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main"],
            currentBranch: "main",
            worktrees: [
              {
                name: "detached-workspace",
                path: "/data/workspaces/detached-workspace",
                branch: null,
              },
            ],
          },
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      const workspaces = await provider.discover();

      expect(workspaces).toHaveLength(1);
      expect(workspaces[0]!.metadata.base).toBe("detached-workspace"); // Falls back to name
    });

    it("returns full metadata from config (multiple keys)", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main", "feature-x"],
            currentBranch: "main",
            worktrees: [
              { name: "feature-x", path: "/data/workspaces/feature-x", branch: "feature-x" },
            ],
            branchConfigs: {
              "feature-x": {
                "codehydra.base": "main",
                "codehydra.note": "WIP auth feature",
                "codehydra.model": "claude-4",
              },
            },
          },
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      const workspaces = await provider.discover();

      expect(workspaces).toHaveLength(1);
      expect(workspaces[0]!.metadata).toEqual({
        base: "main",
        note: "WIP auth feature",
        model: "claude-4",
      });
    });
  });

  describe("createWorkspace - metadata property", () => {
    it("returns workspace with metadata.base set", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main"],
            currentBranch: "main",
          },
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      const workspace = await provider.createWorkspace("feature-x", "main");

      expect(workspace.metadata).toEqual({ base: "main" });
    });
  });

  describe("setMetadata", () => {
    it("validates key format (rejects invalid)", async () => {
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
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      await expect(provider.setMetadata(worktreePath, "my_key", "value")).rejects.toThrow(
        WorkspaceError
      );

      // Verify error code
      try {
        await provider.setMetadata(worktreePath, "my_key", "value");
      } catch (error) {
        expect(error).toBeInstanceOf(WorkspaceError);
        expect((error as WorkspaceError).code).toBe("INVALID_METADATA_KEY");
      }
    });

    it("sets branch config correctly", async () => {
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
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      await provider.setMetadata(worktreePath, "note", "WIP feature");

      // Behavioral assertion: config should be set
      expect(mockClient).toHaveBranchConfig(
        PROJECT_ROOT,
        "feature-x",
        "codehydra.note",
        "WIP feature"
      );
    });

    it("unsets branch config when value is null", async () => {
      const worktreePath = new Path("/data/workspaces/feature-x");
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main", "feature-x"],
            currentBranch: "main",
            worktrees: [{ name: "feature-x", path: worktreePath.toString(), branch: "feature-x" }],
            branchConfigs: {
              "feature-x": { "codehydra.note": "existing note" },
            },
          },
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      await provider.setMetadata(worktreePath, "note", null);

      // Config should be removed - the key should not exist
      // Note: when a branch's config becomes empty, the mock removes the entire entry
      const branchConfigs = mockClient.$.repositories.get(PROJECT_ROOT.toString())?.branchConfigs;
      const featureConfigs = branchConfigs?.get("feature-x");
      // Either the config map is gone (empty cleanup) or the key doesn't exist
      expect(featureConfigs?.has("codehydra.note") ?? false).toBe(false);
    });
  });

  describe("getMetadata", () => {
    it("applies base fallback when not in config", async () => {
      const worktreePath = new Path("/data/workspaces/feature-x");
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main", "feature-x"],
            currentBranch: "main",
            worktrees: [{ name: "feature-x", path: worktreePath.toString(), branch: "feature-x" }],
            branchConfigs: {
              "feature-x": { "codehydra.note": "test note" }, // No base
            },
          },
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      const metadata = await provider.getMetadata(worktreePath);

      expect(metadata.base).toBe("feature-x"); // Fallback to branch
      expect(metadata.note).toBe("test note");
    });

    it("returns all metadata keys", async () => {
      const worktreePath = new Path("/data/workspaces/feature-x");
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main", "feature-x"],
            currentBranch: "main",
            worktrees: [{ name: "feature-x", path: worktreePath.toString(), branch: "feature-x" }],
            branchConfigs: {
              "feature-x": {
                "codehydra.base": "develop",
                "codehydra.note": "WIP",
                "codehydra.model": "claude-4",
              },
            },
          },
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        mockLogger
      );

      const metadata = await provider.getMetadata(worktreePath);

      expect(metadata).toEqual({
        base: "develop",
        note: "WIP",
        model: "claude-4",
      });
    });
  });
});
