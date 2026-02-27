// @vitest-environment node
/**
 * Integration tests for GitWorktreeProvider using behavioral mock.
 * Tests end-to-end workflows without real git repositories.
 */

import { describe, it, expect } from "vitest";
import { GitWorktreeProvider } from "./git-worktree-provider";
import { createMockGitClient } from "./git-client.state-mock";
import {
  createFileSystemMock,
  createSpyFileSystemLayer,
  directory,
  symlink,
  file,
} from "../platform/filesystem.state-mock";
import { SILENT_LOGGER } from "../logging";
import { WorkspaceError } from "../errors";
import { Path } from "../platform/path";

describe("GitWorktreeProvider integration", () => {
  const PROJECT_ROOT = new Path("/project");
  const WORKSPACES_DIR = new Path("/workspaces");
  const mockFs = createFileSystemMock({
    entries: {
      [WORKSPACES_DIR.toString()]: directory(),
    },
  });
  const worktreeLogger = SILENT_LOGGER;

  describe("metadata.base persistence", () => {
    it("creates workspace with metadata.base and retrieves via discover()", async () => {
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
        worktreeLogger
      );

      // Create workspace with base branch "main"
      const created = await provider.createWorkspace(PROJECT_ROOT, "feature-x", "main");
      expect(created.metadata.base).toBe("main");

      // Discover should return same metadata.base
      const discovered = await provider.discover(PROJECT_ROOT);
      expect(discovered).toHaveLength(1);
      expect(discovered[0]?.metadata.base).toBe("main");
    });

    it("metadata.base survives provider instance recreation", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main"],
            currentBranch: "main",
          },
        },
      });

      // Create with first provider instance
      const provider1 = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        worktreeLogger
      );
      await provider1.createWorkspace(PROJECT_ROOT, "feature-x", "main");

      // Create new provider instance and verify metadata.base persists
      // (using same mockClient which retains state)
      const provider2 = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        worktreeLogger
      );
      const discovered = await provider2.discover(PROJECT_ROOT);

      expect(discovered).toHaveLength(1);
      expect(discovered[0]?.metadata.base).toBe("main");
    });

    it("legacy workspace (no config) returns branch name as metadata.base", async () => {
      // Create a mock with worktree but no config set (simulates legacy workspace)
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main", "legacy-branch"],
            currentBranch: "main",
            worktrees: [
              { name: "legacy-branch", path: "/workspaces/legacy-branch", branch: "legacy-branch" },
            ],
            // No branchConfigs - simulates legacy workspace
          },
        },
      });

      // Discover should fall back to branch name
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        worktreeLogger
      );
      const discovered = await provider.discover(PROJECT_ROOT);

      expect(discovered).toHaveLength(1);
      expect(discovered[0]?.metadata.base).toBe("legacy-branch");
    });

    it("handles mixed state workspaces", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main", "feature-with-config", "legacy-branch"],
            currentBranch: "main",
            worktrees: [
              // Workspace with config
              {
                name: "feature-with-config",
                path: "/workspaces/feature-with-config",
                branch: "feature-with-config",
              },
              // Legacy workspace (no config)
              {
                name: "legacy-branch",
                path: "/workspaces/legacy-branch",
                branch: "legacy-branch",
              },
            ],
            branchConfigs: {
              "feature-with-config": { "codehydra.base": "main" },
              // No config for legacy-branch
            },
          },
        },
      });

      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        worktreeLogger
      );

      // Discover should handle both correctly
      const discovered = await provider.discover(PROJECT_ROOT);
      expect(discovered).toHaveLength(2);

      const featureWorkspace = discovered.find((w) => w.name === "feature-with-config");
      const legacyWorkspace = discovered.find((w) => w.name === "legacy-branch");

      expect(featureWorkspace?.metadata.base).toBe("main");
      expect(legacyWorkspace?.metadata.base).toBe("legacy-branch");
    });

    it("stores metadata.base in branch config", async () => {
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
        worktreeLogger
      );
      await provider.createWorkspace(PROJECT_ROOT, "feature-x", "main");

      // Verify config was set using behavioral assertion
      expect(mockClient).toHaveBranchConfig(PROJECT_ROOT, "feature-x", "codehydra.base", "main");
    });
  });

  describe("discover name resolution", () => {
    it("returns branch name (not sanitized basename) for workspaces with /", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main", "feature/login"],
            currentBranch: "main",
            worktrees: [
              {
                name: "feature%login",
                path: "/workspaces/feature%login",
                branch: "feature/login",
              },
            ],
            branchConfigs: {
              "feature/login": { "codehydra.base": "main" },
            },
          },
        },
      });

      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        worktreeLogger
      );

      const discovered = await provider.discover(PROJECT_ROOT);
      expect(discovered).toHaveLength(1);
      expect(discovered[0]?.name).toBe("feature/login");
      expect(discovered[0]?.branch).toBe("feature/login");
    });

    it("falls back to filesystem name for detached HEAD workspaces", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main"],
            currentBranch: "main",
            worktrees: [
              {
                name: "detached-ws",
                path: "/workspaces/detached-ws",
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
        worktreeLogger
      );

      const discovered = await provider.discover(PROJECT_ROOT);
      expect(discovered).toHaveLength(1);
      expect(discovered[0]?.name).toBe("detached-ws");
      expect(discovered[0]?.branch).toBeNull();
    });
  });

  describe("metadata setMetadata/getMetadata", () => {
    it("setMetadata persists and getMetadata retrieves", async () => {
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
        worktreeLogger
      );
      const workspace = await provider.createWorkspace(PROJECT_ROOT, "feature-x", "main");

      await provider.setMetadata(workspace.path, "note", "WIP feature");

      const metadata = await provider.getMetadata(workspace.path);
      expect(metadata.note).toBe("WIP feature");
      expect(metadata.base).toBe("main");
    });

    it("metadata survives provider recreation", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main"],
            currentBranch: "main",
          },
        },
      });
      const provider1 = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        worktreeLogger
      );
      const workspace = await provider1.createWorkspace(PROJECT_ROOT, "feature-x", "main");
      await provider1.setMetadata(workspace.path, "note", "test note");

      const provider2 = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        worktreeLogger
      );
      // Must discover to populate workspace registry before getMetadata
      await provider2.discover(PROJECT_ROOT);
      const metadata = await provider2.getMetadata(workspace.path);

      expect(metadata.note).toBe("test note");
      expect(metadata.base).toBe("main");
    });

    it("base fallback applies in getMetadata for legacy workspace", async () => {
      // Create legacy workspace manually (no config set)
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main", "legacy-branch"],
            currentBranch: "main",
            worktrees: [
              { name: "legacy-branch", path: "/workspaces/legacy-branch", branch: "legacy-branch" },
            ],
            // No config - simulates legacy
          },
        },
      });

      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        worktreeLogger
      );
      // Must discover to populate workspace registry before getMetadata
      await provider.discover(PROJECT_ROOT);
      const metadata = await provider.getMetadata(new Path("/workspaces/legacy-branch"));

      // Should fall back to branch name
      expect(metadata.base).toBe("legacy-branch");
    });

    it("invalid key format throws WorkspaceError with INVALID_METADATA_KEY code", async () => {
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
        worktreeLogger
      );
      const workspace = await provider.createWorkspace(PROJECT_ROOT, "feature-x", "main");

      try {
        await provider.setMetadata(workspace.path, "my_key", "value");
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(WorkspaceError);
        expect((error as InstanceType<typeof WorkspaceError>).code).toBe("INVALID_METADATA_KEY");
      }
    });

    it("setMetadata with null deletes the key", async () => {
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
        worktreeLogger
      );
      const workspace = await provider.createWorkspace(PROJECT_ROOT, "feature-x", "main");

      await provider.setMetadata(workspace.path, "note", "test note");
      let metadata = await provider.getMetadata(workspace.path);
      expect(metadata.note).toBe("test note");

      await provider.setMetadata(workspace.path, "note", null);
      metadata = await provider.getMetadata(workspace.path);
      expect(metadata.note).toBeUndefined();
    });
  });
});

