// @vitest-environment node
/**
 * Unit tests for ProjectStore.
 * Tests business logic with mock FileSystemLayer.
 */

import { describe, it, expect } from "vitest";
import { ProjectStore } from "./project-store";
import { CURRENT_PROJECT_VERSION } from "./types";
import { createMockFileSystemLayer, createDirEntry } from "../platform/filesystem.test-utils";
import { FileSystemError } from "../errors";

describe("ProjectStore", () => {
  const projectsDir = "/data/projects";

  describe("saveProject", () => {
    it("creates directory and writes config.json with correct structure", async () => {
      const writtenFiles: Map<string, string> = new Map();
      const createdDirs: string[] = [];

      const mockFs = createMockFileSystemLayer({
        mkdir: {
          implementation: async (path) => {
            createdDirs.push(path);
          },
        },
        writeFile: {
          implementation: async (path, content) => {
            writtenFiles.set(path, content);
          },
        },
      });

      const store = new ProjectStore(projectsDir, mockFs);
      await store.saveProject("/home/user/projects/my-repo");

      // Verify directory was created with recursive option
      expect(createdDirs.length).toBeGreaterThan(0);
      expect(createdDirs[0]).toContain("my-repo");

      // Verify config.json was written
      expect(writtenFiles.size).toBe(1);
      const configPath = Array.from(writtenFiles.keys())[0]!;
      expect(configPath).toContain("config.json");

      // Verify config content structure
      const configContent = writtenFiles.get(configPath)!;
      const config = JSON.parse(configContent) as unknown;
      expect(config).toEqual({
        version: CURRENT_PROJECT_VERSION,
        path: "/home/user/projects/my-repo",
      });
    });

    it("wraps filesystem errors in ProjectStoreError", async () => {
      const mockFs = createMockFileSystemLayer({
        mkdir: {
          error: new FileSystemError("EACCES", "/data/projects", "Permission denied"),
        },
      });

      const store = new ProjectStore(projectsDir, mockFs);

      await expect(store.saveProject("/home/user/projects/my-repo")).rejects.toThrow(
        "Failed to save project"
      );
    });

    it("handles paths with special characters", async () => {
      const writtenFiles: Map<string, string> = new Map();

      const mockFs = createMockFileSystemLayer({
        mkdir: { implementation: async () => {} },
        writeFile: {
          implementation: async (path, content) => {
            writtenFiles.set(path, content);
          },
        },
      });

      const store = new ProjectStore(projectsDir, mockFs);
      await store.saveProject("/home/user/projects/my-repo with spaces");

      // Verify config content has correct path
      const configContent = Array.from(writtenFiles.values())[0]!;
      const config = JSON.parse(configContent) as { path: string };
      expect(config.path).toBe("/home/user/projects/my-repo with spaces");
    });
  });

  describe("loadAllProjects", () => {
    it("returns empty array when projects directory does not exist", async () => {
      const mockFs = createMockFileSystemLayer({
        readdir: {
          error: new FileSystemError("ENOENT", projectsDir, "Not found"),
        },
      });

      const store = new ProjectStore(projectsDir, mockFs);
      const projects = await store.loadAllProjects();

      expect(projects).toEqual([]);
    });

    it("returns empty array when projects directory is empty", async () => {
      const mockFs = createMockFileSystemLayer({
        readdir: { entries: [] },
      });

      const store = new ProjectStore(projectsDir, mockFs);
      const projects = await store.loadAllProjects();

      expect(projects).toEqual([]);
    });

    it("loads projects from config.json files", async () => {
      const mockFs = createMockFileSystemLayer({
        readdir: {
          entries: [
            createDirEntry("my-repo-abc12345", { isDirectory: true }),
            createDirEntry("other-repo-def67890", { isDirectory: true }),
          ],
        },
        readFile: {
          implementation: async (path) => {
            if (path.includes("my-repo-abc12345")) {
              return JSON.stringify({
                version: CURRENT_PROJECT_VERSION,
                path: "/home/user/projects/my-repo",
              });
            }
            if (path.includes("other-repo-def67890")) {
              return JSON.stringify({
                version: CURRENT_PROJECT_VERSION,
                path: "/home/user/projects/other-repo",
              });
            }
            throw new FileSystemError("ENOENT", path, "Not found");
          },
        },
      });

      const store = new ProjectStore(projectsDir, mockFs);
      const projects = await store.loadAllProjects();

      expect(projects).toContain("/home/user/projects/my-repo");
      expect(projects).toContain("/home/user/projects/other-repo");
      expect(projects).toHaveLength(2);
    });

    it("skips directories without config.json", async () => {
      const mockFs = createMockFileSystemLayer({
        readdir: {
          entries: [
            createDirEntry("valid-project", { isDirectory: true }),
            createDirEntry("no-config-dir", { isDirectory: true }),
          ],
        },
        readFile: {
          implementation: async (path) => {
            if (path.includes("valid-project")) {
              return JSON.stringify({
                version: CURRENT_PROJECT_VERSION,
                path: "/home/user/valid-project",
              });
            }
            throw new FileSystemError("ENOENT", path, "Not found");
          },
        },
      });

      const store = new ProjectStore(projectsDir, mockFs);
      const projects = await store.loadAllProjects();

      expect(projects).toEqual(["/home/user/valid-project"]);
    });

    it("skips entries with malformed JSON", async () => {
      const mockFs = createMockFileSystemLayer({
        readdir: {
          entries: [
            createDirEntry("valid-project", { isDirectory: true }),
            createDirEntry("malformed-project", { isDirectory: true }),
          ],
        },
        readFile: {
          implementation: async (path) => {
            if (path.includes("valid-project")) {
              return JSON.stringify({
                version: CURRENT_PROJECT_VERSION,
                path: "/home/user/valid-project",
              });
            }
            if (path.includes("malformed-project")) {
              return "not valid json";
            }
            throw new FileSystemError("ENOENT", path, "Not found");
          },
        },
      });

      const store = new ProjectStore(projectsDir, mockFs);
      const projects = await store.loadAllProjects();

      expect(projects).toEqual(["/home/user/valid-project"]);
    });

    it("skips config.json missing path field", async () => {
      const mockFs = createMockFileSystemLayer({
        readdir: {
          entries: [
            createDirEntry("valid-project", { isDirectory: true }),
            createDirEntry("missing-path", { isDirectory: true }),
          ],
        },
        readFile: {
          implementation: async (path) => {
            if (path.includes("valid-project")) {
              return JSON.stringify({
                version: CURRENT_PROJECT_VERSION,
                path: "/home/user/valid-project",
              });
            }
            if (path.includes("missing-path")) {
              return JSON.stringify({ version: CURRENT_PROJECT_VERSION });
            }
            throw new FileSystemError("ENOENT", path, "Not found");
          },
        },
      });

      const store = new ProjectStore(projectsDir, mockFs);
      const projects = await store.loadAllProjects();

      expect(projects).toEqual(["/home/user/valid-project"]);
    });

    it("skips non-directory entries", async () => {
      const mockFs = createMockFileSystemLayer({
        readdir: {
          entries: [
            createDirEntry("valid-project", { isDirectory: true }),
            createDirEntry("file.txt", { isFile: true }),
            createDirEntry("symlink", { isSymbolicLink: true }),
          ],
        },
        readFile: {
          implementation: async (path) => {
            if (path.includes("valid-project")) {
              return JSON.stringify({
                version: CURRENT_PROJECT_VERSION,
                path: "/home/user/valid-project",
              });
            }
            throw new FileSystemError("ENOENT", path, "Not found");
          },
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

      const mockFs = createMockFileSystemLayer({
        unlink: {
          implementation: async (path) => {
            unlinkedPaths.push(path);
          },
        },
        rm: {
          implementation: async (path, options) => {
            rmCalls.push({ path, recursive: options?.recursive });
          },
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
      const mockFs = createMockFileSystemLayer({
        unlink: {
          error: new FileSystemError("ENOENT", "/path", "Not found"),
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

      const mockFs = createMockFileSystemLayer({
        unlink: {
          implementation: async (path) => {
            unlinkedPaths.push(path);
          },
        },
        rm: {
          // rm() without recursive fails with ENOTEMPTY when directory has contents
          error: new FileSystemError("ENOTEMPTY", "/path", "Directory not empty"),
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
