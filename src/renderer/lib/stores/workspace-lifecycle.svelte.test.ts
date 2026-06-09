/**
 * Tests for workspace lifecycle store (creating placeholders + deletion progress).
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  createPendingPath,
  setCreating,
  setDeletionProgress,
  clearLifecycle,
  getLifecycle,
  findCreatingByName,
  lifecycleEntries,
  reset,
} from "./workspace-lifecycle.svelte";
import type { DeletionProgress, ProjectId, WorkspaceName } from "@shared/api/types";
import type { WorkspacePath } from "@shared/ipc";

describe("workspace lifecycle store", () => {
  beforeEach(() => {
    reset();
  });

  const createProgress = (
    workspacePath: string,
    overrides: Partial<DeletionProgress> = {}
  ): DeletionProgress => ({
    workspacePath: workspacePath as WorkspacePath,
    workspaceName: "test-workspace" as WorkspaceName,
    projectId: "test-project-12345678" as ProjectId,
    keepBranch: false,
    operations: [
      { id: "kill-terminals", label: "Terminating processes", status: "pending" },
      { id: "cleanup-vscode", label: "Closing VS Code view", status: "pending" },
      { id: "cleanup-workspace", label: "Removing workspace", status: "pending" },
    ],
    completed: false,
    hasErrors: false,
    ...overrides,
  });

  describe("createPendingPath", () => {
    it("should generate a synthetic path from project path and name", () => {
      expect(createPendingPath("/projects/demo", "feature-x")).toBe(
        "__pending__//projects/demo/feature-x"
      );
    });
  });

  describe("creating entries", () => {
    it("should report creating status for registered placeholders", () => {
      const path = createPendingPath("/projects/demo", "feature-x");
      setCreating(path, "/projects/demo", "feature-x");

      expect(getLifecycle(path)).toBe("creating");
      expect(getLifecycle("/other/workspace")).toBe("none");
    });

    it("should return none after clearLifecycle", () => {
      const path = createPendingPath("/projects/demo", "feature-x");
      setCreating(path, "/projects/demo", "feature-x");
      clearLifecycle(path);

      expect(getLifecycle(path)).toBe("none");
    });

    it("should find a creating placeholder by project path and name", () => {
      const path = createPendingPath("/projects/demo", "feature-x");
      setCreating(path, "/projects/demo", "feature-x");

      expect(findCreatingByName("/projects/demo", "feature-x")).toBe(path);
      expect(findCreatingByName("/projects/demo", "other-name")).toBeNull();
      expect(findCreatingByName("/projects/other", "feature-x")).toBeNull();
    });

    it("should not match deleting entries in findCreatingByName", () => {
      setDeletionProgress(
        createProgress("/projects/demo/feature-x", {
          workspaceName: "feature-x" as WorkspaceName,
        })
      );

      expect(findCreatingByName("/projects/demo", "feature-x")).toBeNull();
    });
  });

  describe("setDeletionProgress", () => {
    it("should store progress state by workspacePath", () => {
      const progress = createProgress("/path/to/workspace");

      setDeletionProgress(progress);

      expect(lifecycleEntries.value.get("/path/to/workspace")).toEqual({
        kind: "deleting",
        progress,
      });
    });

    it("should update existing state for same workspace", () => {
      const initial = createProgress("/path/to/workspace");
      const updated = createProgress("/path/to/workspace", {
        operations: [
          { id: "cleanup-vscode", label: "Cleanup VS Code", status: "done" },
          { id: "cleanup-workspace", label: "Cleanup workspace", status: "in-progress" },
        ],
      });

      setDeletionProgress(initial);
      setDeletionProgress(updated);

      expect(lifecycleEntries.value.get("/path/to/workspace")).toEqual({
        kind: "deleting",
        progress: updated,
      });
    });

    it("should store multiple workspaces independently", () => {
      const progress1 = createProgress("/path/to/workspace1");
      const progress2 = createProgress("/path/to/workspace2", {
        workspaceName: "workspace2" as WorkspaceName,
      });

      setDeletionProgress(progress1);
      setDeletionProgress(progress2);

      expect(lifecycleEntries.value.get("/path/to/workspace1")).toEqual({
        kind: "deleting",
        progress: progress1,
      });
      expect(lifecycleEntries.value.get("/path/to/workspace2")).toEqual({
        kind: "deleting",
        progress: progress2,
      });
    });
  });

  describe("clearLifecycle", () => {
    it("should remove state for workspace", () => {
      setDeletionProgress(createProgress("/path/to/workspace"));

      clearLifecycle("/path/to/workspace");

      expect(lifecycleEntries.value.get("/path/to/workspace")).toBeUndefined();
    });

    it("should not affect other workspaces", () => {
      const progress2 = createProgress("/path/to/workspace2");
      setDeletionProgress(createProgress("/path/to/workspace1"));
      setDeletionProgress(progress2);

      clearLifecycle("/path/to/workspace1");

      expect(lifecycleEntries.value.get("/path/to/workspace1")).toBeUndefined();
      expect(lifecycleEntries.value.get("/path/to/workspace2")).toEqual({
        kind: "deleting",
        progress: progress2,
      });
    });

    it("should be a no-op for non-existent workspace", () => {
      expect(() => clearLifecycle("/nonexistent")).not.toThrow();
    });
  });

  describe("getLifecycle", () => {
    it('should return "none" when no state exists', () => {
      expect(getLifecycle("/path/to/workspace")).toBe("none");
    });

    it('should return "deleting" during deletion', () => {
      setDeletionProgress(
        createProgress("/path/to/workspace", { completed: false, hasErrors: false })
      );

      expect(getLifecycle("/path/to/workspace")).toBe("deleting");
    });

    it('should return "none" after successful deletion (state cleared)', () => {
      setDeletionProgress(
        createProgress("/path/to/workspace", { completed: true, hasErrors: false })
      );
      clearLifecycle("/path/to/workspace");

      expect(getLifecycle("/path/to/workspace")).toBe("none");
    });

    it('should return "delete-failed" on failure', () => {
      setDeletionProgress(
        createProgress("/path/to/workspace", { completed: true, hasErrors: true })
      );

      expect(getLifecycle("/path/to/workspace")).toBe("delete-failed");
    });

    it("should transition from delete-failed to deleting on retry", () => {
      // Start in failed state
      setDeletionProgress(
        createProgress("/path/to/workspace", { completed: true, hasErrors: true })
      );
      expect(getLifecycle("/path/to/workspace")).toBe("delete-failed");

      // Retry starts new deletion
      setDeletionProgress(
        createProgress("/path/to/workspace", { completed: false, hasErrors: false })
      );
      expect(getLifecycle("/path/to/workspace")).toBe("deleting");
    });
  });

  describe("lifecycleEntries", () => {
    it("should provide reactive access to all entries across kinds", () => {
      const pendingPath = createPendingPath("/projects/demo", "feature-x");
      const progress = createProgress("/path/to/workspace");
      setCreating(pendingPath, "/projects/demo", "feature-x");
      setDeletionProgress(progress);

      const entries = lifecycleEntries.value;

      expect(entries.size).toBe(2);
      expect(entries.get(pendingPath)).toEqual({
        kind: "creating",
        projectPath: "/projects/demo",
        name: "feature-x",
      });
      expect(entries.get("/path/to/workspace")).toEqual({ kind: "deleting", progress });
    });
  });

  describe("reset", () => {
    it("should clear all entries", () => {
      const pendingPath = createPendingPath("/projects/demo", "feature-x");
      setCreating(pendingPath, "/projects/demo", "feature-x");
      setDeletionProgress(createProgress("/path/to/workspace"));

      reset();

      expect(lifecycleEntries.value.size).toBe(0);
      expect(getLifecycle(pendingPath)).toBe("none");
      expect(getLifecycle("/path/to/workspace")).toBe("none");
    });
  });
});
