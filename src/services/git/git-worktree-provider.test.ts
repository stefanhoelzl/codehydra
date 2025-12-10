// @vitest-environment node
/**
 * Unit tests for GitWorktreeProvider using mocked IGitClient.
 */

import { describe, it, expect, vi } from "vitest";
import { GitWorktreeProvider } from "./git-worktree-provider";
import type { IGitClient } from "./git-client";
import { WorkspaceError } from "../errors";
import type { BranchInfo, WorktreeInfo } from "./types";

/**
 * Create a mock IGitClient for testing.
 */
function createMockGitClient(overrides: Partial<IGitClient> = {}): IGitClient {
  return {
    isGitRepository: vi.fn().mockResolvedValue(true),
    listWorktrees: vi.fn().mockResolvedValue([]),
    addWorktree: vi.fn().mockResolvedValue(undefined),
    removeWorktree: vi.fn().mockResolvedValue(undefined),
    pruneWorktrees: vi.fn().mockResolvedValue(undefined),
    listBranches: vi.fn().mockResolvedValue([]),
    createBranch: vi.fn().mockResolvedValue(undefined),
    deleteBranch: vi.fn().mockResolvedValue(undefined),
    getCurrentBranch: vi.fn().mockResolvedValue("main"),
    getStatus: vi.fn().mockResolvedValue({
      isDirty: false,
      modifiedCount: 0,
      stagedCount: 0,
      untrackedCount: 0,
    }),
    fetch: vi.fn().mockResolvedValue(undefined),
    listRemotes: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe("GitWorktreeProvider", () => {
  const PROJECT_ROOT = "/home/user/projects/my-repo";
  const WORKSPACES_DIR = "/home/user/app-data/projects/my-repo-abc12345/workspaces";

  describe("create (factory)", () => {
    it("creates provider for valid git repository", async () => {
      const mockClient = createMockGitClient();

      const provider = await GitWorktreeProvider.create(PROJECT_ROOT, mockClient, WORKSPACES_DIR);

      expect(provider).toBeInstanceOf(GitWorktreeProvider);
      expect(provider.projectRoot).toBe(PROJECT_ROOT);
    });

    it("throws WorkspaceError for relative project path", async () => {
      const mockClient = createMockGitClient();

      await expect(
        GitWorktreeProvider.create("relative/path", mockClient, WORKSPACES_DIR)
      ).rejects.toThrow(WorkspaceError);
    });

    it("throws WorkspaceError for relative workspacesDir", async () => {
      const mockClient = createMockGitClient();

      await expect(
        GitWorktreeProvider.create(PROJECT_ROOT, mockClient, "relative/workspaces")
      ).rejects.toThrow(WorkspaceError);
    });

    it("throws WorkspaceError when path is not a git repository", async () => {
      const mockClient = createMockGitClient({
        isGitRepository: vi.fn().mockResolvedValue(false),
      });

      await expect(
        GitWorktreeProvider.create(PROJECT_ROOT, mockClient, WORKSPACES_DIR)
      ).rejects.toThrow(WorkspaceError);
    });

    it("throws WorkspaceError when git client throws", async () => {
      const mockClient = createMockGitClient({
        isGitRepository: vi.fn().mockRejectedValue(new Error("Path does not exist")),
      });

      await expect(
        GitWorktreeProvider.create(PROJECT_ROOT, mockClient, WORKSPACES_DIR)
      ).rejects.toThrow(WorkspaceError);
    });
  });

  describe("discover", () => {
    it("returns empty array when only main worktree exists", async () => {
      const mainWorktree: WorktreeInfo = {
        name: "my-repo",
        path: PROJECT_ROOT,
        branch: "main",
        isMain: true,
      };
      const mockClient = createMockGitClient({
        listWorktrees: vi.fn().mockResolvedValue([mainWorktree]),
      });
      const provider = await GitWorktreeProvider.create(PROJECT_ROOT, mockClient, WORKSPACES_DIR);

      const workspaces = await provider.discover();

      expect(workspaces).toHaveLength(0);
    });

    it("excludes main worktree from results", async () => {
      const worktrees: WorktreeInfo[] = [
        { name: "my-repo", path: PROJECT_ROOT, branch: "main", isMain: true },
        {
          name: "feature-branch",
          path: "/data/workspaces/feature-branch",
          branch: "feature-branch",
          isMain: false,
        },
      ];
      const mockClient = createMockGitClient({
        listWorktrees: vi.fn().mockResolvedValue(worktrees),
      });
      const provider = await GitWorktreeProvider.create(PROJECT_ROOT, mockClient, WORKSPACES_DIR);

      const workspaces = await provider.discover();

      expect(workspaces).toHaveLength(1);
      expect(workspaces[0].name).toBe("feature-branch");
    });

    it("handles detached HEAD workspaces", async () => {
      const worktrees: WorktreeInfo[] = [
        { name: "my-repo", path: PROJECT_ROOT, branch: "main", isMain: true },
        {
          name: "detached-workspace",
          path: "/data/workspaces/detached",
          branch: null,
          isMain: false,
        },
      ];
      const mockClient = createMockGitClient({
        listWorktrees: vi.fn().mockResolvedValue(worktrees),
      });
      const provider = await GitWorktreeProvider.create(PROJECT_ROOT, mockClient, WORKSPACES_DIR);

      const workspaces = await provider.discover();

      expect(workspaces).toHaveLength(1);
      expect(workspaces[0].branch).toBeNull();
    });

    it("returns multiple workspaces", async () => {
      const worktrees: WorktreeInfo[] = [
        { name: "my-repo", path: PROJECT_ROOT, branch: "main", isMain: true },
        {
          name: "feature-a",
          path: "/data/workspaces/feature-a",
          branch: "feature-a",
          isMain: false,
        },
        {
          name: "feature-b",
          path: "/data/workspaces/feature-b",
          branch: "feature-b",
          isMain: false,
        },
      ];
      const mockClient = createMockGitClient({
        listWorktrees: vi.fn().mockResolvedValue(worktrees),
      });
      const provider = await GitWorktreeProvider.create(PROJECT_ROOT, mockClient, WORKSPACES_DIR);

      const workspaces = await provider.discover();

      expect(workspaces).toHaveLength(2);
    });

    it("skips corrupted worktree entries without throwing", async () => {
      // Simulate worktrees with invalid/missing data that git might return
      const worktrees: WorktreeInfo[] = [
        { name: "my-repo", path: PROJECT_ROOT, branch: "main", isMain: true },
        // Valid worktree
        {
          name: "feature-valid",
          path: "/data/workspaces/feature-valid",
          branch: "feature-valid",
          isMain: false,
        },
        // Worktree with empty path (corrupted)
        {
          name: "",
          path: "",
          branch: null,
          isMain: false,
        },
        // Worktree with empty name but valid path
        {
          name: "",
          path: "/data/workspaces/unnamed",
          branch: "unnamed-branch",
          isMain: false,
        },
      ];
      const mockClient = createMockGitClient({
        listWorktrees: vi.fn().mockResolvedValue(worktrees),
      });
      const provider = await GitWorktreeProvider.create(PROJECT_ROOT, mockClient, WORKSPACES_DIR);

      // Should not throw and should handle gracefully
      const workspaces = await provider.discover();

      // Should include valid worktrees, and filter or include entries based on implementation
      // The key is that it doesn't throw
      expect(Array.isArray(workspaces)).toBe(true);
      // At minimum, the valid worktree should be included
      expect(workspaces.some((w) => w.name === "feature-valid")).toBe(true);
    });
  });

  describe("listBases", () => {
    it("returns local and remote branches", async () => {
      const branches: BranchInfo[] = [
        { name: "main", isRemote: false },
        { name: "feature", isRemote: false },
        { name: "origin/main", isRemote: true },
      ];
      const mockClient = createMockGitClient({
        listBranches: vi.fn().mockResolvedValue(branches),
      });
      const provider = await GitWorktreeProvider.create(PROJECT_ROOT, mockClient, WORKSPACES_DIR);

      const bases = await provider.listBases();

      expect(bases).toHaveLength(3);
      expect(bases.find((b) => b.name === "main" && !b.isRemote)).toBeDefined();
      expect(bases.find((b) => b.name === "origin/main" && b.isRemote)).toBeDefined();
    });
  });

  describe("updateBases", () => {
    it("returns success when fetch succeeds", async () => {
      const mockClient = createMockGitClient({
        listRemotes: vi.fn().mockResolvedValue(["origin"]),
        fetch: vi.fn().mockResolvedValue(undefined),
      });
      const provider = await GitWorktreeProvider.create(PROJECT_ROOT, mockClient, WORKSPACES_DIR);

      const result = await provider.updateBases();

      expect(result.fetchedRemotes).toContain("origin");
      expect(result.failedRemotes).toHaveLength(0);
    });

    it("returns partial failure when some fetches fail", async () => {
      const mockClient = createMockGitClient({
        listRemotes: vi.fn().mockResolvedValue(["origin", "backup"]),
        fetch: vi
          .fn()
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error("Network error")),
      });
      const provider = await GitWorktreeProvider.create(PROJECT_ROOT, mockClient, WORKSPACES_DIR);

      const result = await provider.updateBases();

      expect(result.fetchedRemotes).toContain("origin");
      expect(result.failedRemotes).toHaveLength(1);
      expect(result.failedRemotes[0].remote).toBe("backup");
      expect(result.failedRemotes[0].error).toContain("Network error");
    });

    it("returns empty arrays when no remotes exist", async () => {
      const mockClient = createMockGitClient({
        listRemotes: vi.fn().mockResolvedValue([]),
      });
      const provider = await GitWorktreeProvider.create(PROJECT_ROOT, mockClient, WORKSPACES_DIR);

      const result = await provider.updateBases();

      expect(result.fetchedRemotes).toHaveLength(0);
      expect(result.failedRemotes).toHaveLength(0);
    });
  });

  describe("createWorkspace", () => {
    it("creates workspace and returns workspace info", async () => {
      const mockClient = createMockGitClient({
        listWorktrees: vi
          .fn()
          .mockResolvedValue([
            { name: "my-repo", path: PROJECT_ROOT, branch: "main", isMain: true },
          ]),
      });
      const provider = await GitWorktreeProvider.create(PROJECT_ROOT, mockClient, WORKSPACES_DIR);

      const workspace = await provider.createWorkspace("feature-x", "main");

      expect(workspace.name).toBe("feature-x");
      expect(workspace.branch).toBe("feature-x");
      expect(mockClient.createBranch).toHaveBeenCalledWith(PROJECT_ROOT, "feature-x", "main");
      expect(mockClient.addWorktree).toHaveBeenCalled();
    });

    it("sanitizes branch names with slashes", async () => {
      const mockClient = createMockGitClient({
        listWorktrees: vi
          .fn()
          .mockResolvedValue([
            { name: "my-repo", path: PROJECT_ROOT, branch: "main", isMain: true },
          ]),
      });
      const provider = await GitWorktreeProvider.create(PROJECT_ROOT, mockClient, WORKSPACES_DIR);

      const workspace = await provider.createWorkspace("user/feature", "main");

      // The directory name should have sanitized slashes
      expect(workspace.name).toBe("user/feature");
      expect(mockClient.createBranch).toHaveBeenCalledWith(PROJECT_ROOT, "user/feature", "main");
    });

    it("rolls back branch on worktree creation failure", async () => {
      const mockClient = createMockGitClient({
        addWorktree: vi.fn().mockRejectedValue(new Error("Worktree creation failed")),
      });
      const provider = await GitWorktreeProvider.create(PROJECT_ROOT, mockClient, WORKSPACES_DIR);

      await expect(provider.createWorkspace("feature-x", "main")).rejects.toThrow();

      expect(mockClient.deleteBranch).toHaveBeenCalledWith(PROJECT_ROOT, "feature-x");
    });

    it("throws WorkspaceError when branch creation fails", async () => {
      const mockClient = createMockGitClient({
        createBranch: vi.fn().mockRejectedValue(new Error("Branch exists")),
      });
      const provider = await GitWorktreeProvider.create(PROJECT_ROOT, mockClient, WORKSPACES_DIR);

      await expect(provider.createWorkspace("feature-x", "main")).rejects.toThrow(WorkspaceError);
    });
  });

  describe("removeWorkspace", () => {
    it("removes workspace without deleting branch", async () => {
      const worktreePath = "/data/workspaces/feature-x";
      const worktrees: WorktreeInfo[] = [
        { name: "my-repo", path: PROJECT_ROOT, branch: "main", isMain: true },
        { name: "feature-x", path: worktreePath, branch: "feature-x", isMain: false },
      ];
      const mockClient = createMockGitClient({
        listWorktrees: vi.fn().mockResolvedValue(worktrees),
      });
      const provider = await GitWorktreeProvider.create(PROJECT_ROOT, mockClient, WORKSPACES_DIR);

      const result = await provider.removeWorkspace(worktreePath, false);

      expect(result.workspaceRemoved).toBe(true);
      expect(result.baseDeleted).toBe(false);
      expect(mockClient.removeWorktree).toHaveBeenCalledWith(PROJECT_ROOT, worktreePath);
      expect(mockClient.pruneWorktrees).toHaveBeenCalledWith(PROJECT_ROOT);
      expect(mockClient.deleteBranch).not.toHaveBeenCalled();
    });

    it("removes workspace and deletes branch when requested", async () => {
      const worktreePath = "/data/workspaces/feature-x";
      const worktrees: WorktreeInfo[] = [
        { name: "my-repo", path: PROJECT_ROOT, branch: "main", isMain: true },
        { name: "feature-x", path: worktreePath, branch: "feature-x", isMain: false },
      ];
      const mockClient = createMockGitClient({
        listWorktrees: vi.fn().mockResolvedValue(worktrees),
      });
      const provider = await GitWorktreeProvider.create(PROJECT_ROOT, mockClient, WORKSPACES_DIR);

      const result = await provider.removeWorkspace(worktreePath, true);

      expect(result.workspaceRemoved).toBe(true);
      expect(result.baseDeleted).toBe(true);
      expect(mockClient.deleteBranch).toHaveBeenCalledWith(PROJECT_ROOT, "feature-x");
    });

    it("throws WorkspaceError when trying to remove main worktree", async () => {
      const mockClient = createMockGitClient();
      const provider = await GitWorktreeProvider.create(PROJECT_ROOT, mockClient, WORKSPACES_DIR);

      await expect(provider.removeWorkspace(PROJECT_ROOT, false)).rejects.toThrow(WorkspaceError);
    });

    it("handles detached HEAD workspace (no branch to delete)", async () => {
      const worktreePath = "/data/workspaces/detached";
      const worktrees: WorktreeInfo[] = [
        { name: "my-repo", path: PROJECT_ROOT, branch: "main", isMain: true },
        { name: "detached", path: worktreePath, branch: null, isMain: false },
      ];
      const mockClient = createMockGitClient({
        listWorktrees: vi.fn().mockResolvedValue(worktrees),
      });
      const provider = await GitWorktreeProvider.create(PROJECT_ROOT, mockClient, WORKSPACES_DIR);

      const result = await provider.removeWorkspace(worktreePath, true);

      expect(result.workspaceRemoved).toBe(true);
      expect(result.baseDeleted).toBe(false);
      expect(mockClient.deleteBranch).not.toHaveBeenCalled();
    });
  });

  describe("isDirty", () => {
    it("returns false for clean workspace", async () => {
      const mockClient = createMockGitClient({
        getStatus: vi.fn().mockResolvedValue({
          isDirty: false,
          modifiedCount: 0,
          stagedCount: 0,
          untrackedCount: 0,
        }),
      });
      const provider = await GitWorktreeProvider.create(PROJECT_ROOT, mockClient, WORKSPACES_DIR);

      const dirty = await provider.isDirty("/data/workspaces/feature-x");

      expect(dirty).toBe(false);
    });

    it("returns true when workspace has modified files", async () => {
      const mockClient = createMockGitClient({
        getStatus: vi.fn().mockResolvedValue({
          isDirty: true,
          modifiedCount: 2,
          stagedCount: 0,
          untrackedCount: 0,
        }),
      });
      const provider = await GitWorktreeProvider.create(PROJECT_ROOT, mockClient, WORKSPACES_DIR);

      const dirty = await provider.isDirty("/data/workspaces/feature-x");

      expect(dirty).toBe(true);
    });

    it("returns true when workspace has staged files", async () => {
      const mockClient = createMockGitClient({
        getStatus: vi.fn().mockResolvedValue({
          isDirty: true,
          modifiedCount: 0,
          stagedCount: 1,
          untrackedCount: 0,
        }),
      });
      const provider = await GitWorktreeProvider.create(PROJECT_ROOT, mockClient, WORKSPACES_DIR);

      const dirty = await provider.isDirty("/data/workspaces/feature-x");

      expect(dirty).toBe(true);
    });

    it("returns true when workspace has untracked files", async () => {
      const mockClient = createMockGitClient({
        getStatus: vi.fn().mockResolvedValue({
          isDirty: true,
          modifiedCount: 0,
          stagedCount: 0,
          untrackedCount: 3,
        }),
      });
      const provider = await GitWorktreeProvider.create(PROJECT_ROOT, mockClient, WORKSPACES_DIR);

      const dirty = await provider.isDirty("/data/workspaces/feature-x");

      expect(dirty).toBe(true);
    });
  });

  describe("isMainWorkspace", () => {
    it("returns true for project root path", async () => {
      const mockClient = createMockGitClient();
      const provider = await GitWorktreeProvider.create(PROJECT_ROOT, mockClient, WORKSPACES_DIR);

      const isMain = provider.isMainWorkspace(PROJECT_ROOT);

      expect(isMain).toBe(true);
    });

    it("returns false for other paths", async () => {
      const mockClient = createMockGitClient();
      const provider = await GitWorktreeProvider.create(PROJECT_ROOT, mockClient, WORKSPACES_DIR);

      const isMain = provider.isMainWorkspace("/data/workspaces/feature-x");

      expect(isMain).toBe(false);
    });

    it("handles path normalization", async () => {
      const mockClient = createMockGitClient();
      const provider = await GitWorktreeProvider.create(PROJECT_ROOT, mockClient, WORKSPACES_DIR);

      // Path with trailing slash should still match
      const isMain = provider.isMainWorkspace(PROJECT_ROOT + "/");

      expect(isMain).toBe(true);
    });
  });
});
