// @vitest-environment node
/**
 * Integration tests for ProjectStore.
 * Tests end-to-end behavior with real filesystem via DefaultFileSystemLayer.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ProjectStore } from "./project-store";
import { DefaultFileSystemLayer } from "../platform/filesystem";
import { createTempDir } from "../test-utils";
import path from "path";

describe("ProjectStore integration", () => {
  let store: ProjectStore;
  let tempDir: { path: string; cleanup: () => Promise<void> };
  let projectsDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    projectsDir = path.join(tempDir.path, "projects");
    const fs = new DefaultFileSystemLayer();
    store = new ProjectStore(projectsDir, fs);
  });

  afterEach(async () => {
    await tempDir.cleanup();
  });

  describe("full save/load/remove cycle", () => {
    it("saves, loads, and removes a project", async () => {
      const projectPath = "/home/user/projects/my-repo";

      // Save project
      await store.saveProject(projectPath);

      // Load projects - should contain saved project
      const loadedProjects = await store.loadAllProjects();
      expect(loadedProjects).toContain(projectPath);

      // Remove project
      await store.removeProject(projectPath);

      // Load projects again - should not contain removed project
      const afterRemove = await store.loadAllProjects();
      expect(afterRemove).not.toContain(projectPath);
    });

    it("handles multiple projects", async () => {
      const projectPath1 = "/home/user/projects/repo-a";
      const projectPath2 = "/home/user/projects/repo-b";
      const projectPath3 = "/home/user/projects/repo-c";

      // Save multiple projects
      await store.saveProject(projectPath1);
      await store.saveProject(projectPath2);
      await store.saveProject(projectPath3);

      // Load all projects
      const loadedProjects = await store.loadAllProjects();
      expect(loadedProjects).toHaveLength(3);
      expect(loadedProjects).toContain(projectPath1);
      expect(loadedProjects).toContain(projectPath2);
      expect(loadedProjects).toContain(projectPath3);

      // Remove one project
      await store.removeProject(projectPath2);

      // Load projects again - should have 2 remaining
      const afterRemove = await store.loadAllProjects();
      expect(afterRemove).toHaveLength(2);
      expect(afterRemove).toContain(projectPath1);
      expect(afterRemove).not.toContain(projectPath2);
      expect(afterRemove).toContain(projectPath3);
    });

    it("save is idempotent", async () => {
      const projectPath = "/home/user/projects/my-repo";

      // Save same project multiple times
      await store.saveProject(projectPath);
      await store.saveProject(projectPath);
      await store.saveProject(projectPath);

      // Should only appear once
      const loadedProjects = await store.loadAllProjects();
      expect(loadedProjects).toHaveLength(1);
      expect(loadedProjects).toContain(projectPath);
    });

    it("remove is idempotent", async () => {
      const projectPath = "/home/user/projects/my-repo";

      await store.saveProject(projectPath);

      // Remove same project multiple times - should not throw
      await expect(store.removeProject(projectPath)).resolves.toBeUndefined();
      await expect(store.removeProject(projectPath)).resolves.toBeUndefined();
      await expect(store.removeProject(projectPath)).resolves.toBeUndefined();
    });
  });

  describe("edge cases", () => {
    it("returns empty array when no projects saved", async () => {
      const loadedProjects = await store.loadAllProjects();
      expect(loadedProjects).toEqual([]);
    });

    it("handles paths with special characters", async () => {
      const projectPath = "/home/user/projects/my repo with spaces";

      await store.saveProject(projectPath);

      const loadedProjects = await store.loadAllProjects();
      expect(loadedProjects).toContain(projectPath);
    });
  });
});
