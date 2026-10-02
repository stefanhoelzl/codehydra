// @vitest-environment node
/**
 * Integration tests for GitWorktreeProvider using behavioral mock.
 * Tests end-to-end workflows without real git repositories.
 */

import { describe, it, expect, vi } from "vitest";
import { GitWorktreeProvider } from "./git-worktree-provider";
import { createMockGitClient } from "./git-client.state-mock";
import { MAIN_ONLY, testProject } from "./git-worktree-provider.test-utils";
import {
  createFileSystemMock,
  createSpyFileSystemBoundary,
  directory,
  symlink,
  file,
  type MockFileSystemBoundary,
} from "./filesystem.state-mock";
import { SILENT_LOGGER, createMockLogger } from "./logging";
import { WorkspaceError } from "../../shared/errors/service-errors";
import { Path } from "../../utils/path/path";
import type { FileSystemBoundary } from "./filesystem";
import { projPath, testPath } from "../../shared/test-fixtures";
import { sep } from "node:path";

/** The flat metadata a worktree's metadata file holds, or null when it has none. */
async function readMetadataFile(
  fs: FileSystemBoundary,
  gitDir: Path
): Promise<Record<string, Record<string, string>> | null> {
  try {
    return JSON.parse(await fs.readFile(new Path(gitDir, "codehydra.json"))) as Record<
      string,
      Record<string, string>
    >;
  } catch {
    return null;
  }
}

