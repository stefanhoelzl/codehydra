// @vitest-environment node
/**
 * Integration tests for GitWorktreeProvider using behavioral mock.
 * Tests end-to-end workflows without real git repositories.
 */

import { describe, it, expect } from "vitest";
import { GitWorktreeProvider } from "./git-worktree-provider";
import { createMockGitClient } from "./git-client.state-mock";
import { createFileSystemMock, directory } from "../platform/filesystem.state-mock";
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
