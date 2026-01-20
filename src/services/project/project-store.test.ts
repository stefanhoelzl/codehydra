// @vitest-environment node
/**
 * Unit tests for ProjectStore.
 * Tests business logic with mock FileSystemLayer.
 */

import { describe, it, expect, vi } from "vitest";
import { ProjectStore } from "./project-store";
import { CURRENT_PROJECT_VERSION } from "./types";
import {
  createFileSystemMock,
  file,
  directory,
  createDirEntry,
} from "../platform/filesystem.state-mock";
import { FileSystemError } from "../errors";
import type { FileSystemLayer, PathLike, MkdirOptions, RmOptions } from "../platform/filesystem";
import { Path } from "../platform/path";

/** Convert PathLike to string for testing */
const pathString = (p: PathLike): string => (typeof p === "string" ? p : p.toString());

/**
 * Create an inline FileSystemLayer mock with vi.fn() for call tracking.
 * Used for tests that need to verify call patterns rather than state outcomes.
 */
function createTrackingMock(
  overrides: Partial<{
    readFile: (path: PathLike) => Promise<string>;
    writeFile: (path: PathLike, content: string) => Promise<void>;
    mkdir: (path: PathLike, options?: MkdirOptions) => Promise<void>;
    readdir: (
      path: PathLike
    ) => Promise<
      readonly { name: string; isDirectory: boolean; isFile: boolean; isSymbolicLink: boolean }[]
    >;
    unlink: (path: PathLike) => Promise<void>;
    rm: (path: PathLike, options?: RmOptions) => Promise<void>;
  }> = {}
): FileSystemLayer {
  return {
    readFile: vi.fn(overrides.readFile ?? (async () => "")),
    writeFile: vi.fn(overrides.writeFile ?? (async () => {})),
    mkdir: vi.fn(overrides.mkdir ?? (async () => {})),
    readdir: vi.fn(overrides.readdir ?? (async () => [])),
    unlink: vi.fn(overrides.unlink ?? (async () => {})),
    rm: vi.fn(overrides.rm ?? (async () => {})),
    copyTree: vi.fn(async () => {}),
    makeExecutable: vi.fn(async () => {}),
    writeFileBuffer: vi.fn(async () => {}),
    symlink: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    mkdtemp: vi.fn(async () => new Path("/tmp/test-000000")),
  };
}