describe("GitWorktreeProvider integration", () => {
  const PROJECT_ROOT = testPath("/project");
  const WORKSPACES_DIR = testPath("/workspaces");
  const mockFs = createFileSystemMock({
    entries: {
      [WORKSPACES_DIR.toString()]: directory(),
    },
  });
  const worktreeLogger = SILENT_LOGGER;
  const { gitRepo, providerFor } = testProject(PROJECT_ROOT, WORKSPACES_DIR);

  describe("managed-worktree filtering", () => {
    /**
     * A repository whose worktrees are: one CodeHydra created, one the user made
     * elsewhere, one an agent left behind on a detached HEAD.
     */
    function mixedRepo(branchConfigs: Record<string, Record<string, string>> = {}) {
      return gitRepo({
        branches: ["main", "feature-a", "feature/login"],
        currentBranch: "main",
        worktrees: [
          {
            name: "feature-a",
            path: "/workspaces/feature-a",
            branch: "feature-a",
          },
          {
            name: "repo-login",
            path: "/code/repo-login",
            branch: "feature/login",
          },
          { name: "wt-8fa2", path: "/tmp/wt-8fa2", branch: null },
        ],
        branchConfigs: { "feature-a": { "codehydra.base": "main" }, ...branchConfigs },
      });
    }

    it("keeps its own worktrees and skips every other one", async () => {
      const provider = await providerFor(mixedRepo(), mockFs);

      const discovered = await provider.discover(PROJECT_ROOT);

      expect(discovered.map((w) => w.name)).toEqual(["feature-a"]);
    });

    it("logs each skipped worktree so a missing tab stays diagnosable", async () => {
      const logger = createMockLogger();
      const provider = await providerFor(mixedRepo(), mockFs, logger);

      await provider.discover(PROJECT_ROOT);

      expect(logger.warn).toHaveBeenCalledWith("Skipping unmanaged worktree", {
        "scope.path": testPath("/code/repo-login").toString(),
        branch: "feature/login",
      });
      expect(logger.warn).toHaveBeenCalledWith("Skipping unmanaged worktree", {
        "scope.path": testPath("/tmp/wt-8fa2").toString(),
        branch: null,
      });
    });

    it("keeps an adopted worktree and names it after its branch", async () => {
      const client = mixedRepo({
        "feature/login": { "codehydra.tags.external": '{"color":"#8b949e"}' },
      });
      const provider = await providerFor(client, mockFs);

      const discovered = await provider.discover(PROJECT_ROOT);

      const adopted = discovered.find(
        (w) => w.path.toString() === testPath("/code/repo-login").toString()
      );
      // The branch, not the directory: a workspace is named after its branch
      // wherever it lives, so the directory name never leaks into the name.
      expect(adopted?.name).toBe("feature/login");
      expect(adopted?.branch).toBe("feature/login");
      expect(adopted?.metadata["tags.external"]).toBe('{"color":"#8b949e"}');
    });

    it("still names its own worktrees after their branch", async () => {
      const provider = await providerFor(mixedRepo(), mockFs);

      const discovered = await provider.discover(PROJECT_ROOT);

      expect(discovered[0]?.name).toBe("feature-a");
    });

    it("names its own detached worktree after the branch its directory encodes", async () => {
      const client = gitRepo({
        branches: ["main", "feature/x"],
        currentBranch: "main",
        worktrees: [{ name: "feature%x", path: "/workspaces/feature%x", branch: null }],
      });
      const provider = await providerFor(client, mockFs);

      const discovered = await provider.discover(PROJECT_ROOT);

      expect(discovered.map((w) => w.name)).toEqual(["feature/x"]);
    });
  });

  describe("adoption", () => {
    function repoWithExternalWorktree(fileSystem?: MockFileSystemBoundary) {
      return gitRepo(
        {
          branches: ["main", "feature/login"],
          currentBranch: "main",
          worktrees: [
            {
              name: "repo-login",
              path: "/code/repo-login",
              branch: "feature/login",
            },
            { name: "wt-8fa2", path: "/tmp/wt-8fa2", branch: null },
          ],
        },
        fileSystem
      );
    }

    it("lists what discover() skips, detached worktrees included", async () => {
      const client = gitRepo({
        branches: ["main", "feature-a", "feature/login"],
        currentBranch: "main",
        worktrees: [
          {
            name: "feature-a",
            path: "/workspaces/feature-a",
            branch: "feature-a",
          },
          {
            name: "repo-login",
            path: "/code/repo-login",
            branch: "feature/login",
          },
          { name: "wt-8fa2", path: "/tmp/wt-8fa2", branch: null },
        ],
      });
      const provider = await providerFor(client, mockFs);

      const unmanaged = await provider.listUnmanagedWorktrees(PROJECT_ROOT, WORKSPACES_DIR);

      expect(unmanaged.map((w) => w.name)).toEqual(["feature/login", "wt-8fa2"]);
    });

    it("omits an already-adopted worktree from the offer", async () => {
      const client = gitRepo({
        branches: ["main", "feature/login"],
        currentBranch: "main",
        worktrees: [
          {
            name: "repo-login",
            path: "/code/repo-login",
            branch: "feature/login",
          },
        ],
        branchConfigs: {
          "feature/login": { "codehydra.tags.external": '{"color":"#8b949e"}' },
        },
      });
      const provider = await providerFor(client, mockFs);

      expect(await provider.listUnmanagedWorktrees(PROJECT_ROOT, WORKSPACES_DIR)).toEqual([]);
    });

    it("adopting makes the worktree discoverable across a restart", async () => {
      const fs = createFileSystemMock();
      const client = repoWithExternalWorktree(fs);
      const provider = await providerFor(client, fs);
      expect(await provider.discover(PROJECT_ROOT)).toEqual([]);

      const adopted = await provider.adoptWorktree(
        PROJECT_ROOT,
        testPath("/code/repo-login"),
        "feature/login"
      );
      expect(adopted.name).toBe("feature/login");

      // A fresh provider over the same repo: the tag lives in the metadata file, not memory.
      const restarted = await providerFor(client, fs);
      expect((await restarted.discover(PROJECT_ROOT)).map((w) => w.name)).toEqual([
        "feature/login",
      ]);
    });

    it("keeps a worktree left in a pre-migration workspaces dir, on any branch", async () => {
      // A workspaces-root migration leaves worktrees where they were; their agent
      // later checks out a temporary branch the adoption tag is not on.
      const oldWorkspacesDir = testPath("/old-root/projects/repo-1234/workspaces");
      const client = gitRepo({
        branches: ["main", "feature/login", "tmp/squash"],
        currentBranch: "main",
        worktrees: [
          {
            name: "feature%login",
            path: "/old-root/projects/repo-1234/workspaces/feature%login",
            branch: "tmp/squash",
          },
          { name: "wt-8fa2", path: "/tmp/wt-8fa2", branch: null },
        ],
        branchConfigs: {
          "feature/login": { "codehydra.tags.external": '{"color":"#8b949e"}' },
        },
      });
      const provider = new GitWorktreeProvider(client, mockFs, worktreeLogger);
      await provider.validateRepository(PROJECT_ROOT);
      provider.registerProject(PROJECT_ROOT, WORKSPACES_DIR, [oldWorkspacesDir]);

      const discovered = await provider.discover(PROJECT_ROOT);

      expect(discovered.map((w) => w.path.toString())).toEqual([
        new Path(oldWorkspacesDir, "feature%login").toString(),
      ]);
      expect(
        await provider.listUnmanagedWorktrees(PROJECT_ROOT, WORKSPACES_DIR, [oldWorkspacesDir])
      ).toEqual([expect.objectContaining({ name: "wt-8fa2" })]);
    });

    it("adopts a detached worktree, named after its directory", async () => {
      const fs = createFileSystemMock();
      const client = repoWithExternalWorktree(fs);
      const provider = await providerFor(client, fs);

      const adopted = await provider.adoptWorktree(PROJECT_ROOT, testPath("/tmp/wt-8fa2"), null);
      expect(adopted.name).toBe("wt-8fa2");

      const restarted = await providerFor(client, fs);
      expect((await restarted.discover(PROJECT_ROOT)).map((w) => w.name)).toEqual(["wt-8fa2"]);
    });

    it("throws when the tag cannot be written, rather than reporting a phantom workspace", async () => {
      const fs = createFileSystemMock();
      const client = repoWithExternalWorktree(fs);
      vi.spyOn(fs, "writeFile").mockRejectedValue(new Error("disk is read-only"));
      const provider = await providerFor(client, fs);

      await expect(
        provider.adoptWorktree(PROJECT_ROOT, testPath("/code/repo-login"), "feature/login")
      ).rejects.toThrow(WorkspaceError);
    });
  });

  describe("metadata.base persistence", () => {
    it("creates workspace with metadata.base and retrieves via discover()", async () => {
      const fs = createFileSystemMock();
      const mockClient = gitRepo(MAIN_ONLY, fs);
      const provider = await providerFor(mockClient, fs);

      // Create workspace with base branch "main"
      const created = await provider.createWorkspace(PROJECT_ROOT, "feature-x", "main");
      expect(created.metadata.base).toBe("main");

      // Discover should return same metadata.base
      const discovered = await provider.discover(PROJECT_ROOT);
      expect(discovered).toHaveLength(1);
      expect(discovered[0]?.metadata.base).toBe("main");
    });

    it("metadata.base survives provider instance recreation", async () => {
      const fs = createFileSystemMock();
      const mockClient = gitRepo(MAIN_ONLY, fs);

      // Create with first provider instance
      const provider1 = await providerFor(mockClient, fs);
      await provider1.createWorkspace(PROJECT_ROOT, "feature-x", "main");

      // Create new provider instance and verify metadata.base persists
      // (using same mockClient which retains state)
      const provider2 = await providerFor(mockClient, fs);
      const discovered = await provider2.discover(PROJECT_ROOT);

      expect(discovered).toHaveLength(1);
      expect(discovered[0]?.metadata.base).toBe("main");
    });

    it("workspace without config returns empty metadata", async () => {
      const mockClient = gitRepo({
        branches: ["main", "no-config-branch"],
        currentBranch: "main",
        worktrees: [
          {
            name: "no-config-branch",
            path: "/workspaces/no-config-branch",
            branch: "no-config-branch",
          },
        ],
      });

      const provider = await providerFor(mockClient, mockFs);
      const discovered = await provider.discover(PROJECT_ROOT);

      expect(discovered).toHaveLength(1);
      expect(discovered[0]?.metadata.base).toBeUndefined();
    });

    it("stores metadata.base as a protected key in the worktree's metadata file", async () => {
      const fs = createFileSystemMock();
      const mockClient = gitRepo(MAIN_ONLY, fs);
      const provider = await providerFor(mockClient, fs);
      await provider.createWorkspace(PROJECT_ROOT, "feature-x", "main");

      expect(
        await readMetadataFile(fs, new Path(PROJECT_ROOT, ".git", "worktrees", "feature-x"))
      ).toEqual({
        version: 1,
        internal: {},
        protected: { base: "main", name: "feature-x" },
        public: {},
      });
      expect(await mockClient.getGitConfig(PROJECT_ROOT, { regex: "codehydra" })).toEqual(
        new Map()
      );
    });
  });

  describe("discover name resolution", () => {
    it("returns branch name (not sanitized basename) for workspaces with /", async () => {
      const mockClient = gitRepo({
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
      });

      const provider = await providerFor(mockClient, mockFs);

      const discovered = await provider.discover(PROJECT_ROOT);
      expect(discovered).toHaveLength(1);
      expect(discovered[0]?.name).toBe("feature/login");
      expect(discovered[0]?.branch).toBe("feature/login");
    });

    it("falls back to filesystem name for detached HEAD workspaces", async () => {
      const mockClient = gitRepo({
        branches: ["main"],
        currentBranch: "main",
        worktrees: [
          {
            name: "detached-ws",
            path: "/workspaces/detached-ws",
            branch: null,
          },
        ],
      });

      const provider = await providerFor(mockClient, mockFs);

      const discovered = await provider.discover(PROJECT_ROOT);
      expect(discovered).toHaveLength(1);
      expect(discovered[0]?.name).toBe("detached-ws");
      expect(discovered[0]?.branch).toBeNull();
    });
  });

  describe("metadata setMetadata/getMetadata", () => {
    it("setMetadata persists and getMetadata retrieves", async () => {
      const fs = createFileSystemMock();
      const mockClient = gitRepo(MAIN_ONLY, fs);
      const provider = await providerFor(mockClient, fs);
      const workspace = await provider.createWorkspace(PROJECT_ROOT, "feature-x", "main");

      await provider.setMetadata(workspace.path, "note", "WIP feature");

      const metadata = await provider.getMetadata(workspace.path);
      expect(metadata.note).toBe("WIP feature");
      expect(metadata.base).toBe("main");
    });

    it("metadata survives provider recreation", async () => {
      const fs = createFileSystemMock();
      const mockClient = gitRepo(MAIN_ONLY, fs);
      const provider1 = await providerFor(mockClient, fs);
      const workspace = await provider1.createWorkspace(PROJECT_ROOT, "feature-x", "main");
      await provider1.setMetadata(workspace.path, "note", "test note");

      const provider2 = await providerFor(mockClient, fs);
      // Must discover to populate workspace registry before getMetadata
      await provider2.discover(PROJECT_ROOT);
      const metadata = await provider2.getMetadata(workspace.path);

      expect(metadata.note).toBe("test note");
      expect(metadata.base).toBe("main");
    });

    it("getMetadata returns empty metadata for workspace without config", async () => {
      const mockClient = gitRepo({
        branches: ["main", "no-config-branch"],
        currentBranch: "main",
        worktrees: [
          {
            name: "no-config-branch",
            path: "/workspaces/no-config-branch",
            branch: "no-config-branch",
          },
        ],
      });

      const provider = await providerFor(mockClient, mockFs);
      await provider.discover(PROJECT_ROOT);
      const metadata = await provider.getMetadata(testPath("/workspaces/no-config-branch"));

      expect(metadata.base).toBeUndefined();
    });

    it("invalid key format throws WorkspaceError with INVALID_METADATA_KEY code", async () => {
      const mockClient = gitRepo(MAIN_ONLY);
      const provider = await providerFor(mockClient, mockFs);
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
      const fs = createFileSystemMock();
      const mockClient = gitRepo(MAIN_ONLY, fs);
      const provider = await providerFor(mockClient, fs);
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
  const PROJECT_ROOT = testPath("/home/user/projects/my-repo");
  const WORKSPACES_DIR = new Path(
    testPath("/home/user/app-data/projects/my-repo-abc12345/workspaces").toNative()
  );
  const mockFs = createFileSystemMock();
  const worktreeLogger = SILENT_LOGGER;
  const { gitRepo, providerFor } = testProject(PROJECT_ROOT, WORKSPACES_DIR);

  describe("create (factory)", () => {
    it("creates provider for valid git repository", async () => {
      const mockClient = gitRepo(MAIN_ONLY);

      const provider = await providerFor(mockClient, mockFs);

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

      await expect(providerFor(mockClient, mockFs)).rejects.toThrow(WorkspaceError);
    });
  });

  describe("discover", () => {
    it("returns empty array when only main worktree exists", async () => {
      const mockClient = gitRepo(MAIN_ONLY);
      const provider = await providerFor(mockClient, mockFs);

      const workspaces = await provider.discover(PROJECT_ROOT);

      expect(workspaces).toHaveLength(0);
    });

    it("excludes main worktree from results", async () => {
      const mockClient = gitRepo({
        branches: ["main", "feature-branch"],
        currentBranch: "main",
        worktrees: [
          {
            name: "feature-branch",
            path: testPath(
              "/home/user/app-data/projects/my-repo-abc12345/workspaces/feature-branch"
            ).toNative(),
            branch: "feature-branch",
          },
        ],
      });
      const provider = await providerFor(mockClient, mockFs);

      const workspaces = await provider.discover(PROJECT_ROOT);

      expect(workspaces).toHaveLength(1);
      expect(workspaces[0]!.name).toBe("feature-branch");
    });

    it("handles detached HEAD workspaces", async () => {
      const mockClient = gitRepo({
        branches: ["main"],
        currentBranch: "main",
        worktrees: [
          {
            name: "detached-workspace",
            path: testPath(
              "/home/user/app-data/projects/my-repo-abc12345/workspaces/detached"
            ).toNative(),
            branch: null,
          },
        ],
      });
      const provider = await providerFor(mockClient, mockFs);

      const workspaces = await provider.discover(PROJECT_ROOT);

      expect(workspaces).toHaveLength(1);
      expect(workspaces[0]!.branch).toBeNull();
    });

    it("returns multiple workspaces", async () => {
      const mockClient = gitRepo({
        branches: ["main", "feature-a", "feature-b"],
        currentBranch: "main",
        worktrees: [
          {
            name: "feature-a",
            path: testPath(
              "/home/user/app-data/projects/my-repo-abc12345/workspaces/feature-a"
            ).toNative(),
            branch: "feature-a",
          },
          {
            name: "feature-b",
            path: testPath(
              "/home/user/app-data/projects/my-repo-abc12345/workspaces/feature-b"
            ).toNative(),
            branch: "feature-b",
          },
        ],
      });
      const provider = await providerFor(mockClient, mockFs);

      const workspaces = await provider.discover(PROJECT_ROOT);

      expect(workspaces).toHaveLength(2);
    });

    it("skips corrupted worktree entries without throwing", async () => {
      const mockClient = gitRepo({
        branches: ["main", "feature-valid", "unnamed-branch"],
        currentBranch: "main",
        worktrees: [
          {
            name: "feature-valid",
            path: testPath(
              "/home/user/app-data/projects/my-repo-abc12345/workspaces/feature-valid"
            ).toNative(),
            branch: "feature-valid",
          },
          {
            name: "",
            path: testPath(
              "/home/user/app-data/projects/my-repo-abc12345/workspaces/unnamed"
            ).toNative(),
            branch: "unnamed-branch",
          },
        ],
      });
      const provider = await providerFor(mockClient, mockFs);

      // Should not throw and should handle gracefully
      const workspaces = await provider.discover(PROJECT_ROOT);

      // Should include valid worktrees
      expect(Array.isArray(workspaces)).toBe(true);
      expect(workspaces.some((w) => w.name === "feature-valid")).toBe(true);
    });

    it("returns baseBranch from config when set", async () => {
      const mockClient = gitRepo({
        branches: ["main", "feature-x"],
        currentBranch: "main",
        worktrees: [
          {
            name: "feature-x",
            path: testPath(
              "/home/user/app-data/projects/my-repo-abc12345/workspaces/feature-x"
            ).toNative(),
            branch: "feature-x",
          },
        ],
        branchConfigs: {
          "feature-x": { "codehydra.base": "develop" },
        },
      });
      const provider = await providerFor(mockClient, mockFs);

      const workspaces = await provider.discover(PROJECT_ROOT);

      expect(workspaces).toHaveLength(1);
      expect(workspaces[0]!.metadata.base).toBe("develop");
    });

    it("metadata comes from config only, no fallback for missing base", async () => {
      const mockClient = gitRepo({
        branches: ["main", "branch-a", "branch-b"],
        currentBranch: "main",
        worktrees: [
          // Has config
          {
            name: "workspace-a",
            path: testPath(
              "/home/user/app-data/projects/my-repo-abc12345/workspaces/workspace-a"
            ).toNative(),
            branch: "branch-a",
          },
          // No config
          {
            name: "workspace-b",
            path: testPath(
              "/home/user/app-data/projects/my-repo-abc12345/workspaces/workspace-b"
            ).toNative(),
            branch: "branch-b",
          },
          // No config, no branch (detached)
          {
            name: "workspace-c",
            path: testPath(
              "/home/user/app-data/projects/my-repo-abc12345/workspaces/workspace-c"
            ).toNative(),
            branch: null,
          },
        ],
        branchConfigs: {
          "branch-a": { "codehydra.base": "configured-base" },
        },
      });
      const provider = await providerFor(mockClient, mockFs);

      const workspaces = await provider.discover(PROJECT_ROOT);

      expect(workspaces).toHaveLength(3);

      const workspaceA = workspaces.find((w) => w.name === "branch-a");
      const workspaceB = workspaces.find((w) => w.name === "branch-b");
      const workspaceC = workspaces.find((w) => w.name === "workspace-c");

      expect(workspaceA?.metadata.base).toBe("configured-base");
      expect(workspaceB?.metadata.base).toBeUndefined();
      expect(workspaceC?.metadata.base).toBeUndefined();
    });
  });

  describe("discover - metadata", () => {
    it("returns full metadata from config (multiple keys)", async () => {
      const mockClient = gitRepo({
        branches: ["main", "feature-x"],
        currentBranch: "main",
        worktrees: [
          {
            name: "feature-x",
            path: testPath(
              "/home/user/app-data/projects/my-repo-abc12345/workspaces/feature-x"
            ).toNative(),
            branch: "feature-x",
          },
        ],
        branchConfigs: {
          "feature-x": {
            "codehydra.base": "main",
            "codehydra.note": "WIP auth feature",
            "codehydra.model": "claude-4",
          },
        },
      });
      const provider = await providerFor(mockClient, mockFs);

      const workspaces = await provider.discover(PROJECT_ROOT);

      expect(workspaces).toHaveLength(1);
      expect(workspaces[0]!.metadata).toEqual({
        base: "main",
        note: "WIP auth feature",
        model: "claude-4",
        name: "feature-x",
      });
    });
  });

  describe("config read batching (regression)", () => {
    it("listBases reads no git config", async () => {
      const mockClient = gitRepo({
        branches: ["main", "a", "b", "c", "d"],
        currentBranch: "main",
      });
      const provider = await providerFor(mockClient, mockFs);
      const spy = vi.spyOn(mockClient, "getGitConfig");

      await provider.listBases(PROJECT_ROOT);

      expect(spy).not.toHaveBeenCalled();
    });
    it("discover reads git config once while unmigrated, never after", async () => {
      const fs = createFileSystemMock();
      const mockClient = gitRepo(
        {
          branches: ["main", "a", "b", "c"],
          currentBranch: "main",
          worktrees: [
            {
              name: "a",
              path: testPath(
                "/home/user/app-data/projects/my-repo-abc12345/workspaces/a"
              ).toNative(),
              branch: "a",
            },
            {
              name: "b",
              path: testPath(
                "/home/user/app-data/projects/my-repo-abc12345/workspaces/b"
              ).toNative(),
              branch: "b",
            },
            {
              name: "c",
              path: testPath(
                "/home/user/app-data/projects/my-repo-abc12345/workspaces/c"
              ).toNative(),
              branch: "c",
            },
          ],
        },
        fs
      );
      const provider = await providerFor(mockClient, fs);
      const spy = vi.spyOn(mockClient, "getGitConfig");

      await provider.discover(PROJECT_ROOT);
      expect(spy).toHaveBeenCalledTimes(1);

      await provider.discover(PROJECT_ROOT);
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  describe("listBases", () => {
    it("returns local and remote branches", async () => {
      const mockClient = gitRepo({
        branches: ["main", "feature"],
        remoteBranches: ["origin/main"],
        currentBranch: "main",
      });
      const provider = await providerFor(mockClient, mockFs);

      const bases = await provider.listBases(PROJECT_ROOT);

      expect(bases).toHaveLength(3);
      expect(bases.find((b) => b.name === "main" && !b.isRemote)).toBeDefined();
      expect(bases.find((b) => b.name === "origin/main" && b.isRemote)).toBeDefined();
    });

    it("returns derives for local branch without worktree", async () => {
      const mockClient = gitRepo({
        branches: ["main", "feature-x"],
        currentBranch: "main",
        // No worktrees for feature-x
      });
      const provider = await providerFor(mockClient, mockFs);

      const bases = await provider.listBases(PROJECT_ROOT);

      const featureX = bases.find((b) => b.name === "feature-x");
      expect(featureX?.derives).toBe("feature-x");
    });

    it("excludes derives for local branch with worktree", async () => {
      const mockClient = gitRepo({
        branches: ["main", "feature-x"],
        currentBranch: "main",
        worktrees: [
          {
            name: "feature-x",
            path: testPath(
              "/home/user/app-data/projects/my-repo-abc12345/workspaces/feature-x"
            ).toNative(),
            branch: "feature-x",
          },
        ],
      });
      const provider = await providerFor(mockClient, mockFs);

      const bases = await provider.listBases(PROJECT_ROOT);

      const featureX = bases.find((b) => b.name === "feature-x");
      expect(featureX?.derives).toBeUndefined();
    });

    it("returns derives for remote without local counterpart", async () => {
      const mockClient = gitRepo({
        branches: ["main"],
        remoteBranches: ["origin/feature-payments"],
        currentBranch: "main",
      });
      const provider = await providerFor(mockClient, mockFs);

      const bases = await provider.listBases(PROJECT_ROOT);

      const remote = bases.find((b) => b.name === "origin/feature-payments");
      expect(remote?.derives).toBe("feature-payments");
    });

    it("excludes derives for remote with local counterpart", async () => {
      const mockClient = gitRepo({
        branches: ["main", "feature-payments"],
        remoteBranches: ["origin/feature-payments"],
        currentBranch: "main",
      });
      const provider = await providerFor(mockClient, mockFs);

      const bases = await provider.listBases(PROJECT_ROOT);

      const remote = bases.find((b) => b.name === "origin/feature-payments");
      expect(remote?.derives).toBeUndefined();
    });

    it("deduplicates remotes for derives (prefers origin)", async () => {
      const mockClient = gitRepo({
        branches: ["main"],
        remoteBranches: ["origin/feature-x", "upstream/feature-x"],
        currentBranch: "main",
      });
      const provider = await providerFor(mockClient, mockFs);

      const bases = await provider.listBases(PROJECT_ROOT);

      const originBranch = bases.find((b) => b.name === "origin/feature-x");
      const upstreamBranch = bases.find((b) => b.name === "upstream/feature-x");

      // Origin should get derives, upstream should not
      expect(originBranch?.derives).toBe("feature-x");
      expect(upstreamBranch?.derives).toBeUndefined();
    });

    it("returns the base recorded for a local branch's workspace", async () => {
      const mockClient = gitRepo({
        branches: ["main", "feature-x"],
        currentBranch: "main",
        worktrees: [
          {
            name: "feature-x",
            path: new Path(WORKSPACES_DIR, "feature-x").toString(),
            branch: "feature-x",
          },
        ],
        branchConfigs: {
          "feature-x": { "codehydra.base": "develop" },
        },
      });
      const provider = await providerFor(mockClient, mockFs);
      await provider.discover(PROJECT_ROOT);

      const bases = await provider.listBases(PROJECT_ROOT);

      const featureX = bases.find((b) => b.name === "feature-x");
      expect(featureX?.base).toBe("develop");
    });
    it("returns base from matching remote when no config", async () => {
      const mockClient = gitRepo({
        branches: ["main", "feature-x"],
        remoteBranches: ["origin/feature-x"],
        currentBranch: "main",
        // No config for feature-x
      });
      const provider = await providerFor(mockClient, mockFs);

      const bases = await provider.listBases(PROJECT_ROOT);

      const featureX = bases.find((b) => b.name === "feature-x" && !b.isRemote);
      expect(featureX?.base).toBe("origin/feature-x");
    });

    it("returns undefined base when no config and no matching remote", async () => {
      const mockClient = gitRepo({
        branches: ["main", "feature-x"],
        currentBranch: "main",
        // No config, no matching remote
      });
      const provider = await providerFor(mockClient, mockFs);

      const bases = await provider.listBases(PROJECT_ROOT);

      const featureX = bases.find((b) => b.name === "feature-x");
      expect(featureX?.base).toBeUndefined();
    });

    it("returns full ref as base for remote branches", async () => {
      const mockClient = gitRepo({
        branches: ["main"],
        remoteBranches: ["origin/feature-x"],
        currentBranch: "main",
      });
      const provider = await providerFor(mockClient, mockFs);

      const bases = await provider.listBases(PROJECT_ROOT);

      const remote = bases.find((b) => b.name === "origin/feature-x");
      expect(remote?.base).toBe("origin/feature-x");
    });

    it("handles remote branch with slashes in name", async () => {
      const mockClient = gitRepo({
        branches: ["main"],
        remoteBranches: ["origin/feature/login"],
        currentBranch: "main",
      });
      const provider = await providerFor(mockClient, mockFs);

      const bases = await provider.listBases(PROJECT_ROOT);

      const remote = bases.find((b) => b.name === "origin/feature/login");
      expect(remote?.derives).toBe("feature/login");
    });
  });

  describe("updateBases", () => {
    it("returns success when fetch succeeds", async () => {
      const mockClient = gitRepo({
        branches: ["main"],
        remotes: ["origin"],
        currentBranch: "main",
      });
      const provider = await providerFor(mockClient, mockFs);

      const result = await provider.updateBases(PROJECT_ROOT);

      expect(result.fetchedRemotes).toContain("origin");
      expect(result.failedRemotes).toHaveLength(0);
    });

    it("returns empty arrays when no remotes exist", async () => {
      const mockClient = gitRepo({
        branches: ["main"],
        remotes: [],
        currentBranch: "main",
      });
      const provider = await providerFor(mockClient, mockFs);

      const result = await provider.updateBases(PROJECT_ROOT);

      expect(result.fetchedRemotes).toHaveLength(0);
      expect(result.failedRemotes).toHaveLength(0);
    });
  });

  describe("createWorkspace", () => {
    it("creates workspace and returns workspace info", async () => {
      const mockClient = gitRepo(MAIN_ONLY);
      const provider = await providerFor(mockClient, mockFs);

      const workspace = await provider.createWorkspace(PROJECT_ROOT, "feature-x", "main");

      expect(workspace.name).toBe("feature-x");
      expect(workspace.branch).toBe("feature-x");
      // Behavioral assertion: branch should exist in mock state
      expect(mockClient).toHaveBranch(PROJECT_ROOT, "feature-x");
    });

    it("sanitizes branch names with slashes", async () => {
      const mockClient = gitRepo(MAIN_ONLY);
      const provider = await providerFor(mockClient, mockFs);

      const workspace = await provider.createWorkspace(PROJECT_ROOT, "user/feature", "main");

      // The directory name should have sanitized slashes
      expect(workspace.name).toBe("user/feature");
      // Behavioral assertion: branch should be created
      expect(mockClient).toHaveBranch(PROJECT_ROOT, "user/feature");
    });

    it("creates workspace using existing branch when baseBranch matches branch name", async () => {
      const mockClient = gitRepo({
        branches: ["main", "existing-branch"],
        currentBranch: "main",
      });
      const provider = await providerFor(mockClient, mockFs);

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
      const mockClient = gitRepo({
        branches: ["main", "existing-branch"],
        currentBranch: "main",
      });
      const provider = await providerFor(mockClient, mockFs);

      // Should succeed even though baseBranch differs from branch name
      const workspace = await provider.createWorkspace(PROJECT_ROOT, "existing-branch", "main");

      expect(workspace.name).toBe("existing-branch");
      expect(workspace.branch).toBe("existing-branch");
      // The base branch should be saved in metadata
      expect(workspace.metadata.base).toBe("main");
    });

    it("throws WorkspaceError when branch is already checked out in worktree", async () => {
      const mockClient = gitRepo({
        branches: ["main", "checked-out-branch"],
        currentBranch: "main",
        worktrees: [
          {
            name: "existing-workspace",
            path: testPath(
              "/home/user/app-data/projects/my-repo-abc12345/workspaces/existing-workspace"
            ).toNative(),
            branch: "checked-out-branch",
          },
        ],
      });
      const provider = await providerFor(mockClient, mockFs);

      await expect(
        provider.createWorkspace(PROJECT_ROOT, "checked-out-branch", "checked-out-branch")
      ).rejects.toThrow(WorkspaceError);
      await expect(
        provider.createWorkspace(PROJECT_ROOT, "checked-out-branch", "checked-out-branch")
      ).rejects.toThrow(/already checked out.*\/workspaces\/existing-workspace/);
    });

    it("throws WorkspaceError when branch is checked out in main worktree", async () => {
      const mockClient = gitRepo(MAIN_ONLY);
      const provider = await providerFor(mockClient, mockFs);

      await expect(provider.createWorkspace(PROJECT_ROOT, "main", "main")).rejects.toThrow(
        WorkspaceError
      );
      await expect(provider.createWorkspace(PROJECT_ROOT, "main", "main")).rejects.toThrow(
        /already checked out.*\/home\/user\/projects\/my-repo/
      );
    });

    it("ignores remote branches when checking for existing branch", async () => {
      const mockClient = gitRepo({
        branches: ["main"],
        remoteBranches: ["origin/feature-x"], // Remote branch with same name
        currentBranch: "main",
      });
      const provider = await providerFor(mockClient, mockFs);

      // Should create new local branch even though remote exists
      const workspace = await provider.createWorkspace(PROJECT_ROOT, "origin/feature-x", "main");

      expect(workspace.name).toBe("origin/feature-x");
      expect(mockClient).toHaveBranch(PROJECT_ROOT, "origin/feature-x");
    });

    it("returns workspace with metadata.base set", async () => {
      const mockClient = gitRepo(MAIN_ONLY);
      const provider = await providerFor(mockClient, mockFs);

      const workspace = await provider.createWorkspace(PROJECT_ROOT, "feature-x", "main");

      expect(workspace.metadata.base).toBe("main");
    });

    it("creates workspace with tracking (new branch from tracking ref)", async () => {
      const mockClient = gitRepo({
        branches: ["main"],
        remoteBranches: ["origin/feature-login"],
        currentBranch: "main",
      });
      const provider = await providerFor(mockClient, mockFs);

      const workspace = await provider.createWorkspace(
        PROJECT_ROOT,
        "review-pr-42",
        "origin/main",
        "origin/feature-login"
      );

      expect(workspace.name).toBe("review-pr-42");
      expect(workspace.branch).toBe("review-pr-42");
      expect(workspace.metadata.base).toBe("origin/main");
      expect(mockClient).toHaveBranch(PROJECT_ROOT, "review-pr-42");
    });

    it("reconfigures upstream when tracking is set and branch already exists", async () => {
      const mockClient = gitRepo({
        branches: ["main", "review-pr-42"],
        remoteBranches: ["origin/feature-login"],
        currentBranch: "main",
      });
      const provider = await providerFor(mockClient, mockFs);

      await provider.createWorkspace(
        PROJECT_ROOT,
        "review-pr-42",
        "origin/main",
        "origin/feature-login"
      );

      expect(mockClient).toHaveBranchConfig(PROJECT_ROOT, "review-pr-42", "remote", "origin");
      expect(mockClient).toHaveBranchConfig(
        PROJECT_ROOT,
        "review-pr-42",
        "merge",
        "refs/heads/feature-login"
      );
    });

    it("handles multi-segment branch names in tracking ref", async () => {
      const mockClient = gitRepo({
        branches: ["main", "review-pr-99"],
        remoteBranches: ["origin/feature/nested/branch"],
        currentBranch: "main",
      });
      const provider = await providerFor(mockClient, mockFs);

      await provider.createWorkspace(
        PROJECT_ROOT,
        "review-pr-99",
        "origin/main",
        "origin/feature/nested/branch"
      );

      expect(mockClient).toHaveBranchConfig(PROJECT_ROOT, "review-pr-99", "remote", "origin");
      expect(mockClient).toHaveBranchConfig(
        PROJECT_ROOT,
        "review-pr-99",
        "merge",
        "refs/heads/feature/nested/branch"
      );
    });

    it("throws when tracking ref is not a known remote branch", async () => {
      const mockClient = gitRepo(MAIN_ONLY);
      const provider = await providerFor(mockClient, mockFs);

      await expect(
        provider.createWorkspace(PROJECT_ROOT, "review-pr-42", "main", "origin/nonexistent")
      ).rejects.toThrow(WorkspaceError);
      await expect(
        provider.createWorkspace(PROJECT_ROOT, "review-pr-42", "main", "origin/nonexistent")
      ).rejects.toThrow(/not a known remote branch/);
    });
  });

  describe("removeWorkspace", () => {
    it("removes workspace without deleting branch", async () => {
      const worktreePath = new Path(
        testPath("/home/user/app-data/projects/my-repo-abc12345/workspaces/feature-x").toNative()
      );
      const mockClient = gitRepo({
        branches: ["main", "feature-x"],
        currentBranch: "main",
        worktrees: [{ name: "feature-x", path: worktreePath.toString(), branch: "feature-x" }],
      });
      const provider = await providerFor(mockClient, mockFs);

      const result = await provider.removeWorkspace(PROJECT_ROOT, worktreePath, false);

      expect(result.workspaceRemoved).toBe(true);
      expect(result.baseDeleted).toBe(false);
      expect(mockClient).not.toHaveWorktree(PROJECT_ROOT, worktreePath);
      // Branch should still exist
      expect(mockClient).toHaveBranch(PROJECT_ROOT, "feature-x");
    });

    it("removes workspace and deletes branch when requested", async () => {
      const worktreePath = new Path(
        testPath("/home/user/app-data/projects/my-repo-abc12345/workspaces/feature-x").toNative()
      );
      const mockClient = gitRepo({
        branches: ["main", "feature-x"],
        currentBranch: "main",
        worktrees: [{ name: "feature-x", path: worktreePath.toString(), branch: "feature-x" }],
      });
      const provider = await providerFor(mockClient, mockFs);

      const result = await provider.removeWorkspace(PROJECT_ROOT, worktreePath, true);

      expect(result.workspaceRemoved).toBe(true);
      expect(result.baseDeleted).toBe(true);
      expect(mockClient).not.toHaveBranch(PROJECT_ROOT, "feature-x");
    });

    it("throws WorkspaceError when trying to remove main worktree", async () => {
      const mockClient = gitRepo(MAIN_ONLY);
      const provider = await providerFor(mockClient, mockFs);

      await expect(provider.removeWorkspace(PROJECT_ROOT, PROJECT_ROOT, false)).rejects.toThrow(
        WorkspaceError
      );
    });

    it("leaves branches untouched when a detached workspace matches no branch", async () => {
      const worktreePath = new Path(
        testPath("/home/user/app-data/projects/my-repo-abc12345/workspaces/detached").toNative()
      );
      const mockClient = gitRepo({
        branches: ["main"],
        currentBranch: "main",
        worktrees: [{ name: "detached", path: worktreePath.toString(), branch: null }],
      });
      const provider = await providerFor(mockClient, mockFs);

      const result = await provider.removeWorkspace(PROJECT_ROOT, worktreePath, true);

      expect(result.workspaceRemoved).toBe(true);
      expect(mockClient).toHaveBranch(PROJECT_ROOT, "main");
    });

    it("deletes the branch of a detached workspace", async () => {
      // A rebase that stops on a conflict leaves HEAD detached, so the worktree
      // reports no branch. The branch name is still recoverable from the directory,
      // and skipping it here orphaned the branch with no error reported.
      const worktreePath = new Path(
        testPath("/home/user/app-data/projects/my-repo-abc12345/workspaces/feature-x").toNative()
      );
      const mockClient = gitRepo({
        branches: ["main", "feature-x"],
        currentBranch: "main",
        worktrees: [{ name: "feature-x", path: worktreePath.toString(), branch: null }],
      });
      const provider = await providerFor(mockClient, mockFs);

      const result = await provider.removeWorkspace(PROJECT_ROOT, worktreePath, true);

      expect(result.workspaceRemoved).toBe(true);
      expect(result.baseDeleted).toBe(true);
      expect(mockClient).not.toHaveBranch(PROJECT_ROOT, "feature-x");
    });

    it("returns success when worktree already removed (idempotent)", async () => {
      const worktreePath = new Path(
        testPath("/home/user/app-data/projects/my-repo-abc12345/workspaces/feature-x").toNative()
      );
      // Worktree is NOT in the list - already removed
      const mockClient = gitRepo({
        branches: ["main"],
        currentBranch: "main",
        // No worktrees
      });

      const provider = await providerFor(mockClient, mockFs);

      // Should NOT throw - returns success (worktree already gone)
      const result = await provider.removeWorkspace(PROJECT_ROOT, worktreePath, false);

      expect(result.workspaceRemoved).toBe(true);
    });

    it("deletes branch on retry when worktree already unregistered", async () => {
      const worktreePath = new Path(
        testPath("/home/user/app-data/projects/my-repo-abc12345/workspaces/feature-x").toNative()
      );
      // Worktree is NOT in the list - already unregistered from previous attempt
      // But branch still exists
      const mockClient = gitRepo({
        branches: ["main", "feature-x"],
        currentBranch: "main",
        // No worktrees
      });

      const provider = await providerFor(mockClient, mockFs);

      const result = await provider.removeWorkspace(PROJECT_ROOT, worktreePath, true);

      expect(result.workspaceRemoved).toBe(true);
      expect(result.baseDeleted).toBe(true);
      // Branch name extracted from path basename
      expect(mockClient).not.toHaveBranch(PROJECT_ROOT, "feature-x");
    });

    it("returns success when branch already deleted (idempotent)", async () => {
      const worktreePath = new Path(
        testPath("/home/user/app-data/projects/my-repo-abc12345/workspaces/feature-x").toNative()
      );
      const mockClient = gitRepo({
        branches: ["main", "feature-x"],
        currentBranch: "main",
        worktrees: [{ name: "feature-x", path: worktreePath.toString(), branch: "feature-x" }],
      });

      const provider = await providerFor(mockClient, mockFs);

      // First call - actually removes
      const result1 = await provider.removeWorkspace(PROJECT_ROOT, worktreePath, true);
      expect(result1.workspaceRemoved).toBe(true);
      expect(result1.baseDeleted).toBe(true);

      // Second call - idempotent, returns success without operations
      const result2 = await provider.removeWorkspace(PROJECT_ROOT, worktreePath, true);
      expect(result2.workspaceRemoved).toBe(true);
      expect(result2.baseDeleted).toBe(true); // Branch already deleted, treat as success
    });

    it("forgets a removed workspace's metadata", async () => {
      const worktreePath = new Path(
        testPath("/home/user/app-data/projects/my-repo-abc12345/workspaces/feature-x").toNative()
      );
      const fs = createFileSystemMock();
      const mockClient = gitRepo(
        {
          branches: ["main", "feature-x"],
          currentBranch: "main",
          worktrees: [{ name: "feature-x", path: worktreePath.toString(), branch: "feature-x" }],
        },
        fs
      );
      const provider = await providerFor(mockClient, fs);
      await provider.discover(PROJECT_ROOT);
      await provider.setMetadata(worktreePath, "note", "WIP feature");

      await provider.removeWorkspace(PROJECT_ROOT, worktreePath, false);

      expect(mockClient).toHaveBranch(PROJECT_ROOT, "feature-x");
      await expect(provider.getMetadata(worktreePath)).rejects.toThrow(WorkspaceError);
    });
  });

  describe("isDirty", () => {
    it("returns false for clean workspace", async () => {
      const mockClient = gitRepo({
        branches: ["main", "feature-x"],
        currentBranch: "main",
        worktrees: [
          {
            name: "feature-x",
            path: testPath(
              "/home/user/app-data/projects/my-repo-abc12345/workspaces/feature-x"
            ).toNative(),
            branch: "feature-x",
            isDirty: false,
          },
        ],
      });
      const provider = await providerFor(mockClient, mockFs);

      const dirty = await provider.isDirty(
        new Path(
          testPath("/home/user/app-data/projects/my-repo-abc12345/workspaces/feature-x").toNative()
        )
      );

      expect(dirty).toBe(false);
    });

    it("returns true when workspace has modified files", async () => {
      const mockClient = gitRepo({
        branches: ["main", "feature-x"],
        currentBranch: "main",
        worktrees: [
          {
            name: "feature-x",
            path: testPath(
              "/home/user/app-data/projects/my-repo-abc12345/workspaces/feature-x"
            ).toNative(),
            branch: "feature-x",
            isDirty: true,
          },
        ],
      });
      const provider = await providerFor(mockClient, mockFs);

      const dirty = await provider.isDirty(
        new Path(
          testPath("/home/user/app-data/projects/my-repo-abc12345/workspaces/feature-x").toNative()
        )
      );

      expect(dirty).toBe(true);
    });

    it("returns true when main worktree is dirty", async () => {
      const mockClient = gitRepo({
        branches: ["main"],
        currentBranch: "main",
        mainIsDirty: true,
      });
      const provider = await providerFor(mockClient, mockFs);

      const dirty = await provider.isDirty(PROJECT_ROOT);

      expect(dirty).toBe(true);
    });
  });

  describe("countUnmergedCommits", () => {
    it("returns count when base is in metadata", async () => {
      const mockClient = gitRepo({
        branches: ["main", "feature-x"],
        currentBranch: "main",
        worktrees: [
          {
            name: "feature-x",
            path: testPath(
              "/home/user/app-data/projects/my-repo-abc12345/workspaces/feature-x"
            ).toNative(),
            branch: "feature-x",
            unmergedCommits: 5,
          },
        ],
        branchConfigs: { "feature-x": { "codehydra.base": "main" } },
      });
      const provider = await providerFor(mockClient, mockFs);
      const wsPath = new Path(
        testPath("/home/user/app-data/projects/my-repo-abc12345/workspaces/feature-x").toNative()
      );
      provider.ensureWorkspaceRegistered(wsPath, PROJECT_ROOT);

      const count = await provider.countUnmergedCommits(wsPath);

      expect(count).toBe(5);
    });

    it("returns 0 for detached HEAD", async () => {
      const mockClient = gitRepo({
        branches: ["main"],
        currentBranch: "main",
        worktrees: [
          {
            name: "detached",
            path: testPath(
              "/home/user/app-data/projects/my-repo-abc12345/workspaces/detached"
            ).toNative(),
            branch: null,
          },
        ],
      });
      const provider = await providerFor(mockClient, mockFs);
      const wsPath = new Path(
        testPath("/home/user/app-data/projects/my-repo-abc12345/workspaces/detached").toNative()
      );
      provider.ensureWorkspaceRegistered(wsPath, PROJECT_ROOT);

      const count = await provider.countUnmergedCommits(wsPath);

      expect(count).toBe(0);
    });

    it("returns 0 when workspace is not registered", async () => {
      const mockClient = gitRepo(MAIN_ONLY);
      const provider = await providerFor(mockClient, mockFs);

      const count = await provider.countUnmergedCommits(testPath("/nonexistent"));

      expect(count).toBe(0);
    });

    it("falls back to defaultBase when no base in metadata", async () => {
      const mockClient = gitRepo({
        branches: ["main", "feature-x"],
        remoteBranches: ["origin/main"],
        currentBranch: "main",
        worktrees: [
          {
            name: "feature-x",
            path: testPath(
              "/home/user/app-data/projects/my-repo-abc12345/workspaces/feature-x"
            ).toNative(),
            branch: "feature-x",
            unmergedCommits: 2,
          },
        ],
      });
      const provider = await providerFor(mockClient, mockFs);
      const wsPath = new Path(
        testPath("/home/user/app-data/projects/my-repo-abc12345/workspaces/feature-x").toNative()
      );
      provider.ensureWorkspaceRegistered(wsPath, PROJECT_ROOT);

      const count = await provider.countUnmergedCommits(wsPath);

      expect(count).toBe(2);
    });
  });

  describe("defaultBase", () => {
    it("returns the remote default branch recorded in the origin HEAD symref", async () => {
      const mockClient = gitRepo({
        branches: [],
        remoteBranches: ["origin/develop", "origin/main"],
        remotes: ["origin"],
        remoteHeads: { origin: "develop" },
        currentBranch: null,
      });
      const provider = await providerFor(mockClient, mockFs);

      const result = await provider.defaultBase(PROJECT_ROOT);

      expect(result).toBe("origin/develop");
    });

    it("returns the local branch when the symref default has no remote-tracking entry", async () => {
      const mockClient = gitRepo({
        branches: ["develop", "feature"],
        remotes: ["origin"],
        remoteHeads: { origin: "develop" },
        currentBranch: "feature",
      });
      const provider = await providerFor(mockClient, mockFs);

      const result = await provider.defaultBase(PROJECT_ROOT);

      expect(result).toBe("develop");
    });

    it("skips a stale symref pointing at a branch missing from the base list", async () => {
      const mockClient = gitRepo({
        branches: [],
        remoteBranches: ["origin/main"],
        remotes: ["origin"],
        // Stale: remote renamed master -> main, symref not yet updated
        remoteHeads: { origin: "master" },
        currentBranch: null,
        headBranch: null,
      });
      const provider = await providerFor(mockClient, mockFs);

      const result = await provider.defaultBase(PROJECT_ROOT);

      expect(result).toBe("origin/main");
    });

    it("falls back to the repo HEAD symref when no remote HEAD symref exists (bare clone)", async () => {
      const mockClient = gitRepo({
        branches: [],
        remoteBranches: ["origin/develop", "origin/feature"],
        remotes: ["origin"],
        // Bare clone predating set-head: HEAD dangles but names the clone-time default
        currentBranch: null,
        headBranch: "develop",
      });
      const provider = await providerFor(mockClient, mockFs);

      const result = await provider.defaultBase(PROJECT_ROOT);

      expect(result).toBe("origin/develop");
    });

    it("falls back to the checked-out branch for a local-only repo without main/master", async () => {
      const mockClient = gitRepo({
        branches: ["develop", "feature"],
        currentBranch: "develop",
      });
      const provider = await providerFor(mockClient, mockFs);

      const result = await provider.defaultBase(PROJECT_ROOT);

      expect(result).toBe("develop");
    });

    it("reflects the remote default after updateBases heals a missing symref", async () => {
      const mockClient = gitRepo({
        branches: [],
        remoteBranches: ["origin/develop", "origin/master"],
        remotes: ["origin"],
        serverDefaultBranch: "develop",
        currentBranch: null,
        headBranch: null,
      });
      const provider = await providerFor(mockClient, mockFs);

      // Before refresh: no symref answer, legacy fallback picks origin/master
      expect(await provider.defaultBase(PROJECT_ROOT)).toBe("origin/master");

      // Refresh fetches and runs set-head, recording the server's actual default
      await provider.updateBases(PROJECT_ROOT);

      expect(await provider.defaultBase(PROJECT_ROOT)).toBe("origin/develop");
    });

    it("prefers origin/main over local main", async () => {
      const mockClient = gitRepo({
        branches: ["main", "feature"],
        remoteBranches: ["origin/main"],
        remotes: ["origin"],
        currentBranch: "main",
      });
      const provider = await providerFor(mockClient, mockFs);

      const result = await provider.defaultBase(PROJECT_ROOT);

      expect(result).toBe("origin/main");
    });

    it("returns local main when origin/main does not exist", async () => {
      const mockClient = gitRepo({
        branches: ["main", "feature"],
        currentBranch: "main",
      });
      const provider = await providerFor(mockClient, mockFs);

      const result = await provider.defaultBase(PROJECT_ROOT);

      expect(result).toBe("main");
    });

    it("prefers origin/master over local master when no main exists", async () => {
      const mockClient = gitRepo({
        branches: ["master", "feature"],
        remoteBranches: ["origin/master"],
        remotes: ["origin"],
        currentBranch: "master",
      });
      const provider = await providerFor(mockClient, mockFs);

      const result = await provider.defaultBase(PROJECT_ROOT);

      expect(result).toBe("origin/master");
    });

    it("returns local master when only master exists (no main or remotes)", async () => {
      const mockClient = gitRepo({
        branches: ["master", "feature"],
        currentBranch: "master",
      });
      const provider = await providerFor(mockClient, mockFs);

      const result = await provider.defaultBase(PROJECT_ROOT);

      expect(result).toBe("master");
    });

    it("returns origin/main when both main and master exist", async () => {
      const mockClient = gitRepo({
        branches: ["master", "main", "feature"],
        remoteBranches: ["origin/main", "origin/master"],
        remotes: ["origin"],
        currentBranch: "main",
      });
      const provider = await providerFor(mockClient, mockFs);

      const result = await provider.defaultBase(PROJECT_ROOT);

      expect(result).toBe("origin/main");
    });

    it("returns undefined when no symref answer exists and neither main nor master exists", async () => {
      const mockClient = gitRepo({
        branches: ["feature", "develop"],
        currentBranch: "feature",
        headBranch: null,
      });
      const provider = await providerFor(mockClient, mockFs);

      const result = await provider.defaultBase(PROJECT_ROOT);

      expect(result).toBeUndefined();
    });
  });

  describe("cleanupOrphanedWorkspaces", () => {
    it("keeps metadata for an existing branch that has no worktree", async () => {
      // A worktree removed outside CodeHydra leaves this shape; the branch may
      // still hold unmerged work, so its metadata must survive.
      const mockClient = gitRepo({
        branches: ["main", "feature-x"],
        currentBranch: "main",
        worktrees: [],
        branchConfigs: { "feature-x": { "codehydra.base": "main" } },
      });
      const spyFs = createSpyFileSystemBoundary({
        entries: { [WORKSPACES_DIR.toString()]: directory() },
      });
      const provider = await providerFor(mockClient, spyFs);

      await provider.cleanupOrphanedWorkspaces(PROJECT_ROOT);

      expect(mockClient).toHaveBranch(PROJECT_ROOT, "feature-x");
      const remaining = await mockClient.getGitConfig(PROJECT_ROOT, {
        regex: `^branch\\..*\\.codehydra\\.`,
      });
      expect(remaining.size).toBe(1);
    });

    it("removes orphaned directories", async () => {
      const mockClient = gitRepo({
        branches: ["main", "feature-x"],
        currentBranch: "main",
        worktrees: [
          {
            name: "feature-x",
            path: projPath(new Path(WORKSPACES_DIR, "feature-x").toString()),
            branch: "feature-x",
          },
        ],
      });
      // Mock fs with registered worktree and an orphan
      const spyFs = createSpyFileSystemBoundary({
        entries: {
          [WORKSPACES_DIR.toString()]: directory(),
          [new Path(WORKSPACES_DIR, "feature-x").toString()]: directory(),
          [new Path(WORKSPACES_DIR, "orphan-workspace").toString()]: directory(),
        },
      });
      const provider = await providerFor(mockClient, spyFs);

      const result = await provider.cleanupOrphanedWorkspaces(PROJECT_ROOT);

      expect(result.removedCount).toBe(1);
      expect(result.failedPaths).toHaveLength(0);
      expect(spyFs.rm).toHaveBeenCalledWith(new Path(WORKSPACES_DIR, "orphan-workspace"), {
        recursive: true,
        force: true,
      });
    });

    it("skips registered workspaces", async () => {
      const mockClient = gitRepo({
        branches: ["main", "feature-x"],
        currentBranch: "main",
        worktrees: [
          {
            name: "feature-x",
            path: projPath(new Path(WORKSPACES_DIR, "feature-x").toString()),
            branch: "feature-x",
          },
        ],
      });
      const spyFs = createSpyFileSystemBoundary({
        entries: {
          [WORKSPACES_DIR.toString()]: directory(),
          [new Path(WORKSPACES_DIR, "feature-x").toString()]: directory(),
        },
      });
      const provider = await providerFor(mockClient, spyFs);

      const result = await provider.cleanupOrphanedWorkspaces(PROJECT_ROOT);

      expect(result.removedCount).toBe(0);
      expect(spyFs.rm).not.toHaveBeenCalled();
    });

    it("skips symlinks", async () => {
      const mockClient = gitRepo(MAIN_ONLY);
      const spyFs = createSpyFileSystemBoundary({
        entries: {
          [WORKSPACES_DIR.toString()]: directory(),
          [new Path(WORKSPACES_DIR, "symlink-entry").toString()]: symlink(
            testPath("/target").toNative()
          ),
        },
      });
      const provider = await providerFor(mockClient, spyFs);

      const result = await provider.cleanupOrphanedWorkspaces(PROJECT_ROOT);

      expect(result.removedCount).toBe(0);
      expect(spyFs.rm).not.toHaveBeenCalled();
    });

    it("skips files", async () => {
      const mockClient = gitRepo(MAIN_ONLY);
      const spyFs = createSpyFileSystemBoundary({
        entries: {
          [WORKSPACES_DIR.toString()]: directory(),
          [new Path(WORKSPACES_DIR, "some-file.txt").toString()]: file(""),
        },
      });
      const provider = await providerFor(mockClient, spyFs);

      const result = await provider.cleanupOrphanedWorkspaces(PROJECT_ROOT);

      expect(result.removedCount).toBe(0);
      expect(spyFs.rm).not.toHaveBeenCalled();
    });

    it("validates paths stay within workspacesDir", async () => {
      const mockClient = gitRepo(MAIN_ONLY);
      const spyFs = createSpyFileSystemBoundary({
        entries: {
          [WORKSPACES_DIR.toString()]: directory(),
        },
      });
      // Manually add an entry with a suspicious name using setEntry
      spyFs.$.setEntry(new Path(WORKSPACES_DIR, "../../../etc"), directory());

      const provider = await providerFor(mockClient, spyFs);

      const result = await provider.cleanupOrphanedWorkspaces(PROJECT_ROOT);

      expect(result.removedCount).toBe(0);
      expect(spyFs.rm).not.toHaveBeenCalled();
    });

    it("returns CleanupResult with counts", async () => {
      const mockClient = gitRepo(MAIN_ONLY);
      const spyFs = createSpyFileSystemBoundary({
        entries: {
          [WORKSPACES_DIR.toString()]: directory(),
          [new Path(WORKSPACES_DIR, "orphan-1").toString()]: directory(),
          [new Path(WORKSPACES_DIR, "orphan-2").toString()]: directory(),
        },
      });
      const provider = await providerFor(mockClient, spyFs);

      const result = await provider.cleanupOrphanedWorkspaces(PROJECT_ROOT);

      expect(result.removedCount).toBe(2);
      expect(result.failedPaths).toHaveLength(0);
    });

    it("handles missing workspacesDir", async () => {
      const mockClient = gitRepo(MAIN_ONLY);
      // Empty mock - no workspacesDir means readdir throws ENOENT
      const mockFsNotFound = createFileSystemMock();
      const provider = await providerFor(mockClient, mockFsNotFound);

      const result = await provider.cleanupOrphanedWorkspaces(PROJECT_ROOT);

      expect(result.removedCount).toBe(0);
      expect(result.failedPaths).toHaveLength(0);
    });

    it("handles empty workspacesDir", async () => {
      const mockClient = gitRepo(MAIN_ONLY);
      // Workspaces dir exists but is empty
      const mockFsEmpty = createFileSystemMock({
        entries: {
          [WORKSPACES_DIR.toString()]: directory(),
        },
      });
      const provider = await providerFor(mockClient, mockFsEmpty);

      const result = await provider.cleanupOrphanedWorkspaces(PROJECT_ROOT);

      expect(result.removedCount).toBe(0);
      expect(result.failedPaths).toHaveLength(0);
    });

    it("normalizes paths when comparing", async () => {
      // Worktree path has a trailing separator - Path normalizes it automatically.
      // Native, with the OS separator, because that is what `git worktree list` prints.
      const mockClient = gitRepo({
        branches: ["main", "feature-x"],
        currentBranch: "main",
        worktrees: [
          {
            name: "feature-x",
            path: new Path(WORKSPACES_DIR, "feature-x").toNative() + sep,
            branch: "feature-x",
          },
        ],
      });
      const spyFs = createSpyFileSystemBoundary({
        entries: {
          [WORKSPACES_DIR.toString()]: directory(),
          [new Path(WORKSPACES_DIR, "feature-x").toString()]: directory(),
        },
      });
      const provider = await providerFor(mockClient, spyFs);

      const result = await provider.cleanupOrphanedWorkspaces(PROJECT_ROOT);

      // Should NOT delete because it matches registered worktree
      expect(result.removedCount).toBe(0);
      expect(spyFs.rm).not.toHaveBeenCalled();
    });
  });

  describe("setMetadata", () => {
    it("writes the worktree's metadata file, not git config", async () => {
      const worktreePath = new Path(
        testPath("/home/user/app-data/projects/my-repo-abc12345/workspaces/feature-x").toNative()
      );
      const fs = createFileSystemMock();
      const mockClient = gitRepo(
        {
          branches: ["main", "feature-x"],
          currentBranch: "main",
          worktrees: [{ name: "feature-x", path: worktreePath.toString(), branch: "feature-x" }],
        },
        fs
      );
      const provider = await providerFor(mockClient, fs);
      await provider.discover(PROJECT_ROOT);

      await provider.setMetadata(worktreePath, "note", "WIP feature");
      await provider.setMetadata(worktreePath, "hibernated", "true");
      await provider.setMetadata(worktreePath, "agent.pending-prompt", "{}");

      expect(
        await readMetadataFile(fs, new Path(PROJECT_ROOT, ".git", "worktrees", "feature-x"))
      ).toEqual({
        version: 1,
        internal: { "agent.pending-prompt": "{}" },
        protected: { hibernated: "true", name: "feature-x" },
        public: { note: "WIP feature" },
      });
      expect(await mockClient.getGitConfig(PROJECT_ROOT, { regex: "codehydra" })).toEqual(
        new Map()
      );
    });

    it("works on a detached HEAD", async () => {
      const worktreePath = new Path(
        testPath("/home/user/app-data/projects/my-repo-abc12345/workspaces/feature-x").toNative()
      );
      const fs = createFileSystemMock();
      const mockClient = gitRepo(
        {
          branches: ["main", "feature-x"],
          currentBranch: "main",
          worktrees: [{ name: "feature-x", path: worktreePath.toString(), branch: null }],
        },
        fs
      );
      const provider = await providerFor(mockClient, fs);
      await provider.discover(PROJECT_ROOT);

      await provider.setMetadata(worktreePath, "hibernated", "true");

      expect(await provider.getMetadata(worktreePath)).toEqual({
        hibernated: "true",
        name: "feature-x",
      });
    });
  });

  describe("legacy git config migration", () => {
    const FEATURE_PATH = new Path(
      testPath("/home/user/app-data/projects/my-repo-abc12345/workspaces/feature-x").toNative()
    );
    const FEATURE_GIT_DIR = new Path(PROJECT_ROOT, ".git", "worktrees", "feature-x");

    function legacyRepo(
      fs: ReturnType<typeof createFileSystemMock>,
      extra: {
        branches?: readonly string[];
        worktrees?: readonly { name: string; path: string; branch: string | null }[];
        branchConfigs?: Record<string, Record<string, string>>;
        featureBranch?: string;
      } = {}
    ) {
      const featureBranch = extra.featureBranch ?? "feature-x";
      return gitRepo(
        {
          branches: ["main", featureBranch, ...(extra.branches ?? [])],
          currentBranch: "main",
          worktrees: [
            { name: "feature-x", path: FEATURE_PATH.toString(), branch: featureBranch },
            ...(extra.worktrees ?? []),
          ],
          branchConfigs: extra.branchConfigs ?? {},
        },
        fs
      );
    }

    it("moves a branch's config into its worktree's file, sorted by tier, and drops the config", async () => {
      const fs = createFileSystemMock();
      const client = legacyRepo(fs, {
        branchConfigs: {
          "feature-x": {
            "codehydra.base": "main",
            "codehydra.title": "Login flow",
            "codehydra.tags.new": "{}",
            "codehydra.agent": "claude",
            "codehydra.agent.pending-prompt": "{}",
          },
        },
      });
      const provider = await providerFor(client, fs);

      const [workspace] = await provider.discover(PROJECT_ROOT);

      expect(workspace?.metadata).toEqual({
        base: "main",
        title: "Login flow",
        "tags.new": "{}",
        agent: "claude",
        "agent.pending-prompt": "{}",
        name: "feature-x",
      });
      expect(await readMetadataFile(fs, FEATURE_GIT_DIR)).toEqual({
        version: 1,
        internal: { "agent.pending-prompt": "{}" },
        protected: { base: "main", agent: "claude", name: "feature-x" },
        public: { title: "Login flow", "tags.new": "{}" },
      });
      expect(await client.getGitConfig(PROJECT_ROOT, { regex: "codehydra" })).toEqual(new Map());
    });

    it("pins the default agent on a migrated workspace that has none recorded", async () => {
      const fs = createFileSystemMock();
      const client = legacyRepo(fs, {
        branches: ["pinned"],
        worktrees: [
          {
            name: "pinned",
            path: new Path(FEATURE_PATH.dirname, "pinned").toString(),
            branch: "pinned",
          },
        ],
        branchConfigs: { pinned: { "codehydra.agent": "opencode" } },
      });
      const provider = new GitWorktreeProvider(client, fs, worktreeLogger, () => ({
        agent: "claude",
      }));
      await provider.validateRepository(PROJECT_ROOT);
      provider.registerProject(PROJECT_ROOT, WORKSPACES_DIR);

      await provider.discover(PROJECT_ROOT);

      expect(await provider.getMetadata(FEATURE_PATH)).toEqual({
        agent: "claude",
        name: "feature-x",
      });
      expect((await readMetadataFile(fs, FEATURE_GIT_DIR))?.protected).toEqual({
        agent: "claude",
        name: "feature-x",
      });
      expect(await provider.getMetadata(new Path(FEATURE_PATH.dirname, "pinned"))).toEqual({
        agent: "opencode",
        name: "pinned",
      });
    });

    it("leaves a workspace that already has a file alone", async () => {
      const fs = createFileSystemMock();
      const client = legacyRepo(fs);
      await (await providerFor(client, fs)).discover(PROJECT_ROOT);

      const provider = new GitWorktreeProvider(client, fs, worktreeLogger, () => ({
        agent: "claude",
      }));
      await provider.validateRepository(PROJECT_ROOT);
      provider.registerProject(PROJECT_ROOT, WORKSPACES_DIR);
      await provider.discover(PROJECT_ROOT);

      // Only the name is recorded: a workspace from before names were kept gets one
      expect(await provider.getMetadata(FEATURE_PATH)).toEqual({ name: "feature-x" });
    });

    it("writes an empty file for a workspace without config", async () => {
      const fs = createFileSystemMock();
      const provider = await providerFor(legacyRepo(fs), fs);

      await provider.discover(PROJECT_ROOT);

      expect(await readMetadataFile(fs, FEATURE_GIT_DIR)).toEqual({
        version: 1,
        internal: {},
        protected: { name: "feature-x" },
        public: {},
      });
    });

    it("keeps the config of a live branch that is not one of its workspaces", async () => {
      // Another CodeHydra instance (a dev build, another workspaces folder) may
      // own that worktree and still read its config.
      const fs = createFileSystemMock();
      const client = legacyRepo(fs, {
        branches: ["theirs"],
        worktrees: [{ name: "theirs", path: "/elsewhere/theirs", branch: "theirs" }],
        branchConfigs: { theirs: { "codehydra.title": "Not ours" } },
      });
      const provider = await providerFor(client, fs);

      await provider.discover(PROJECT_ROOT);

      expect(await client.getGitConfig(PROJECT_ROOT, { regex: "codehydra" })).toEqual(
        new Map([["branch.theirs.codehydra.title", "Not ours"]])
      );
    });

    it("drops the config of a branch that no longer exists", async () => {
      // `git branch -D` drops the branch but not our [branch "<n>.codehydra"] sections.
      const fs = createFileSystemMock();
      const client = legacyRepo(fs, {
        branchConfigs: { "long-gone": { "codehydra.base": "main", "codehydra.tags.new": "{}" } },
      });
      const provider = await providerFor(client, fs);

      await provider.discover(PROJECT_ROOT);

      expect(await client.getGitConfig(PROJECT_ROOT, { regex: "codehydra" })).toEqual(new Map());
    });

    it("keeps the config when the file cannot be written, and still serves the metadata", async () => {
      const fs = createFileSystemMock();
      const client = legacyRepo(fs, {
        branchConfigs: { "feature-x": { "codehydra.base": "main" } },
      });
      vi.spyOn(fs, "writeFile").mockRejectedValue(new Error("disk full"));
      const provider = await providerFor(client, fs);

      await provider.discover(PROJECT_ROOT);

      expect(await provider.getMetadata(FEATURE_PATH)).toEqual({ base: "main", name: "feature-x" });
      expect(await client.getGitConfig(PROJECT_ROOT, { regex: "codehydra" })).toEqual(
        new Map([["branch.feature-x.codehydra.base", "main"]])
      );
    });

    it("keeps an adoption recorded in config, now in the worktree's file", async () => {
      const fs = createFileSystemMock();
      const client = legacyRepo(fs, {
        branches: ["feature/login"],
        worktrees: [{ name: "repo-login", path: "/code/repo-login", branch: "feature/login" }],
        branchConfigs: { "feature/login": { "codehydra.tags.external": "{}" } },
      });
      const provider = await providerFor(client, fs);

      await provider.discover(PROJECT_ROOT);

      const restarted = await providerFor(
        legacyRepo(fs, {
          branches: ["feature/login"],
          worktrees: [{ name: "repo-login", path: "/code/repo-login", branch: "feature/login" }],
        }),
        fs
      );
      expect((await restarted.discover(PROJECT_ROOT)).map((w) => w.name)).toContain(
        "feature/login"
      );
    });

    it("keeps a workspace's name and metadata across a branch rename", async () => {
      const fs = createFileSystemMock();
      const before = legacyRepo(fs, {
        branchConfigs: { "feature-x": { "codehydra.title": "Login flow" } },
      });
      await (await providerFor(before, fs)).discover(PROJECT_ROOT);

      // `git branch -m feature-x renamed`: same worktree, same git directory
      const after = legacyRepo(fs, { featureBranch: "renamed" });
      const provider = await providerFor(after, fs);
      const [workspace] = await provider.discover(PROJECT_ROOT);

      // The name was recorded on first discovery and is the workspace's identity
      expect(workspace?.name).toBe("feature-x");
      expect(workspace?.branch).toBe("renamed");
      expect(workspace?.metadata).toEqual({ title: "Login flow", name: "feature-x" });
    });
  });

  describe("getMetadata", () => {
    it("returns all metadata keys", async () => {
      const worktreePath = new Path(
        testPath("/home/user/app-data/projects/my-repo-abc12345/workspaces/feature-x").toNative()
      );
      const mockClient = gitRepo({
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
      });
      const provider = await providerFor(mockClient, mockFs);
      await provider.discover(PROJECT_ROOT);

      const metadata = await provider.getMetadata(worktreePath);

      expect(metadata).toEqual({
        base: "develop",
        note: "WIP",
        model: "claude-4",
        name: "feature-x",
      });
    });
  });

  describe("stale worktree handling", () => {
    it("discover() excludes prunable worktrees from results", async () => {
      const mockClient = gitRepo({
        branches: ["main", "valid-branch", "stale-branch"],
        currentBranch: "main",
        worktrees: [
          {
            name: "valid-ws",
            path: testPath(
              "/home/user/app-data/projects/my-repo-abc12345/workspaces/valid-ws"
            ).toNative(),
            branch: "valid-branch",
          },
          {
            name: "stale-ws",
            path: testPath(
              "/home/user/app-data/projects/my-repo-abc12345/workspaces/stale-ws"
            ).toNative(),
            branch: "stale-branch",
            prunable: true,
          },
        ],
        branchConfigs: {
          "valid-branch": { "codehydra.base": "main" },
          "stale-branch": { "codehydra.base": "main" },
        },
      });

      const provider = await providerFor(mockClient, mockFs);

      const discovered = await provider.discover(PROJECT_ROOT);
      expect(discovered).toHaveLength(1);
      expect(discovered[0]?.name).toBe("valid-branch");
    });

    it("discover() calls pruneWorktrees when stale entries exist", async () => {
      const mockClient = gitRepo({
        branches: ["main", "stale-branch"],
        currentBranch: "main",
        worktrees: [
          {
            name: "stale-ws",
            path: testPath(
              "/home/user/app-data/projects/my-repo-abc12345/workspaces/stale-ws"
            ).toNative(),
            branch: "stale-branch",
            prunable: true,
          },
        ],
      });

      const pruneSpy = vi.spyOn(mockClient, "pruneWorktrees");

      const provider = await providerFor(mockClient, mockFs);

      await provider.discover(PROJECT_ROOT);
      expect(pruneSpy).toHaveBeenCalledWith(PROJECT_ROOT);
    });

    it("discover() does not call pruneWorktrees when all entries are healthy", async () => {
      const mockClient = gitRepo({
        branches: ["main", "healthy-branch"],
        currentBranch: "main",
        worktrees: [
          {
            name: "healthy-ws",
            path: testPath(
              "/home/user/app-data/projects/my-repo-abc12345/workspaces/healthy-ws"
            ).toNative(),
            branch: "healthy-branch",
          },
        ],
      });

      const pruneSpy = vi.spyOn(mockClient, "pruneWorktrees");

      const provider = await providerFor(mockClient, mockFs);

      await provider.discover(PROJECT_ROOT);
      expect(pruneSpy).not.toHaveBeenCalled();
    });
  });
});

describe("GitWorktreeProvider bare repository support", () => {
  const PROJECT_ROOT = testPath("/bare-project");
  const WORKSPACES_DIR = testPath("/workspaces");
  const { gitRepo, providerFor } = testProject(PROJECT_ROOT, WORKSPACES_DIR);

  describe("listBases", () => {
    it("returns branches from bare repos as local (git treats them as refs/heads/*)", async () => {
      // In bare repos, branches are stored in refs/heads/* (not refs/remotes/*)
      // so they appear as local branches to git. This is correct git behavior.
      const mockClient = gitRepo({
        branches: ["main", "develop", "feature-x"],
        isBare: true,
        currentBranch: "main",
      });
      const mockFs = createFileSystemMock({
        entries: {
          [WORKSPACES_DIR.toString()]: directory(),
        },
      });

      const provider = await providerFor(mockClient, mockFs);

      const bases = await provider.listBases(PROJECT_ROOT);

      // Branches in bare repos are local refs, so isRemote should be false
      expect(bases.every((b) => !b.isRemote)).toBe(true);
      expect(bases.map((b) => b.name).sort()).toEqual(["develop", "feature-x", "main"]);
    });

    it("returns local and remote branches correctly for regular repos", async () => {
      const mockClient = gitRepo({
        branches: ["main", "develop"],
        remoteBranches: ["origin/main"],
        isBare: false,
        currentBranch: "main",
      });
      const mockFs = createFileSystemMock({
        entries: {
          [WORKSPACES_DIR.toString()]: directory(),
        },
      });

      const provider = await providerFor(mockClient, mockFs);

      const bases = await provider.listBases(PROJECT_ROOT);

      const localBranches = bases.filter((b) => !b.isRemote);
      const remoteBranches = bases.filter((b) => b.isRemote);

      expect(localBranches.map((b) => b.name).sort()).toEqual(["develop", "main"]);
      expect(remoteBranches.map((b) => b.name)).toEqual(["origin/main"]);
    });
  });
});

describe("GitWorktreeProvider isDirty", () => {
  const PROJECT_ROOT = testPath("/project");
  const WORKSPACES_DIR = testPath("/workspaces");
  const WORKSPACE_PATH = testPath("/workspaces/feature-x");
  const { gitRepo, providerFor } = testProject(PROJECT_ROOT, WORKSPACES_DIR);

  it("returns false when the workspace directory no longer exists (deletion race)", async () => {
    // getStatus throws because the worktree isn't a known repo, and the
    // directory is absent from the filesystem — the deleted-workspace race.
    const mockClient = gitRepo(MAIN_ONLY);
    const mockFs = createFileSystemMock({
      entries: { [WORKSPACES_DIR.toString()]: directory() },
    });
    const provider = await providerFor(mockClient, mockFs);

    expect(await provider.isDirty(WORKSPACE_PATH)).toBe(false);
  });

  it("returns false when the directory lingers but its .git is gone (Windows deletion race)", async () => {
    // Worktree removal is not atomic: the directory can survive after `.git` is
    // unlinked (notably on Windows, where a retrying recursive rm removes the
    // small `.git` marker before locked files clear). git then reports "not a
    // git repository" while readdir on the directory still succeeds — this must
    // still be treated as the deletion race, not surfaced as an error.
    const mockClient = gitRepo(MAIN_ONLY);
    const mockFs = createFileSystemMock({
      entries: {
        [WORKSPACES_DIR.toString()]: directory(),
        [WORKSPACE_PATH.toString()]: directory(),
        // `.git` marker absent — leftover working-tree files only.
        [new Path(WORKSPACE_PATH, "src").toString()]: directory(),
      },
    });
    const provider = await providerFor(mockClient, mockFs);

    expect(await provider.isDirty(WORKSPACE_PATH)).toBe(false);
  });

  it("rethrows the git error when the path is still a git worktree", async () => {
    // getStatus fails for a genuine reason but the `.git` marker is present — the
    // error must surface (the delete-preflight dirty check depends on this).
    const mockClient = gitRepo(MAIN_ONLY);
    const mockFs = createFileSystemMock({
      entries: {
        [WORKSPACES_DIR.toString()]: directory(),
        [WORKSPACE_PATH.toString()]: directory(),
        [new Path(WORKSPACE_PATH, ".git").toString()]: file("gitdir: /project/.git/worktrees/x"),
      },
    });
    const provider = await providerFor(mockClient, mockFs);

    await expect(provider.isDirty(WORKSPACE_PATH)).rejects.toThrow();
  });
});
