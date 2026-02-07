// @vitest-environment node
/**
 * Integration tests for ProjectScopedWorkspaceProvider.
 *
 * Test #14: Metadata set via adapter is retrievable via global provider
 * Test #17: unregisterProject cleans up (after dispose, metadata operations fail)
 */

import { describe, it, expect } from "vitest";
import { GitWorktreeProvider } from "./git-worktree-provider";
import { ProjectScopedWorkspaceProvider } from "./project-scoped-provider";
import { createMockGitClient } from "./git-client.state-mock";
import { createFileSystemMock, directory } from "../platform/filesystem.state-mock";
import { SILENT_LOGGER } from "../logging";
import { Path } from "../platform/path";

describe("ProjectScopedWorkspaceProvider integration", () => {
  const PROJECT_ROOT = new Path("/project");
  const WORKSPACES_DIR = new Path("/workspaces");
  const mockFs = createFileSystemMock({
    entries: {
      [WORKSPACES_DIR.toString()]: directory(),
    },
  });

  function createSetup() {
    const mockClient = createMockGitClient({
      repositories: {
        [PROJECT_ROOT.toString()]: {
          branches: ["main"],
          currentBranch: "main",
        },
      },
    });

    const globalProvider = new GitWorktreeProvider(mockClient, mockFs, SILENT_LOGGER);

    const adapter = new ProjectScopedWorkspaceProvider(
      globalProvider,
      PROJECT_ROOT,
      WORKSPACES_DIR
    );

    return { mockClient, globalProvider, adapter };
  }

  describe("adapter delegates to global provider", () => {
    it("discover() returns workspaces created through adapter", async () => {
      const { adapter } = createSetup();

      await adapter.createWorkspace("feature-x", "main");
      const workspaces = await adapter.discover();

      expect(workspaces).toHaveLength(1);
      expect(workspaces[0]?.name).toBe("feature-x");
    });

    it("createWorkspace() delegates with bound projectRoot", async () => {
      const { adapter, mockClient } = createSetup();

      const workspace = await adapter.createWorkspace("feature-x", "main");

      expect(workspace.name).toBe("feature-x");
      expect(workspace.metadata.base).toBe("main");
      expect(mockClient).toHaveBranchConfig(PROJECT_ROOT, "feature-x", "codehydra.base", "main");
    });

    it("listBases() delegates with bound projectRoot", async () => {
      const { adapter } = createSetup();

      const bases = await adapter.listBases();

      expect(bases.length).toBeGreaterThan(0);
      expect(bases.some((b) => b.name === "main")).toBe(true);
    });

    it("removeWorkspace() delegates with bound projectRoot", async () => {
      const { adapter } = createSetup();

      const workspace = await adapter.createWorkspace("feature-x", "main");
      const result = await adapter.removeWorkspace(workspace.path, true);

      expect(result.workspaceRemoved).toBe(true);
      expect(result.baseDeleted).toBe(true);
    });

    it("isMainWorkspace() delegates with bound projectRoot", async () => {
      const { adapter } = createSetup();

      expect(adapter.isMainWorkspace(PROJECT_ROOT)).toBe(true);
      expect(adapter.isMainWorkspace(new Path("/some/other/path"))).toBe(false);
    });

    it("defaultBase() delegates with bound projectRoot", async () => {
      const { adapter } = createSetup();

      const base = await adapter.defaultBase();
      expect(base).toBe("main");
    });

    it("projectRoot property returns the bound project root", () => {
      const { adapter } = createSetup();

      expect(adapter.projectRoot.equals(PROJECT_ROOT)).toBe(true);
    });
  });

  describe("metadata via adapter (#14)", () => {
    it("metadata set via adapter is retrievable via global provider", async () => {
      const { adapter, globalProvider } = createSetup();

      const workspace = await adapter.createWorkspace("feature-x", "main");
      await adapter.setMetadata(workspace.path, "note", "test value");

      // Read via global provider directly
      const metadata = await globalProvider.getMetadata(workspace.path);
      expect(metadata.note).toBe("test value");
      expect(metadata.base).toBe("main");
    });

    it("metadata set via global provider is retrievable via adapter", async () => {
      const { adapter, globalProvider } = createSetup();

      const workspace = await adapter.createWorkspace("feature-x", "main");
      await globalProvider.setMetadata(workspace.path, "tag", "important");

      // Read via adapter
      const metadata = await adapter.getMetadata(workspace.path);
      expect(metadata.tag).toBe("important");
      expect(metadata.base).toBe("main");
    });

    it("metadata survives adapter recreation (same global provider)", async () => {
      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_ROOT.toString()]: {
            branches: ["main"],
            currentBranch: "main",
          },
        },
      });

      const globalProvider = new GitWorktreeProvider(mockClient, mockFs, SILENT_LOGGER);

      // Create workspace with first adapter
      const adapter1 = new ProjectScopedWorkspaceProvider(
        globalProvider,
        PROJECT_ROOT,
        WORKSPACES_DIR
      );
      const workspace = await adapter1.createWorkspace("feature-x", "main");
      await adapter1.setMetadata(workspace.path, "note", "persisted");
      adapter1.dispose();

      // Create second adapter (re-registers project, discovers workspaces)
      const adapter2 = new ProjectScopedWorkspaceProvider(
        globalProvider,
        PROJECT_ROOT,
        WORKSPACES_DIR
      );
      // Re-discover to re-populate workspace registry
      await adapter2.discover();

      const metadata = await adapter2.getMetadata(workspace.path);
      expect(metadata.note).toBe("persisted");
      expect(metadata.base).toBe("main");

      adapter2.dispose();
    });
  });

  describe("unregisterProject cleanup (#17)", () => {
    it("after dispose, metadata operations on its workspaces fail", async () => {
      const { adapter } = createSetup();

      const workspace = await adapter.createWorkspace("feature-x", "main");
      await adapter.setMetadata(workspace.path, "note", "before dispose");

      // Verify metadata works before dispose
      const metadataBefore = await adapter.getMetadata(workspace.path);
      expect(metadataBefore.note).toBe("before dispose");

      // Dispose unregisters the project and its workspaces
      adapter.dispose();

      // After dispose, metadata resolution should fail (workspace not registered)
      await expect(adapter.getMetadata(workspace.path)).rejects.toThrow(/Workspace not registered/);
      await expect(adapter.setMetadata(workspace.path, "note", "after dispose")).rejects.toThrow(
        /Workspace not registered/
      );
    });

    it("dispose is idempotent", () => {
      const { adapter } = createSetup();

      // Should not throw on double dispose
      adapter.dispose();
      adapter.dispose();
    });

    it("unregisterProject cleans up workspace registry entries", async () => {
      const { adapter, globalProvider } = createSetup();

      // Create multiple workspaces
      const ws1 = await adapter.createWorkspace("feature-a", "main");
      const ws2 = await adapter.createWorkspace("feature-b", "main");

      // Verify both work
      await globalProvider.getMetadata(ws1.path);
      await globalProvider.getMetadata(ws2.path);

      // Dispose removes all workspace entries for this project
      adapter.dispose();

      // Both should fail now
      await expect(globalProvider.getMetadata(ws1.path)).rejects.toThrow(
        /Workspace not registered/
      );
      await expect(globalProvider.getMetadata(ws2.path)).rejects.toThrow(
        /Workspace not registered/
      );
    });
  });

  describe("multi-project isolation", () => {
    it("two projects with separate adapters do not interfere", async () => {
      const PROJECT_A = new Path("/project-a");
      const PROJECT_B = new Path("/project-b");
      const WORKSPACES_A = new Path("/workspaces-a");
      const WORKSPACES_B = new Path("/workspaces-b");

      const mockClient = createMockGitClient({
        repositories: {
          [PROJECT_A.toString()]: {
            branches: ["main"],
            currentBranch: "main",
          },
          [PROJECT_B.toString()]: {
            branches: ["main"],
            currentBranch: "main",
          },
        },
      });

      const fsLayer = createFileSystemMock({
        entries: {
          [WORKSPACES_A.toString()]: directory(),
          [WORKSPACES_B.toString()]: directory(),
        },
      });

      const globalProvider = new GitWorktreeProvider(mockClient, fsLayer, SILENT_LOGGER);

      const adapterA = new ProjectScopedWorkspaceProvider(globalProvider, PROJECT_A, WORKSPACES_A);
      const adapterB = new ProjectScopedWorkspaceProvider(globalProvider, PROJECT_B, WORKSPACES_B);

      // Create workspace in each project
      const wsA = await adapterA.createWorkspace("feature-a", "main");
      const wsB = await adapterB.createWorkspace("feature-b", "main");

      // Set metadata independently
      await adapterA.setMetadata(wsA.path, "owner", "alice");
      await adapterB.setMetadata(wsB.path, "owner", "bob");

      // Verify isolation
      const metaA = await adapterA.getMetadata(wsA.path);
      const metaB = await adapterB.getMetadata(wsB.path);
      expect(metaA.owner).toBe("alice");
      expect(metaB.owner).toBe("bob");

      // Disposing project A should not affect project B
      adapterA.dispose();

      await expect(adapterA.getMetadata(wsA.path)).rejects.toThrow(/Workspace not registered/);
      const metaBAfter = await adapterB.getMetadata(wsB.path);
      expect(metaBAfter.owner).toBe("bob");

      adapterB.dispose();
    });
  });
});