describe("ProjectStore", () => {
  const projectsDir = "/data/projects";

  describe("saveProject", () => {
    it("creates directory and writes config.json with correct structure", async () => {
      // Use behavioral mock - we verify the outcome (file content)
      const mockFs = createFileSystemMock({
        entries: {
          "/data/projects": directory(),
        },
      });

      const store = new ProjectStore(projectsDir, mockFs);
      await store.saveProject("/home/user/projects/my-repo");

      // Find the config.json file that was created
      let configPath: string | undefined;
      for (const [path] of mockFs.$.entries) {
        if (path.includes("config.json") && path.includes("my-repo")) {
          configPath = path;
          break;
        }
      }
      expect(configPath).toBeDefined();

      // Verify content structure (JSON may be formatted with spaces)
      expect(mockFs).toHaveFileContaining(configPath!, `"version": ${CURRENT_PROJECT_VERSION}`);
      expect(mockFs).toHaveFileContaining(configPath!, `"path": "/home/user/projects/my-repo"`);
    });

    it("wraps filesystem errors in ProjectStoreError", async () => {
      // Use tracking mock to simulate mkdir error
      const mockFs = createTrackingMock({
        mkdir: async () => {
          throw new FileSystemError("EACCES", "/data/projects", "Permission denied");
        },
      });

      const store = new ProjectStore(projectsDir, mockFs);

      await expect(store.saveProject("/home/user/projects/my-repo")).rejects.toThrow(
        "Failed to save project"
      );
    });

    it("handles paths with special characters", async () => {
      const mockFs = createFileSystemMock({
        entries: {
          "/data/projects": directory(),
        },
      });

      const store = new ProjectStore(projectsDir, mockFs);
      await store.saveProject("/home/user/projects/my-repo with spaces");

      // Find the config.json file that was created
      let configPath: string | undefined;
      for (const [path] of mockFs.$.entries) {
        if (path.includes("config.json") && path.includes("my-repo with spaces")) {
          configPath = path;
          break;
        }
      }
      expect(configPath).toBeDefined();

      // Verify config content has correct path (JSON may be formatted with spaces)
      expect(mockFs).toHaveFileContaining(
        configPath!,
        `"path": "/home/user/projects/my-repo with spaces"`
      );
    });
  });

  describe("loadAllProjects", () => {
    it("returns empty array when projects directory does not exist", async () => {
      // Empty mock - directory doesn't exist
      const mockFs = createFileSystemMock();

      const store = new ProjectStore(projectsDir, mockFs);
      const projects = await store.loadAllProjects();

      expect(projects).toEqual([]);
    });

    it("returns empty array when projects directory is empty", async () => {
      const mockFs = createFileSystemMock({
        entries: {
          "/data/projects": directory(),
        },
      });

      const store = new ProjectStore(projectsDir, mockFs);
      const projects = await store.loadAllProjects();

      expect(projects).toEqual([]);
    });

    it("loads projects from config.json files", async () => {
      const mockFs = createFileSystemMock({
        entries: {
          "/data/projects": directory(),
          "/data/projects/my-repo-abc12345": directory(),
          "/data/projects/my-repo-abc12345/config.json": file(
            JSON.stringify({
              version: CURRENT_PROJECT_VERSION,
              path: "/home/user/projects/my-repo",
            })
          ),
          "/data/projects/other-repo-def67890": directory(),
          "/data/projects/other-repo-def67890/config.json": file(
            JSON.stringify({
              version: CURRENT_PROJECT_VERSION,
              path: "/home/user/projects/other-repo",
            })
          ),
        },
      });

      const store = new ProjectStore(projectsDir, mockFs);
      const projects = await store.loadAllProjects();

      expect(projects).toContain("/home/user/projects/my-repo");
      expect(projects).toContain("/home/user/projects/other-repo");
      expect(projects).toHaveLength(2);
    });

    it("skips directories without config.json", async () => {
      const mockFs = createFileSystemMock({
        entries: {
          "/data/projects": directory(),
          "/data/projects/valid-project": directory(),
          "/data/projects/valid-project/config.json": file(
            JSON.stringify({
              version: CURRENT_PROJECT_VERSION,
              path: "/home/user/valid-project",
            })
          ),
          "/data/projects/no-config-dir": directory(),
          // Note: no-config-dir has no config.json
        },
      });

      const store = new ProjectStore(projectsDir, mockFs);
      const projects = await store.loadAllProjects();

      expect(projects).toEqual(["/home/user/valid-project"]);
    });

    it("skips entries with malformed JSON", async () => {
      const mockFs = createFileSystemMock({
        entries: {
          "/data/projects": directory(),
          "/data/projects/valid-project": directory(),
          "/data/projects/valid-project/config.json": file(
            JSON.stringify({
              version: CURRENT_PROJECT_VERSION,
              path: "/home/user/valid-project",
            })
          ),
          "/data/projects/malformed-project": directory(),
          "/data/projects/malformed-project/config.json": file("not valid json"),
        },
      });

      const store = new ProjectStore(projectsDir, mockFs);
      const projects = await store.loadAllProjects();

      expect(projects).toEqual(["/home/user/valid-project"]);
    });

    it("skips config.json missing path field", async () => {
      const mockFs = createFileSystemMock({
        entries: {
          "/data/projects": directory(),
          "/data/projects/valid-project": directory(),
          "/data/projects/valid-project/config.json": file(
            JSON.stringify({
              version: CURRENT_PROJECT_VERSION,
              path: "/home/user/valid-project",
            })
          ),
          "/data/projects/missing-path": directory(),
          "/data/projects/missing-path/config.json": file(
            JSON.stringify({ version: CURRENT_PROJECT_VERSION })
          ),
        },
      });

      const store = new ProjectStore(projectsDir, mockFs);
      const projects = await store.loadAllProjects();

      expect(projects).toEqual(["/home/user/valid-project"]);
    });

    it("skips non-directory entries", async () => {
      // Use tracking mock for this test because behavioral mock doesn't support
      // files and symlinks at the same level as directories in readdir
      const mockFs = createTrackingMock({
        readdir: async () => [
          createDirEntry("valid-project", { isDirectory: true }),
          createDirEntry("file.txt", { isFile: true }),
          createDirEntry("symlink", { isSymbolicLink: true }),
        ],
        readFile: async (path) => {
          if (pathString(path).includes("valid-project")) {
            return JSON.stringify({
              version: CURRENT_PROJECT_VERSION,
              path: "/home/user/valid-project",
            });
          }
          throw new FileSystemError("ENOENT", pathString(path), "Not found");
        },
      });

      const store = new ProjectStore(projectsDir, mockFs);
      const projects = await store.loadAllProjects();

      expect(projects).toEqual(["/home/user/valid-project"]);
    });
  });

  describe("removeProject", () => {
    it("removes config.json, workspaces dir, and project dir without recursive flag", async () => {
      const unlinkedPaths: string[] = [];
      const rmCalls: Array<{ path: string; recursive: boolean | undefined }> = [];

      const mockFs = createTrackingMock({
        unlink: async (path) => {
          unlinkedPaths.push(pathString(path));
        },
        rm: async (path, options) => {
          rmCalls.push({ path: pathString(path), recursive: options?.recursive });
        },
      });

      const store = new ProjectStore(projectsDir, mockFs);
      await store.removeProject("/home/user/projects/my-repo");

      // Verify config.json was deleted
      expect(unlinkedPaths).toHaveLength(1);
      expect(unlinkedPaths[0]).toContain("config.json");

      // Verify both workspaces/ and project dir removal were attempted
      // Both should be WITHOUT recursive flag to preserve existing workspaces
      expect(rmCalls).toHaveLength(2);
      expect(rmCalls[0]?.path).toContain("workspaces");
      expect(rmCalls[0]?.recursive).not.toBe(true);
      expect(rmCalls[1]?.recursive).not.toBe(true);
    });

    it("does not throw if project was not saved (ENOENT)", async () => {
      const mockFs = createTrackingMock({
        unlink: async () => {
          throw new FileSystemError("ENOENT", "/path", "Not found");
        },
      });

      const store = new ProjectStore(projectsDir, mockFs);

      // Should not throw
      await expect(
        store.removeProject("/home/user/projects/non-existent")
      ).resolves.toBeUndefined();
    });

    it("preserves directory when workspaces exist (ENOTEMPTY)", async () => {
      const unlinkedPaths: string[] = [];

      const mockFs = createTrackingMock({
        unlink: async (path) => {
          unlinkedPaths.push(pathString(path));
        },
        rm: async () => {
          throw new FileSystemError("ENOTEMPTY", "/path", "Directory not empty");
        },
      });

      const store = new ProjectStore(projectsDir, mockFs);

      // Should not throw - workspaces are intentionally preserved
      await expect(store.removeProject("/home/user/projects/my-repo")).resolves.toBeUndefined();

      // config.json should still be deleted
      expect(unlinkedPaths).toHaveLength(1);
      expect(unlinkedPaths[0]).toContain("config.json");
    });
  });
});