describe("GitWorktreeProvider", () => {
  const PROJECT_ROOT = new Path("/home/user/projects/my-repo");
  const WORKSPACES_DIR = new Path("/home/user/app-data/projects/my-repo-abc12345/workspaces");
  const mockFs = createFileSystemMock();
  const worktreeLogger = SILENT_LOGGER;

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
        worktreeLogger
      );

      expect(provider).toBeInstanceOf(GitWorktreeProvider);
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
        GitWorktreeProvider.create(PROJECT_ROOT, mockClient, WORKSPACES_DIR, mockFs, worktreeLogger)
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
        worktreeLogger
      );

      const workspaces = await provider.discover(PROJECT_ROOT);

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
        worktreeLogger
      );

      const workspaces = await provider.discover(PROJECT_ROOT);

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
        worktreeLogger
      );

      const workspaces = await provider.discover(PROJECT_ROOT);

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
        worktreeLogger
      );

      const workspaces = await provider.discover(PROJECT_ROOT);

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
        worktreeLogger
      );

      // Should not throw and should handle gracefully
      const workspaces = await provider.discover(PROJECT_ROOT);

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
        worktreeLogger
      );

      const workspaces = await provider.discover(PROJECT_ROOT);

      expect(workspaces).toHaveLength(1);
      expect(workspaces[0]!.metadata.base).toBe("develop");
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
        worktreeLogger
      );

      const workspaces = await provider.discover(PROJECT_ROOT);

      expect(workspaces).toHaveLength(3);

      // name is derived from branch (or filesystem name for detached HEAD)
      const workspaceA = workspaces.find((w) => w.name === "branch-a");
      const workspaceB = workspaces.find((w) => w.name === "branch-b");
      const workspaceC = workspaces.find((w) => w.name === "workspace-c");

      expect(workspaceA?.metadata.base).toBe("configured-base"); // Uses config
      expect(workspaceB?.metadata.base).toBe("branch-b"); // Uses branch
      expect(workspaceC?.metadata.base).toBe("workspace-c"); // Uses name
    });
  });

  describe("discover - metadata", () => {
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
        worktreeLogger
      );

      const workspaces = await provider.discover(PROJECT_ROOT);

      expect(workspaces).toHaveLength(1);
      expect(workspaces[0]!.metadata).toEqual({
        base: "main",
        note: "WIP auth feature",
        model: "claude-4",
      });
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
        worktreeLogger
      );

      const bases = await provider.listBases(PROJECT_ROOT);

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
        worktreeLogger
      );

      const bases = await provider.listBases(PROJECT_ROOT);

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
        worktreeLogger
      );

      const bases = await provider.listBases(PROJECT_ROOT);

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
        worktreeLogger
      );

      const bases = await provider.listBases(PROJECT_ROOT);

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
        worktreeLogger
      );

      const bases = await provider.listBases(PROJECT_ROOT);

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
        worktreeLogger
      );

      const bases = await provider.listBases(PROJECT_ROOT);

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
        worktreeLogger
      );

      const bases = await provider.listBases(PROJECT_ROOT);

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
        worktreeLogger
      );

      const bases = await provider.listBases(PROJECT_ROOT);

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
        worktreeLogger
      );

      const bases = await provider.listBases(PROJECT_ROOT);

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
        worktreeLogger
      );

      const bases = await provider.listBases(PROJECT_ROOT);

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
        worktreeLogger
      );

      const bases = await provider.listBases(PROJECT_ROOT);

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
        worktreeLogger
      );

      const result = await provider.updateBases(PROJECT_ROOT);

      expect(result.fetchedRemotes).toContain("origin");
      expect(result.failedRemotes).toHaveLength(0);
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
        worktreeLogger
      );

      const result = await provider.updateBases(PROJECT_ROOT);

      expect(result.fetchedRemotes).toHaveLength(0);
      expect(result.failedRemotes).toHaveLength(0);
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
        worktreeLogger
      );

      const workspace = await provider.createWorkspace(PROJECT_ROOT, "feature-x", "main");

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
        worktreeLogger
      );

      const workspace = await provider.createWorkspace(PROJECT_ROOT, "user/feature", "main");

      // The directory name should have sanitized slashes
      expect(workspace.name).toBe("user/feature");
      // Behavioral assertion: branch should be created
      expect(mockClient).toHaveBranch(PROJECT_ROOT, "user/feature");
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
        worktreeLogger
      );

      const workspace = await provider.createWorkspace(
        PROJECT_ROOT,
        "existing-branch",
        "existing-branch"
      );

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
        worktreeLogger
      );

      // Should succeed even though baseBranch differs from branch name
      const workspace = await provider.createWorkspace(PROJECT_ROOT, "existing-branch", "main");

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
        worktreeLogger
      );

      await expect(
        provider.createWorkspace(PROJECT_ROOT, "checked-out-branch", "checked-out-branch")
      ).rejects.toThrow(WorkspaceError);
      await expect(
        provider.createWorkspace(PROJECT_ROOT, "checked-out-branch", "checked-out-branch")
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
        worktreeLogger
      );

      await expect(provider.createWorkspace(PROJECT_ROOT, "main", "main")).rejects.toThrow(
        WorkspaceError
      );
      await expect(provider.createWorkspace(PROJECT_ROOT, "main", "main")).rejects.toThrow(
        /already checked out.*\/home\/user\/projects\/my-repo/
      );
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
        worktreeLogger
      );

      // Should create new local branch even though remote exists
      const workspace = await provider.createWorkspace(PROJECT_ROOT, "origin/feature-x", "main");

      expect(workspace.name).toBe("origin/feature-x");
      expect(mockClient).toHaveBranch(PROJECT_ROOT, "origin/feature-x");
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
        worktreeLogger
      );

      const workspace = await provider.createWorkspace(PROJECT_ROOT, "feature-x", "main");

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
        worktreeLogger
      );

      const result = await provider.removeWorkspace(PROJECT_ROOT, worktreePath, false);

      expect(result.workspaceRemoved).toBe(true);
      expect(result.baseDeleted).toBe(false);
      expect(mockClient).not.toHaveWorktree(PROJECT_ROOT, worktreePath);
      // Branch should still exist
      expect(mockClient).toHaveBranch(PROJECT_ROOT, "feature-x");
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
        worktreeLogger
      );

      const result = await provider.removeWorkspace(PROJECT_ROOT, worktreePath, true);

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
        worktreeLogger
      );

      await expect(provider.removeWorkspace(PROJECT_ROOT, PROJECT_ROOT, false)).rejects.toThrow(
        WorkspaceError
      );
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
        worktreeLogger
      );

      const result = await provider.removeWorkspace(PROJECT_ROOT, worktreePath, true);

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
        worktreeLogger
      );

      // Should NOT throw - returns success (worktree already gone)
      const result = await provider.removeWorkspace(PROJECT_ROOT, worktreePath, false);

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
        worktreeLogger
      );

      const result = await provider.removeWorkspace(PROJECT_ROOT, worktreePath, true);

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
        worktreeLogger
      );

      // First call - actually removes
      const result1 = await provider.removeWorkspace(PROJECT_ROOT, worktreePath, true);
      expect(result1.workspaceRemoved).toBe(true);
      expect(result1.baseDeleted).toBe(true);

      // Second call - idempotent, returns success without operations
      const result2 = await provider.removeWorkspace(PROJECT_ROOT, worktreePath, true);
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
        worktreeLogger
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
        worktreeLogger
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
        worktreeLogger
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
        worktreeLogger
      );

      const isMain = provider.isMainWorkspace(PROJECT_ROOT, PROJECT_ROOT);

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
        worktreeLogger
      );

      const isMain = provider.isMainWorkspace(PROJECT_ROOT, new Path("/data/workspaces/feature-x"));

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
        worktreeLogger
      );

      // Path with trailing slash normalizes to same value - Path handles this automatically
      const pathWithTrailingSlash = new Path(PROJECT_ROOT.toString() + "/");
      const isMain = provider.isMainWorkspace(PROJECT_ROOT, pathWithTrailingSlash);

      expect(isMain).toBe(true);
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
        worktreeLogger
      );

      const result = await provider.defaultBase(PROJECT_ROOT);

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
        worktreeLogger
      );

      const result = await provider.defaultBase(PROJECT_ROOT);

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
        worktreeLogger
      );

      const result = await provider.defaultBase(PROJECT_ROOT);

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
        worktreeLogger
      );

      const result = await provider.defaultBase(PROJECT_ROOT);

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
        worktreeLogger
      );

      const result = await provider.defaultBase(PROJECT_ROOT);

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
        worktreeLogger
      );

      const result = await provider.defaultBase(PROJECT_ROOT);

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
        worktreeLogger
      );

      const result = await provider.cleanupOrphanedWorkspaces(PROJECT_ROOT);

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
        worktreeLogger
      );

      const result = await provider.cleanupOrphanedWorkspaces(PROJECT_ROOT);

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
        worktreeLogger
      );

      const result = await provider.cleanupOrphanedWorkspaces(PROJECT_ROOT);

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
        worktreeLogger
      );

      const result = await provider.cleanupOrphanedWorkspaces(PROJECT_ROOT);

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
        worktreeLogger
      );

      const result = await provider.cleanupOrphanedWorkspaces(PROJECT_ROOT);

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
        worktreeLogger
      );

      const result = await provider.cleanupOrphanedWorkspaces(PROJECT_ROOT);

      expect(result.removedCount).toBe(2);
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
        worktreeLogger
      );

      const result = await provider.cleanupOrphanedWorkspaces(PROJECT_ROOT);

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
        worktreeLogger
      );

      const result = await provider.cleanupOrphanedWorkspaces(PROJECT_ROOT);

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
        worktreeLogger
      );

      const result = await provider.cleanupOrphanedWorkspaces(PROJECT_ROOT);

      // Should NOT delete because it matches registered worktree
      expect(result.removedCount).toBe(0);
      expect(spyFs.rm).not.toHaveBeenCalled();
    });
  });

  describe("setMetadata", () => {
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
        worktreeLogger
      );
      await provider.discover(PROJECT_ROOT);

      await provider.setMetadata(worktreePath, "note", "WIP feature");

      // Behavioral assertion: config should be set
      expect(mockClient).toHaveBranchConfig(
        PROJECT_ROOT,
        "feature-x",
        "codehydra.note",
        "WIP feature"
      );
    });
  });

  describe("getMetadata", () => {
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
        worktreeLogger
      );
      await provider.discover(PROJECT_ROOT);

      const metadata = await provider.getMetadata(worktreePath);

      expect(metadata).toEqual({
        base: "develop",
        note: "WIP",
        model: "claude-4",
      });
    });
  });
});

