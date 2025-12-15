// @vitest-environment node
/**
 * Unit tests for GitWorktreeProvider using mocked IGitClient.
 */

import { describe, it, expect, vi } from "vitest";
import { GitWorktreeProvider } from "./git-worktree-provider";
import type { IGitClient } from "./git-client";
import { WorkspaceError } from "../errors";
import type { BranchInfo, WorktreeInfo } from "./types";
import { createMockFileSystemLayer, createDirEntry } from "../platform/filesystem.test-utils";
import { FileSystemError } from "../errors";

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
    getBranchConfig: vi.fn().mockResolvedValue(null),
    setBranchConfig: vi.fn().mockResolvedValue(undefined),
    getBranchConfigsByPrefix: vi.fn().mockResolvedValue({}),
    unsetBranchConfig: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("GitWorktreeProvider", () => {
  const PROJECT_ROOT = "/home/user/projects/my-repo";
  const WORKSPACES_DIR = "/home/user/app-data/projects/my-repo-abc12345/workspaces";
  const mockFs = createMockFileSystemLayer();

  describe("create (factory)", () => {
    it("creates provider for valid git repository", async () => {
      const mockClient = createMockGitClient();

      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
      );

      expect(provider).toBeInstanceOf(GitWorktreeProvider);
      expect(provider.projectRoot).toBe(PROJECT_ROOT);
    });

    it("throws WorkspaceError for relative project path", async () => {
      const mockClient = createMockGitClient();

      await expect(
        GitWorktreeProvider.create("relative/path", mockClient, WORKSPACES_DIR, mockFs)
      ).rejects.toThrow(WorkspaceError);
    });

    it("throws WorkspaceError for relative workspacesDir", async () => {
      const mockClient = createMockGitClient();

      await expect(
        GitWorktreeProvider.create(PROJECT_ROOT, mockClient, "relative/workspaces", mockFs)
      ).rejects.toThrow(WorkspaceError);
    });

    it("throws WorkspaceError when path is not a git repository", async () => {
      const mockClient = createMockGitClient({
        isGitRepository: vi.fn().mockResolvedValue(false),
      });

      await expect(
        GitWorktreeProvider.create(PROJECT_ROOT, mockClient, WORKSPACES_DIR, mockFs)
      ).rejects.toThrow(WorkspaceError);
    });

    it("throws WorkspaceError when git client throws", async () => {
      const mockClient = createMockGitClient({
        isGitRepository: vi.fn().mockRejectedValue(new Error("Path does not exist")),
      });

      await expect(
        GitWorktreeProvider.create(PROJECT_ROOT, mockClient, WORKSPACES_DIR, mockFs)
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
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
      );

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
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
      );

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
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
      );

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
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
      );

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
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
      );

      // Should not throw and should handle gracefully
      const workspaces = await provider.discover();

      // Should include valid worktrees, and filter or include entries based on implementation
      // The key is that it doesn't throw
      expect(Array.isArray(workspaces)).toBe(true);
      // At minimum, the valid worktree should be included
      expect(workspaces.some((w) => w.name === "feature-valid")).toBe(true);
    });

    it("returns baseBranch from config when set", async () => {
      const worktrees: WorktreeInfo[] = [
        { name: "my-repo", path: PROJECT_ROOT, branch: "main", isMain: true },
        {
          name: "feature-x",
          path: "/data/workspaces/feature-x",
          branch: "feature-x",
          isMain: false,
        },
      ];
      const mockClient = createMockGitClient({
        listWorktrees: vi.fn().mockResolvedValue(worktrees),
        getBranchConfigsByPrefix: vi.fn().mockResolvedValue({ base: "develop" }),
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
      );

      const workspaces = await provider.discover();

      expect(workspaces).toHaveLength(1);
      expect(workspaces[0].metadata.base).toBe("develop");
    });

    it("falls back to branch name when config returns null", async () => {
      const worktrees: WorktreeInfo[] = [
        { name: "my-repo", path: PROJECT_ROOT, branch: "main", isMain: true },
        {
          name: "feature-x",
          path: "/data/workspaces/feature-x",
          branch: "feature-x",
          isMain: false,
        },
      ];
      const mockClient = createMockGitClient({
        listWorktrees: vi.fn().mockResolvedValue(worktrees),
        getBranchConfigsByPrefix: vi.fn().mockResolvedValue({}), // No base config
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
      );

      const workspaces = await provider.discover();

      expect(workspaces).toHaveLength(1);
      expect(workspaces[0].metadata.base).toBe("feature-x");
    });

    it("falls back to workspace name when detached HEAD (branch is null)", async () => {
      const worktrees: WorktreeInfo[] = [
        { name: "my-repo", path: PROJECT_ROOT, branch: "main", isMain: true },
        {
          name: "detached-workspace",
          path: "/data/workspaces/detached-workspace",
          branch: null,
          isMain: false,
        },
      ];
      const mockClient = createMockGitClient({
        listWorktrees: vi.fn().mockResolvedValue(worktrees),
        getBranchConfigsByPrefix: vi.fn().mockResolvedValue({}), // No config
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
      );

      const workspaces = await provider.discover();

      expect(workspaces).toHaveLength(1);
      expect(workspaces[0].metadata.base).toBe("detached-workspace");
    });

    it("logs warning and uses fallback when getBranchConfigsByPrefix throws", async () => {
      const worktrees: WorktreeInfo[] = [
        { name: "my-repo", path: PROJECT_ROOT, branch: "main", isMain: true },
        {
          name: "feature-x",
          path: "/data/workspaces/feature-x",
          branch: "feature-x",
          isMain: false,
        },
      ];
      const mockClient = createMockGitClient({
        listWorktrees: vi.fn().mockResolvedValue(worktrees),
        getBranchConfigsByPrefix: vi.fn().mockRejectedValue(new Error("Config read failed")),
      });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
      );

      const workspaces = await provider.discover();

      expect(workspaces).toHaveLength(1);
      // Should fall back to branch name
      expect(workspaces[0].metadata.base).toBe("feature-x");
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to get metadata"));
      warnSpy.mockRestore();
    });

    it("fallback priority: config > branch > name", async () => {
      const worktrees: WorktreeInfo[] = [
        { name: "my-repo", path: PROJECT_ROOT, branch: "main", isMain: true },
        // Has config - should use config value
        {
          name: "workspace-a",
          path: "/data/workspaces/workspace-a",
          branch: "branch-a",
          isMain: false,
        },
        // No config - should use branch
        {
          name: "workspace-b",
          path: "/data/workspaces/workspace-b",
          branch: "branch-b",
          isMain: false,
        },
        // No config, no branch (detached) - should use name
        {
          name: "workspace-c",
          path: "/data/workspaces/workspace-c",
          branch: null,
          isMain: false,
        },
      ];
      const mockClient = createMockGitClient({
        listWorktrees: vi.fn().mockResolvedValue(worktrees),
        getBranchConfigsByPrefix: vi.fn().mockImplementation((_repo, branch) => {
          // Only workspace-a has config set
          if (branch === "branch-a") {
            return Promise.resolve({ base: "configured-base" });
          }
          return Promise.resolve({});
        }),
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
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
      const branches: BranchInfo[] = [
        { name: "main", isRemote: false },
        { name: "feature", isRemote: false },
        { name: "origin/main", isRemote: true },
      ];
      const mockClient = createMockGitClient({
        listBranches: vi.fn().mockResolvedValue(branches),
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
      );

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
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
      );

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
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
      );

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
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
      );

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
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
      );

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
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
      );

      const workspace = await provider.createWorkspace("user/feature", "main");

      // The directory name should have sanitized slashes
      expect(workspace.name).toBe("user/feature");
      expect(mockClient.createBranch).toHaveBeenCalledWith(PROJECT_ROOT, "user/feature", "main");
    });

    it("rolls back branch on worktree creation failure", async () => {
      const mockClient = createMockGitClient({
        addWorktree: vi.fn().mockRejectedValue(new Error("Worktree creation failed")),
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
      );

      await expect(provider.createWorkspace("feature-x", "main")).rejects.toThrow();

      expect(mockClient.deleteBranch).toHaveBeenCalledWith(PROJECT_ROOT, "feature-x");
    });

    it("throws WorkspaceError when branch creation fails", async () => {
      const mockClient = createMockGitClient({
        createBranch: vi.fn().mockRejectedValue(new Error("Branch exists")),
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
      );

      await expect(provider.createWorkspace("feature-x", "main")).rejects.toThrow(WorkspaceError);
    });

    it("creates workspace using existing branch when baseBranch matches branch name", async () => {
      const branches: BranchInfo[] = [
        { name: "main", isRemote: false },
        { name: "existing-branch", isRemote: false },
      ];
      const worktrees: WorktreeInfo[] = [
        { name: "my-repo", path: PROJECT_ROOT, branch: "main", isMain: true },
      ];
      const mockClient = createMockGitClient({
        listBranches: vi.fn().mockResolvedValue(branches),
        listWorktrees: vi.fn().mockResolvedValue(worktrees),
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
      );

      const workspace = await provider.createWorkspace("existing-branch", "existing-branch");

      expect(workspace.name).toBe("existing-branch");
      expect(workspace.branch).toBe("existing-branch");
      // Should NOT create branch - it already exists
      expect(mockClient.createBranch).not.toHaveBeenCalled();
      // Should still create worktree
      expect(mockClient.addWorktree).toHaveBeenCalled();
    });

    it("throws WorkspaceError when branch exists but baseBranch differs", async () => {
      const branches: BranchInfo[] = [
        { name: "main", isRemote: false },
        { name: "existing-branch", isRemote: false },
      ];
      const mockClient = createMockGitClient({
        listBranches: vi.fn().mockResolvedValue(branches),
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
      );

      await expect(provider.createWorkspace("existing-branch", "main")).rejects.toThrow(
        WorkspaceError
      );
      await expect(provider.createWorkspace("existing-branch", "main")).rejects.toThrow(
        /already exists.*select 'existing-branch' as the base branch/
      );
    });

    it("throws WorkspaceError when branch is already checked out in worktree", async () => {
      const branches: BranchInfo[] = [
        { name: "main", isRemote: false },
        { name: "checked-out-branch", isRemote: false },
      ];
      const worktrees: WorktreeInfo[] = [
        { name: "my-repo", path: PROJECT_ROOT, branch: "main", isMain: true },
        {
          name: "existing-workspace",
          path: "/data/workspaces/existing-workspace",
          branch: "checked-out-branch",
          isMain: false,
        },
      ];
      const mockClient = createMockGitClient({
        listBranches: vi.fn().mockResolvedValue(branches),
        listWorktrees: vi.fn().mockResolvedValue(worktrees),
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
      );

      await expect(
        provider.createWorkspace("checked-out-branch", "checked-out-branch")
      ).rejects.toThrow(WorkspaceError);
      await expect(
        provider.createWorkspace("checked-out-branch", "checked-out-branch")
      ).rejects.toThrow(/already checked out.*\/data\/workspaces\/existing-workspace/);
    });

    it("throws WorkspaceError when branch is checked out in main worktree", async () => {
      const branches: BranchInfo[] = [{ name: "main", isRemote: false }];
      const worktrees: WorktreeInfo[] = [
        { name: "my-repo", path: PROJECT_ROOT, branch: "main", isMain: true },
      ];
      const mockClient = createMockGitClient({
        listBranches: vi.fn().mockResolvedValue(branches),
        listWorktrees: vi.fn().mockResolvedValue(worktrees),
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
      );

      await expect(provider.createWorkspace("main", "main")).rejects.toThrow(WorkspaceError);
      await expect(provider.createWorkspace("main", "main")).rejects.toThrow(
        /already checked out.*\/home\/user\/projects\/my-repo/
      );
    });

    it("does not rollback branch when worktree creation fails for existing branch", async () => {
      const branches: BranchInfo[] = [
        { name: "main", isRemote: false },
        { name: "existing-branch", isRemote: false },
      ];
      const worktrees: WorktreeInfo[] = [
        { name: "my-repo", path: PROJECT_ROOT, branch: "main", isMain: true },
      ];
      const mockClient = createMockGitClient({
        listBranches: vi.fn().mockResolvedValue(branches),
        listWorktrees: vi.fn().mockResolvedValue(worktrees),
        addWorktree: vi.fn().mockRejectedValue(new Error("Worktree creation failed")),
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
      );

      await expect(
        provider.createWorkspace("existing-branch", "existing-branch")
      ).rejects.toThrow();

      // Should NOT delete existing branch
      expect(mockClient.deleteBranch).not.toHaveBeenCalled();
    });

    it("ignores remote branches when checking for existing branch", async () => {
      const branches: BranchInfo[] = [
        { name: "main", isRemote: false },
        { name: "origin/feature-x", isRemote: true }, // Remote branch with same name
      ];
      const worktrees: WorktreeInfo[] = [
        { name: "my-repo", path: PROJECT_ROOT, branch: "main", isMain: true },
      ];
      const mockClient = createMockGitClient({
        listBranches: vi.fn().mockResolvedValue(branches),
        listWorktrees: vi.fn().mockResolvedValue(worktrees),
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
      );

      // Should create new local branch even though remote exists
      const workspace = await provider.createWorkspace("origin/feature-x", "main");

      expect(workspace.name).toBe("origin/feature-x");
      expect(mockClient.createBranch).toHaveBeenCalledWith(
        PROJECT_ROOT,
        "origin/feature-x",
        "main"
      );
    });

    it("calls setBranchConfig with correct args after creating workspace", async () => {
      const mockClient = createMockGitClient({
        listWorktrees: vi
          .fn()
          .mockResolvedValue([
            { name: "my-repo", path: PROJECT_ROOT, branch: "main", isMain: true },
          ]),
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
      );

      await provider.createWorkspace("feature-x", "main");

      expect(mockClient.setBranchConfig).toHaveBeenCalledWith(
        PROJECT_ROOT,
        "feature-x",
        "codehydra.base",
        "main"
      );
    });

    it("logs warning and continues if setBranchConfig fails", async () => {
      const mockClient = createMockGitClient({
        listWorktrees: vi
          .fn()
          .mockResolvedValue([
            { name: "my-repo", path: PROJECT_ROOT, branch: "main", isMain: true },
          ]),
        setBranchConfig: vi.fn().mockRejectedValue(new Error("Config write failed")),
      });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
      );

      // Should NOT throw - workspace is created successfully
      const workspace = await provider.createWorkspace("feature-x", "main");

      expect(workspace.name).toBe("feature-x");
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to save base branch"));
      warnSpy.mockRestore();
    });

    it("returns workspace with metadata.base set", async () => {
      const mockClient = createMockGitClient({
        listWorktrees: vi
          .fn()
          .mockResolvedValue([
            { name: "my-repo", path: PROJECT_ROOT, branch: "main", isMain: true },
          ]),
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
      );

      const workspace = await provider.createWorkspace("feature-x", "main");

      expect(workspace.metadata.base).toBe("main");
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
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
      );

      const result = await provider.removeWorkspace(worktreePath, false);

      expect(result.workspaceRemoved).toBe(true);
      expect(result.baseDeleted).toBe(false);
      expect(mockClient.removeWorktree).toHaveBeenCalledWith(PROJECT_ROOT, worktreePath);
      expect(mockClient.pruneWorktrees).toHaveBeenCalledWith(PROJECT_ROOT);
      expect(mockClient.deleteBranch).not.toHaveBeenCalled();
    });

    it("succeeds when worktree unregistered after error", async () => {
      const worktreePath = "/data/workspaces/feature-x";
      const worktreesBefore: WorktreeInfo[] = [
        { name: "my-repo", path: PROJECT_ROOT, branch: "main", isMain: true },
        { name: "feature-x", path: worktreePath, branch: "feature-x", isMain: false },
      ];
      // After failed removal, worktree is no longer registered (unregistered but directory remains)
      const worktreesAfter: WorktreeInfo[] = [
        { name: "my-repo", path: PROJECT_ROOT, branch: "main", isMain: true },
      ];
      const mockClient = createMockGitClient({
        listWorktrees: vi
          .fn()
          .mockResolvedValueOnce(worktreesBefore) // First call: before removal
          .mockResolvedValueOnce(worktreesAfter), // Second call: after error, check if unregistered
        removeWorktree: vi.fn().mockRejectedValue(new Error("Permission denied: files locked")),
      });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
      );

      // Should NOT throw - directory deletion failed but worktree was unregistered
      const result = await provider.removeWorkspace(worktreePath, false);

      expect(result.workspaceRemoved).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Worktree unregistered but directory remains")
      );
      warnSpy.mockRestore();
    });

    it("throws when still registered after error", async () => {
      const worktreePath = "/data/workspaces/feature-x";
      const worktrees: WorktreeInfo[] = [
        { name: "my-repo", path: PROJECT_ROOT, branch: "main", isMain: true },
        { name: "feature-x", path: worktreePath, branch: "feature-x", isMain: false },
      ];
      const mockClient = createMockGitClient({
        listWorktrees: vi.fn().mockResolvedValue(worktrees), // Still registered
        removeWorktree: vi.fn().mockRejectedValue(new Error("Removal failed")),
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
      );

      // Should throw - worktree still registered after error
      await expect(provider.removeWorkspace(worktreePath, false)).rejects.toThrow("Removal failed");
    });

    it("logs warning on partial success", async () => {
      const worktreePath = "/data/workspaces/feature-x";
      const worktreesBefore: WorktreeInfo[] = [
        { name: "my-repo", path: PROJECT_ROOT, branch: "main", isMain: true },
        { name: "feature-x", path: worktreePath, branch: "feature-x", isMain: false },
      ];
      const worktreesAfter: WorktreeInfo[] = [
        { name: "my-repo", path: PROJECT_ROOT, branch: "main", isMain: true },
      ];
      const mockClient = createMockGitClient({
        listWorktrees: vi
          .fn()
          .mockResolvedValueOnce(worktreesBefore)
          .mockResolvedValueOnce(worktreesAfter),
        removeWorktree: vi.fn().mockRejectedValue(new Error("Permission denied")),
      });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
      );

      await provider.removeWorkspace(worktreePath, false);

      expect(warnSpy).toHaveBeenCalledWith(
        `Worktree unregistered but directory remains: ${worktreePath}. Will be cleaned up on next startup.`
      );
      warnSpy.mockRestore();
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
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
      );

      const result = await provider.removeWorkspace(worktreePath, true);

      expect(result.workspaceRemoved).toBe(true);
      expect(result.baseDeleted).toBe(true);
      expect(mockClient.deleteBranch).toHaveBeenCalledWith(PROJECT_ROOT, "feature-x");
    });

    it("throws WorkspaceError when trying to remove main worktree", async () => {
      const mockClient = createMockGitClient();
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
      );

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
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
      );

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
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
      );

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
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
      );

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
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
      );

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
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
      );

      const dirty = await provider.isDirty("/data/workspaces/feature-x");

      expect(dirty).toBe(true);
    });
  });

  describe("isMainWorkspace", () => {
    it("returns true for project root path", async () => {
      const mockClient = createMockGitClient();
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
      );

      const isMain = provider.isMainWorkspace(PROJECT_ROOT);

      expect(isMain).toBe(true);
    });

    it("returns false for other paths", async () => {
      const mockClient = createMockGitClient();
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
      );

      const isMain = provider.isMainWorkspace("/data/workspaces/feature-x");

      expect(isMain).toBe(false);
    });

    it("handles path normalization", async () => {
      const mockClient = createMockGitClient();
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
      );

      // Path with trailing slash should still match
      const isMain = provider.isMainWorkspace(PROJECT_ROOT + "/");

      expect(isMain).toBe(true);
    });
  });

  describe("path normalization", () => {
    it("normalizeWorktreePath should remove trailing slashes", async () => {
      const worktreePath = "/data/workspaces/feature-x/";
      const worktrees: WorktreeInfo[] = [
        { name: "my-repo", path: PROJECT_ROOT, branch: "main", isMain: true },
        {
          name: "feature-x",
          path: "/data/workspaces/feature-x",
          branch: "feature-x",
          isMain: false,
        },
      ];
      const mockClient = createMockGitClient({
        listWorktrees: vi.fn().mockResolvedValue(worktrees),
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
      );

      // Should match despite trailing slash in input
      const result = await provider.removeWorkspace(worktreePath, false);

      expect(result.workspaceRemoved).toBe(true);
    });

    it("normalizeWorktreePath should handle mixed separators", async () => {
      // Path with ./  components should normalize correctly
      const worktreePath = "/data/workspaces/./feature-x";
      const worktrees: WorktreeInfo[] = [
        { name: "my-repo", path: PROJECT_ROOT, branch: "main", isMain: true },
        {
          name: "feature-x",
          path: "/data/workspaces/feature-x",
          branch: "feature-x",
          isMain: false,
        },
      ];
      const mockClient = createMockGitClient({
        listWorktrees: vi.fn().mockResolvedValue(worktrees),
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
      );

      // Should match despite ./ in path
      const result = await provider.removeWorkspace(worktreePath, false);

      expect(result.workspaceRemoved).toBe(true);
    });

    it("normalizeWorktreePath should normalize paths when comparing", async () => {
      // Worktree returned by git has trailing slash
      const worktreePath = "/data/workspaces/feature-x";
      const worktrees: WorktreeInfo[] = [
        { name: "my-repo", path: PROJECT_ROOT, branch: "main", isMain: true },
        {
          name: "feature-x",
          path: "/data/workspaces/feature-x/",
          branch: "feature-x",
          isMain: false,
        },
      ];
      const mockClient = createMockGitClient({
        listWorktrees: vi.fn().mockResolvedValue(worktrees),
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
      );

      // Should find the branch name even though stored path has trailing slash
      const result = await provider.removeWorkspace(worktreePath, true);

      expect(result.workspaceRemoved).toBe(true);
      // Should have found the branch to delete
      expect(mockClient.deleteBranch).toHaveBeenCalledWith(PROJECT_ROOT, "feature-x");
    });
  });

  describe("defaultBase", () => {
    it("returns 'main' when main branch exists", async () => {
      const branches: BranchInfo[] = [
        { name: "main", isRemote: false },
        { name: "feature", isRemote: false },
      ];
      const mockClient = createMockGitClient({
        listBranches: vi.fn().mockResolvedValue(branches),
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
      );

      const result = await provider.defaultBase();

      expect(result).toBe("main");
    });

    it("returns 'master' when only master exists (no main)", async () => {
      const branches: BranchInfo[] = [
        { name: "master", isRemote: false },
        { name: "feature", isRemote: false },
      ];
      const mockClient = createMockGitClient({
        listBranches: vi.fn().mockResolvedValue(branches),
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
      );

      const result = await provider.defaultBase();

      expect(result).toBe("master");
    });

    it("returns 'main' when both main and master exist", async () => {
      const branches: BranchInfo[] = [
        { name: "master", isRemote: false },
        { name: "main", isRemote: false },
        { name: "feature", isRemote: false },
      ];
      const mockClient = createMockGitClient({
        listBranches: vi.fn().mockResolvedValue(branches),
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
      );

      const result = await provider.defaultBase();

      expect(result).toBe("main");
    });

    it("returns undefined when neither main nor master exists", async () => {
      const branches: BranchInfo[] = [
        { name: "feature", isRemote: false },
        { name: "develop", isRemote: false },
      ];
      const mockClient = createMockGitClient({
        listBranches: vi.fn().mockResolvedValue(branches),
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
      );

      const result = await provider.defaultBase();

      expect(result).toBeUndefined();
    });

    it("returns undefined when listBases() throws (error handling)", async () => {
      const mockClient = createMockGitClient({
        listBranches: vi.fn().mockRejectedValue(new Error("Git error")),
      });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
      );

      const result = await provider.defaultBase();

      expect(result).toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe("cleanupOrphanedWorkspaces", () => {
    it("removes orphaned directories", async () => {
      const worktrees: WorktreeInfo[] = [
        { name: "my-repo", path: PROJECT_ROOT, branch: "main", isMain: true },
        {
          name: "feature-x",
          path: `${WORKSPACES_DIR}/feature-x`,
          branch: "feature-x",
          isMain: false,
        },
      ];
      const mockClient = createMockGitClient({
        listWorktrees: vi.fn().mockResolvedValue(worktrees),
      });
      // Mock fs with registered worktree and an orphan
      const rmFn = vi.fn();
      const mockFsWithOrphan = createMockFileSystemLayer({
        readdir: {
          entries: [
            createDirEntry("feature-x", { isDirectory: true }),
            createDirEntry("orphan-workspace", { isDirectory: true }),
          ],
        },
        rm: { implementation: rmFn },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFsWithOrphan
      );

      const result = await provider.cleanupOrphanedWorkspaces();

      expect(result.removedCount).toBe(1);
      expect(result.failedPaths).toHaveLength(0);
      expect(rmFn).toHaveBeenCalledWith(`${WORKSPACES_DIR}/orphan-workspace`, {
        recursive: true,
        force: true,
      });
    });

    it("skips registered workspaces", async () => {
      const worktrees: WorktreeInfo[] = [
        { name: "my-repo", path: PROJECT_ROOT, branch: "main", isMain: true },
        {
          name: "feature-x",
          path: `${WORKSPACES_DIR}/feature-x`,
          branch: "feature-x",
          isMain: false,
        },
      ];
      const mockClient = createMockGitClient({
        listWorktrees: vi.fn().mockResolvedValue(worktrees),
      });
      const rmFn = vi.fn();
      const mockFsOnlyRegistered = createMockFileSystemLayer({
        readdir: {
          entries: [createDirEntry("feature-x", { isDirectory: true })],
        },
        rm: { implementation: rmFn },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFsOnlyRegistered
      );

      const result = await provider.cleanupOrphanedWorkspaces();

      expect(result.removedCount).toBe(0);
      expect(rmFn).not.toHaveBeenCalled();
    });

    it("skips symlinks", async () => {
      const worktrees: WorktreeInfo[] = [
        { name: "my-repo", path: PROJECT_ROOT, branch: "main", isMain: true },
      ];
      const mockClient = createMockGitClient({
        listWorktrees: vi.fn().mockResolvedValue(worktrees),
      });
      const rmFn = vi.fn();
      const mockFsWithSymlink = createMockFileSystemLayer({
        readdir: {
          entries: [createDirEntry("symlink-entry", { isSymbolicLink: true })],
        },
        rm: { implementation: rmFn },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFsWithSymlink
      );

      const result = await provider.cleanupOrphanedWorkspaces();

      expect(result.removedCount).toBe(0);
      expect(rmFn).not.toHaveBeenCalled();
    });

    it("skips files", async () => {
      const worktrees: WorktreeInfo[] = [
        { name: "my-repo", path: PROJECT_ROOT, branch: "main", isMain: true },
      ];
      const mockClient = createMockGitClient({
        listWorktrees: vi.fn().mockResolvedValue(worktrees),
      });
      const rmFn = vi.fn();
      const mockFsWithFile = createMockFileSystemLayer({
        readdir: {
          entries: [createDirEntry("some-file.txt", { isFile: true })],
        },
        rm: { implementation: rmFn },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFsWithFile
      );

      const result = await provider.cleanupOrphanedWorkspaces();

      expect(result.removedCount).toBe(0);
      expect(rmFn).not.toHaveBeenCalled();
    });

    it("validates paths stay within workspacesDir", async () => {
      const worktrees: WorktreeInfo[] = [
        { name: "my-repo", path: PROJECT_ROOT, branch: "main", isMain: true },
      ];
      const mockClient = createMockGitClient({
        listWorktrees: vi.fn().mockResolvedValue(worktrees),
      });
      const rmFn = vi.fn();
      // Entry name with path traversal attempt
      const mockFsWithTraversal = createMockFileSystemLayer({
        readdir: {
          entries: [createDirEntry("../../../etc", { isDirectory: true })],
        },
        rm: { implementation: rmFn },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFsWithTraversal
      );

      const result = await provider.cleanupOrphanedWorkspaces();

      expect(result.removedCount).toBe(0);
      expect(rmFn).not.toHaveBeenCalled();
    });

    it("re-checks registration before delete (TOCTOU protection)", async () => {
      const worktrees: WorktreeInfo[] = [
        { name: "my-repo", path: PROJECT_ROOT, branch: "main", isMain: true },
      ];
      const worktreesWithNewWorkspace: WorktreeInfo[] = [
        { name: "my-repo", path: PROJECT_ROOT, branch: "main", isMain: true },
        {
          name: "orphan-workspace",
          path: `${WORKSPACES_DIR}/orphan-workspace`,
          branch: "orphan-workspace",
          isMain: false,
        },
      ];
      const mockClient = createMockGitClient({
        listWorktrees: vi
          .fn()
          .mockResolvedValueOnce(worktrees) // First call: initial check
          .mockResolvedValueOnce(worktreesWithNewWorkspace), // Second call: re-check before delete
      });
      const rmFn = vi.fn();
      const mockFsWithOrphan = createMockFileSystemLayer({
        readdir: {
          entries: [createDirEntry("orphan-workspace", { isDirectory: true })],
        },
        rm: { implementation: rmFn },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFsWithOrphan
      );

      const result = await provider.cleanupOrphanedWorkspaces();

      // Should not delete because it's now registered
      expect(result.removedCount).toBe(0);
      expect(rmFn).not.toHaveBeenCalled();
    });

    it("returns CleanupResult with counts", async () => {
      const worktrees: WorktreeInfo[] = [
        { name: "my-repo", path: PROJECT_ROOT, branch: "main", isMain: true },
      ];
      const mockClient = createMockGitClient({
        listWorktrees: vi.fn().mockResolvedValue(worktrees),
      });
      const rmFn = vi.fn();
      const mockFsMultipleOrphans = createMockFileSystemLayer({
        readdir: {
          entries: [
            createDirEntry("orphan-1", { isDirectory: true }),
            createDirEntry("orphan-2", { isDirectory: true }),
          ],
        },
        rm: { implementation: rmFn },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFsMultipleOrphans
      );

      const result = await provider.cleanupOrphanedWorkspaces();

      expect(result.removedCount).toBe(2);
      expect(result.failedPaths).toHaveLength(0);
    });

    it("fails silently on rm error", async () => {
      const worktrees: WorktreeInfo[] = [
        { name: "my-repo", path: PROJECT_ROOT, branch: "main", isMain: true },
      ];
      const mockClient = createMockGitClient({
        listWorktrees: vi.fn().mockResolvedValue(worktrees),
      });
      const mockFsWithRmError = createMockFileSystemLayer({
        readdir: {
          entries: [createDirEntry("orphan-workspace", { isDirectory: true })],
        },
        rm: {
          error: new FileSystemError(
            "EACCES",
            `${WORKSPACES_DIR}/orphan-workspace`,
            "Permission denied"
          ),
        },
      });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFsWithRmError
      );

      // Should NOT throw
      const result = await provider.cleanupOrphanedWorkspaces();

      expect(result.removedCount).toBe(0);
      expect(result.failedPaths).toHaveLength(1);
      expect(result.failedPaths[0]?.path).toBe(`${WORKSPACES_DIR}/orphan-workspace`);
      warnSpy.mockRestore();
    });

    it("fails silently when listWorktrees throws", async () => {
      const mockClient = createMockGitClient({
        listWorktrees: vi.fn().mockRejectedValue(new Error("Git error")),
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
      );

      // Should NOT throw
      const result = await provider.cleanupOrphanedWorkspaces();

      expect(result.removedCount).toBe(0);
      expect(result.failedPaths).toHaveLength(0);
    });

    it("handles missing workspacesDir", async () => {
      const mockClient = createMockGitClient({
        listWorktrees: vi
          .fn()
          .mockResolvedValue([
            { name: "my-repo", path: PROJECT_ROOT, branch: "main", isMain: true },
          ]),
      });
      const mockFsNotFound = createMockFileSystemLayer({
        readdir: { error: new FileSystemError("ENOENT", WORKSPACES_DIR, "Not found") },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFsNotFound
      );

      const result = await provider.cleanupOrphanedWorkspaces();

      expect(result.removedCount).toBe(0);
      expect(result.failedPaths).toHaveLength(0);
    });

    it("handles empty workspacesDir", async () => {
      const mockClient = createMockGitClient({
        listWorktrees: vi
          .fn()
          .mockResolvedValue([
            { name: "my-repo", path: PROJECT_ROOT, branch: "main", isMain: true },
          ]),
      });
      const mockFsEmpty = createMockFileSystemLayer({
        readdir: { entries: [] },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFsEmpty
      );

      const result = await provider.cleanupOrphanedWorkspaces();

      expect(result.removedCount).toBe(0);
      expect(result.failedPaths).toHaveLength(0);
    });

    it("normalizes paths when comparing", async () => {
      // Worktree path has trailing slash
      const worktrees: WorktreeInfo[] = [
        { name: "my-repo", path: PROJECT_ROOT, branch: "main", isMain: true },
        {
          name: "feature-x",
          path: `${WORKSPACES_DIR}/feature-x/`,
          branch: "feature-x",
          isMain: false,
        },
      ];
      const mockClient = createMockGitClient({
        listWorktrees: vi.fn().mockResolvedValue(worktrees),
      });
      const rmFn = vi.fn();
      const mockFsNormalized = createMockFileSystemLayer({
        readdir: {
          entries: [createDirEntry("feature-x", { isDirectory: true })],
        },
        rm: { implementation: rmFn },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFsNormalized
      );

      const result = await provider.cleanupOrphanedWorkspaces();

      // Should NOT delete because it matches registered worktree
      expect(result.removedCount).toBe(0);
      expect(rmFn).not.toHaveBeenCalled();
    });

    it("returns early if already in progress", async () => {
      const worktrees: WorktreeInfo[] = [
        { name: "my-repo", path: PROJECT_ROOT, branch: "main", isMain: true },
      ];
      // Use a slow listWorktrees to simulate long-running operation
      // First call is fast (for factory), subsequent calls are slow
      let callCount = 0;
      let slowResolve: ((value: WorktreeInfo[]) => void) | null = null;
      const mockClient = createMockGitClient({
        listWorktrees: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            // First call during cleanupOrphanedWorkspaces
            return new Promise<WorktreeInfo[]>((resolve) => {
              slowResolve = resolve;
            });
          }
          // Subsequent calls resolve immediately
          return Promise.resolve(worktrees);
        }),
      });
      const mockFsWithOrphan = createMockFileSystemLayer({
        readdir: {
          entries: [createDirEntry("orphan", { isDirectory: true })],
        },
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFsWithOrphan
      );

      // Start first cleanup (will hang on listWorktrees)
      const firstCleanup = provider.cleanupOrphanedWorkspaces();

      // Give a moment for the first cleanup to start
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Start second cleanup while first is in progress
      const secondCleanup = provider.cleanupOrphanedWorkspaces();
      const secondResult = await secondCleanup;

      // Second cleanup should return immediately with empty result
      expect(secondResult.removedCount).toBe(0);
      expect(secondResult.failedPaths).toHaveLength(0);

      // Now resolve the first cleanup
      slowResolve!(worktrees);
      await firstCleanup;
    });
  });

  describe("discover - metadata property", () => {
    it("returns metadata with base from config", async () => {
      const worktrees: WorktreeInfo[] = [
        { name: "my-repo", path: PROJECT_ROOT, branch: "main", isMain: true },
        {
          name: "feature-x",
          path: "/data/workspaces/feature-x",
          branch: "feature-x",
          isMain: false,
        },
      ];
      const mockClient = createMockGitClient({
        listWorktrees: vi.fn().mockResolvedValue(worktrees),
        getBranchConfigsByPrefix: vi.fn().mockResolvedValue({ base: "develop" }),
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
      );

      const workspaces = await provider.discover();

      expect(workspaces).toHaveLength(1);
      expect(workspaces[0].metadata.base).toBe("develop");
    });

    it("returns metadata with base fallback to branch when no config", async () => {
      const worktrees: WorktreeInfo[] = [
        { name: "my-repo", path: PROJECT_ROOT, branch: "main", isMain: true },
        {
          name: "feature-x",
          path: "/data/workspaces/feature-x",
          branch: "feature-x",
          isMain: false,
        },
      ];
      const mockClient = createMockGitClient({
        listWorktrees: vi.fn().mockResolvedValue(worktrees),
        getBranchConfigsByPrefix: vi.fn().mockResolvedValue({}), // No base config
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
      );

      const workspaces = await provider.discover();

      expect(workspaces).toHaveLength(1);
      expect(workspaces[0].metadata.base).toBe("feature-x"); // Falls back to branch
    });

    it("returns metadata with base fallback to name when no branch (detached HEAD)", async () => {
      const worktrees: WorktreeInfo[] = [
        { name: "my-repo", path: PROJECT_ROOT, branch: "main", isMain: true },
        {
          name: "detached-workspace",
          path: "/data/workspaces/detached-workspace",
          branch: null,
          isMain: false,
        },
      ];
      const mockClient = createMockGitClient({
        listWorktrees: vi.fn().mockResolvedValue(worktrees),
        getBranchConfigsByPrefix: vi.fn().mockResolvedValue({}),
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
      );

      const workspaces = await provider.discover();

      expect(workspaces).toHaveLength(1);
      expect(workspaces[0].metadata.base).toBe("detached-workspace"); // Falls back to name
    });

    it("returns full metadata from config (multiple keys)", async () => {
      const worktrees: WorktreeInfo[] = [
        { name: "my-repo", path: PROJECT_ROOT, branch: "main", isMain: true },
        {
          name: "feature-x",
          path: "/data/workspaces/feature-x",
          branch: "feature-x",
          isMain: false,
        },
      ];
      const mockClient = createMockGitClient({
        listWorktrees: vi.fn().mockResolvedValue(worktrees),
        getBranchConfigsByPrefix: vi.fn().mockResolvedValue({
          base: "main",
          note: "WIP auth feature",
          model: "claude-4",
        }),
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
      );

      const workspaces = await provider.discover();

      expect(workspaces).toHaveLength(1);
      expect(workspaces[0].metadata).toEqual({
        base: "main",
        note: "WIP auth feature",
        model: "claude-4",
      });
    });
  });

  describe("createWorkspace - metadata property", () => {
    it("returns workspace with metadata.base set", async () => {
      const mockClient = createMockGitClient({
        listWorktrees: vi
          .fn()
          .mockResolvedValue([
            { name: "my-repo", path: PROJECT_ROOT, branch: "main", isMain: true },
          ]),
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
      );

      const workspace = await provider.createWorkspace("feature-x", "main");

      expect(workspace.metadata).toEqual({ base: "main" });
    });
  });

  describe("setMetadata", () => {
    it("validates key format (rejects invalid)", async () => {
      const worktreePath = "/data/workspaces/feature-x";
      const worktrees: WorktreeInfo[] = [
        { name: "my-repo", path: PROJECT_ROOT, branch: "main", isMain: true },
        {
          name: "feature-x",
          path: worktreePath,
          branch: "feature-x",
          isMain: false,
        },
      ];
      const mockClient = createMockGitClient({
        listWorktrees: vi.fn().mockResolvedValue(worktrees),
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
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

    it("calls setBranchConfig correctly", async () => {
      const worktreePath = "/data/workspaces/feature-x";
      const worktrees: WorktreeInfo[] = [
        { name: "my-repo", path: PROJECT_ROOT, branch: "main", isMain: true },
        {
          name: "feature-x",
          path: worktreePath,
          branch: "feature-x",
          isMain: false,
        },
      ];
      const mockClient = createMockGitClient({
        listWorktrees: vi.fn().mockResolvedValue(worktrees),
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
      );

      await provider.setMetadata(worktreePath, "note", "WIP feature");

      expect(mockClient.setBranchConfig).toHaveBeenCalledWith(
        PROJECT_ROOT,
        "feature-x",
        "codehydra.note",
        "WIP feature"
      );
    });

    it("calls unsetBranchConfig when value is null", async () => {
      const worktreePath = "/data/workspaces/feature-x";
      const worktrees: WorktreeInfo[] = [
        { name: "my-repo", path: PROJECT_ROOT, branch: "main", isMain: true },
        {
          name: "feature-x",
          path: worktreePath,
          branch: "feature-x",
          isMain: false,
        },
      ];
      const mockClient = createMockGitClient({
        listWorktrees: vi.fn().mockResolvedValue(worktrees),
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
      );

      await provider.setMetadata(worktreePath, "note", null);

      expect(mockClient.unsetBranchConfig).toHaveBeenCalledWith(
        PROJECT_ROOT,
        "feature-x",
        "codehydra.note"
      );
    });
  });

  describe("keepFilesService integration", () => {
    it("calls copyToWorkspace after worktree created when service provided", async () => {
      const mockClient = createMockGitClient({
        listWorktrees: vi
          .fn()
          .mockResolvedValue([
            { name: "my-repo", path: PROJECT_ROOT, branch: "main", isMain: true },
          ]),
      });
      const mockKeepFilesService = {
        copyToWorkspace: vi.fn().mockResolvedValue({
          configExists: true,
          copiedCount: 3,
          skippedCount: 0,
          errors: [],
        }),
      };
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        { keepFilesService: mockKeepFilesService }
      );

      await provider.createWorkspace("feature-x", "main");

      expect(mockKeepFilesService.copyToWorkspace).toHaveBeenCalledWith(
        PROJECT_ROOT,
        expect.stringContaining("feature-x")
      );
    });

    it("works without keepFilesService (backward compatible)", async () => {
      const mockClient = createMockGitClient({
        listWorktrees: vi
          .fn()
          .mockResolvedValue([
            { name: "my-repo", path: PROJECT_ROOT, branch: "main", isMain: true },
          ]),
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
        // No options - should work without keepFilesService
      );

      // Should not throw
      const workspace = await provider.createWorkspace("feature-x", "main");
      expect(workspace.name).toBe("feature-x");
    });

    it("works with options but no keepFilesService", async () => {
      const mockClient = createMockGitClient({
        listWorktrees: vi
          .fn()
          .mockResolvedValue([
            { name: "my-repo", path: PROJECT_ROOT, branch: "main", isMain: true },
          ]),
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        {} // Options without keepFilesService
      );

      // Should not throw
      const workspace = await provider.createWorkspace("feature-x", "main");
      expect(workspace.name).toBe("feature-x");
    });

    it("logs copy errors but does not throw", async () => {
      const mockClient = createMockGitClient({
        listWorktrees: vi
          .fn()
          .mockResolvedValue([
            { name: "my-repo", path: PROJECT_ROOT, branch: "main", isMain: true },
          ]),
      });
      const mockKeepFilesService = {
        copyToWorkspace: vi.fn().mockResolvedValue({
          configExists: true,
          copiedCount: 2,
          skippedCount: 0,
          errors: [{ path: ".env", message: "Permission denied" }],
        }),
      };
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        { keepFilesService: mockKeepFilesService }
      );

      // Should not throw despite copy errors
      const workspace = await provider.createWorkspace("feature-x", "main");

      expect(workspace.name).toBe("feature-x");
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it("logs success at info level", async () => {
      const mockClient = createMockGitClient({
        listWorktrees: vi
          .fn()
          .mockResolvedValue([
            { name: "my-repo", path: PROJECT_ROOT, branch: "main", isMain: true },
          ]),
      });
      const mockKeepFilesService = {
        copyToWorkspace: vi.fn().mockResolvedValue({
          configExists: true,
          copiedCount: 5,
          skippedCount: 1,
          errors: [],
        }),
      };
      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        { keepFilesService: mockKeepFilesService }
      );

      await provider.createWorkspace("feature-x", "main");

      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining("5"));
      infoSpy.mockRestore();
    });
  });

  describe("getMetadata", () => {
    it("applies base fallback when not in config", async () => {
      const worktreePath = "/data/workspaces/feature-x";
      const worktrees: WorktreeInfo[] = [
        { name: "my-repo", path: PROJECT_ROOT, branch: "main", isMain: true },
        {
          name: "feature-x",
          path: worktreePath,
          branch: "feature-x",
          isMain: false,
        },
      ];
      const mockClient = createMockGitClient({
        listWorktrees: vi.fn().mockResolvedValue(worktrees),
        getBranchConfigsByPrefix: vi.fn().mockResolvedValue({ note: "test note" }), // No base
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
      );

      const metadata = await provider.getMetadata(worktreePath);

      expect(metadata.base).toBe("feature-x"); // Fallback to branch
      expect(metadata.note).toBe("test note");
    });

    it("returns all metadata keys", async () => {
      const worktreePath = "/data/workspaces/feature-x";
      const worktrees: WorktreeInfo[] = [
        { name: "my-repo", path: PROJECT_ROOT, branch: "main", isMain: true },
        {
          name: "feature-x",
          path: worktreePath,
          branch: "feature-x",
          isMain: false,
        },
      ];
      const mockClient = createMockGitClient({
        listWorktrees: vi.fn().mockResolvedValue(worktrees),
        getBranchConfigsByPrefix: vi.fn().mockResolvedValue({
          base: "develop",
          note: "WIP",
          model: "claude-4",
        }),
      });
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs
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
