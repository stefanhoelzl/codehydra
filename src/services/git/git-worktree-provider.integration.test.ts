// @vitest-environment node
/**
 * Integration tests for GitWorktreeProvider using behavioral mock.
 * Tests end-to-end workflows without real git repositories.
 */

import { describe, it, expect, vi } from "vitest";
import { GitWorktreeProvider } from "./git-worktree-provider";
import { createMockGitClient } from "./git-client.state-mock";
import { createFileSystemMock, directory } from "../platform/filesystem.state-mock";
import { SILENT_LOGGER } from "../logging";
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
      const created = await provider.createWorkspace("feature-x", "main");
      expect(created.metadata.base).toBe("main");

      // Discover should return same metadata.base
      const discovered = await provider.discover();
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
      await provider1.createWorkspace("feature-x", "main");

      // Create new provider instance and verify metadata.base persists
      // (using same mockClient which retains state)
      const provider2 = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        worktreeLogger
      );
      const discovered = await provider2.discover();

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
      const discovered = await provider.discover();

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
      const discovered = await provider.discover();
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
      await provider.createWorkspace("feature-x", "main");

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
      const workspace = await provider.createWorkspace("feature-x", "main");

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
      const workspace = await provider1.createWorkspace("feature-x", "main");
      await provider1.setMetadata(workspace.path, "note", "test note");

      const provider2 = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        worktreeLogger
      );
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
      const workspace = await provider.createWorkspace("feature-x", "main");

      await provider.setMetadata(workspace.path, "note", "test note");
      let metadata = await provider.getMetadata(workspace.path);
      expect(metadata.note).toBe("test note");

      await provider.setMetadata(workspace.path, "note", null);
      metadata = await provider.getMetadata(workspace.path);
      expect(metadata.note).toBeUndefined();
    });
  });
});

describe("GitWorktreeProvider with KeepFilesService (integration)", () => {
  const PROJECT_ROOT = new Path("/project");
  const WORKSPACES_DIR = new Path("/workspaces");
  const worktreeLogger = SILENT_LOGGER;

  describe("full flow", () => {
    it(".keepfiles patterns are applied to worktree (via copyToWorkspace call)", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main"],
            currentBranch: "main",
          },
        },
      });
      const mockFs = createFileSystemMock({
        entries: {
          [WORKSPACES_DIR.toString()]: directory(),
        },
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
        worktreeLogger,
        { keepFilesService: mockKeepFilesService }
      );

      // Create workspace
      const workspace = await provider.createWorkspace("feature-test", "main");

      expect(workspace.name).toBe("feature-test");
      expect(mockKeepFilesService.copyToWorkspace).toHaveBeenCalledWith(
        PROJECT_ROOT.toString(),
        expect.stringContaining("feature-test")
      );
    });

    it("error handling does not fail workspace creation", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main"],
            currentBranch: "main",
          },
        },
      });
      const mockFs = createFileSystemMock({
        entries: {
          [WORKSPACES_DIR.toString()]: directory(),
        },
      });
      const mockKeepFilesService = {
        copyToWorkspace: vi.fn().mockResolvedValue({
          configExists: true,
          copiedCount: 1,
          skippedCount: 0,
          errors: [{ path: "nonexistent.txt", message: "File not found" }],
        }),
      };
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        worktreeLogger,
        { keepFilesService: mockKeepFilesService }
      );

      // Should not throw
      const workspace = await provider.createWorkspace("feature-error-test", "main");

      expect(workspace.name).toBe("feature-error-test");
    });
  });

  describe("concurrent workspace creation", () => {
    it("two workspaces created in parallel both succeed", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main"],
            currentBranch: "main",
          },
        },
      });
      const mockFs = createFileSystemMock({
        entries: {
          [WORKSPACES_DIR.toString()]: directory(),
        },
      });
      const mockKeepFilesService = {
        copyToWorkspace: vi.fn().mockResolvedValue({
          configExists: true,
          copiedCount: 1,
          skippedCount: 0,
          errors: [],
        }),
      };
      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        worktreeLogger,
        { keepFilesService: mockKeepFilesService }
      );

      // Create two workspaces in parallel
      const [workspace1, workspace2] = await Promise.all([
        provider.createWorkspace("feature-a", "main"),
        provider.createWorkspace("feature-b", "main"),
      ]);

      expect(workspace1.name).toBe("feature-a");
      expect(workspace2.name).toBe("feature-b");

      // Both should have triggered copyToWorkspace
      expect(mockKeepFilesService.copyToWorkspace).toHaveBeenCalledTimes(2);
    });
  });

  describe("removeWorkspace idempotent scenario", () => {
    it("deletes branch when worktree already unregistered", async () => {
      // Start with a workspace that exists
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main"],
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

      // Create workspace normally
      const workspace = await provider.createWorkspace("feature-retry", "main");

      // Verify branch exists
      expect(mockClient).toHaveBranch(PROJECT_ROOT, "feature-retry");

      // Simulate worktree already being removed (remove from mock state directly)
      const repo = mockClient.$.repositories.get(PROJECT_ROOT.toString());
      if (repo) {
        (repo.worktrees as Map<string, unknown>).delete(workspace.path.toString());
      }

      // Call removeWorkspace - should still delete the branch even though worktree is gone
      const result = await provider.removeWorkspace(workspace.path, true);

      expect(result.workspaceRemoved).toBe(true);
      expect(result.baseDeleted).toBe(true);

      // Verify branch was actually deleted
      expect(mockClient).not.toHaveBranch(PROJECT_ROOT, "feature-retry");
    });
  });

  describe("timing verification", () => {
    it("keep files copied after worktree creation succeeds", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main"],
            currentBranch: "main",
          },
        },
      });
      const mockFs = createFileSystemMock({
        entries: {
          [WORKSPACES_DIR.toString()]: directory(),
        },
      });

      const copyToWorkspaceSpy = vi.fn().mockResolvedValue({
        configExists: true,
        copiedCount: 1,
        skippedCount: 0,
        errors: [],
      });
      const mockKeepFilesService = {
        copyToWorkspace: copyToWorkspaceSpy,
      };

      const provider = await GitWorktreeProvider.create(
        PROJECT_ROOT,
        mockClient,
        WORKSPACES_DIR,
        mockFs,
        worktreeLogger,
        { keepFilesService: mockKeepFilesService }
      );

      const workspace = await provider.createWorkspace("feature-timing", "main");

      // Verify copyToWorkspace was called with the correct arguments
      expect(copyToWorkspaceSpy).toHaveBeenCalledWith(
        PROJECT_ROOT.toString(),
        workspace.path.toString()
      );
    });
  });
});