describe("GitWorktreeProvider bare repository support", () => {
  const PROJECT_ROOT = new Path("/bare-project");
  const WORKSPACES_DIR = new Path("/workspaces");
  const worktreeLogger = SILENT_LOGGER;

  describe("listBases", () => {
    it("returns branches from bare repos as local (git treats them as refs/heads/*)", async () => {
      // In bare repos, branches are stored in refs/heads/* (not refs/remotes/*)
      // so they appear as local branches to git. This is correct git behavior.
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main", "develop", "feature-x"],
            isBare: true,
            currentBranch: "main",
          },
        },
      });
      const mockFs = createFileSystemMock({
        entries: {
          [WORKSPACES_DIR.toString()]: directory(),
        },
      });

      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        worktreeLogger
      );

      const bases = await provider.listBases(PROJECT_ROOT);

      // Branches in bare repos are local refs, so isRemote should be false
      expect(bases.every((b) => !b.isRemote)).toBe(true);
      expect(bases.map((b) => b.name).sort()).toEqual(["develop", "feature-x", "main"]);
    });

    it("returns local and remote branches correctly for regular repos", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main", "develop"],
            remoteBranches: ["origin/main"],
            isBare: false,
            currentBranch: "main",
          },
        },
      });
      const mockFs = createFileSystemMock({
        entries: {
          [WORKSPACES_DIR.toString()]: directory(),
        },
      });

      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        worktreeLogger
      );

      const bases = await provider.listBases(PROJECT_ROOT);

      const localBranches = bases.filter((b) => !b.isRemote);
      const remoteBranches = bases.filter((b) => b.isRemote);

      expect(localBranches.map((b) => b.name).sort()).toEqual(["develop", "main"]);
      expect(remoteBranches.map((b) => b.name)).toEqual(["origin/main"]);
    });
  });
});
