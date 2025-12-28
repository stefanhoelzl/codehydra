/**
 * Tests for deletion state store.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  setDeletionState,
  clearDeletion,
  isDeleting,
  getDeletionState,
  getDeletionStatus,
  deletionStates,
  reset,
} from "./deletion.svelte";
import type { DeletionProgress, ProjectId, WorkspaceName } from "@shared/api/types";
import type { WorkspacePath } from "@shared/ipc";

describe("deletion store", () => {
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

  describe("setDeletionState", () => {
    it("should store progress state by workspacePath", () => {
      const progress = createProgress("/path/to/workspace");

      setDeletionState(progress);

      expect(getDeletionState("/path/to/workspace")).toEqual(progress);
    });

    it("should update existing state for same workspace", () => {
      const initial = createProgress("/path/to/workspace");
      const updated = createProgress("/path/to/workspace", {
        operations: [
          { id: "cleanup-vscode", label: "Cleanup VS Code", status: "done" },
          { id: "cleanup-workspace", label: "Cleanup workspace", status: "in-progress" },
        ],
      });

      setDeletionState(initial);
      setDeletionState(updated);

      expect(getDeletionState("/path/to/workspace")).toEqual(updated);
    });

    it("should store multiple workspaces independently", () => {
      const progress1 = createProgress("/path/to/workspace1");
      const progress2 = createProgress("/path/to/workspace2", {
        workspaceName: "workspace2" as WorkspaceName,
      });

      setDeletionState(progress1);
      setDeletionState(progress2);

      expect(getDeletionState("/path/to/workspace1")).toEqual(progress1);
      expect(getDeletionState("/path/to/workspace2")).toEqual(progress2);
    });
  });

  describe("clearDeletion", () => {
    it("should remove state for workspace", () => {
      const progress = createProgress("/path/to/workspace");
      setDeletionState(progress);

      clearDeletion("/path/to/workspace");

      expect(getDeletionState("/path/to/workspace")).toBeUndefined();
    });

    it("should not affect other workspaces", () => {
      const progress1 = createProgress("/path/to/workspace1");
      const progress2 = createProgress("/path/to/workspace2");
      setDeletionState(progress1);
      setDeletionState(progress2);

      clearDeletion("/path/to/workspace1");

      expect(getDeletionState("/path/to/workspace1")).toBeUndefined();
      expect(getDeletionState("/path/to/workspace2")).toEqual(progress2);
    });

    it("should be a no-op for non-existent workspace", () => {
      expect(() => clearDeletion("/nonexistent")).not.toThrow();
    });
  });

  describe("isDeleting", () => {
    it("should return true only for stored workspaces", () => {
      const progress = createProgress("/path/to/workspace");
      setDeletionState(progress);

      expect(isDeleting("/path/to/workspace")).toBe(true);
      expect(isDeleting("/other/workspace")).toBe(false);
    });

    it("should return false after clearDeletion", () => {
      const progress = createProgress("/path/to/workspace");
      setDeletionState(progress);
      clearDeletion("/path/to/workspace");

      expect(isDeleting("/path/to/workspace")).toBe(false);
    });
  });

  describe("getDeletionState", () => {
    it("should return stored state or undefined", () => {
      const progress = createProgress("/path/to/workspace");

      expect(getDeletionState("/path/to/workspace")).toBeUndefined();

      setDeletionState(progress);

      expect(getDeletionState("/path/to/workspace")).toEqual(progress);
    });
  });

  describe("deletionStates", () => {
    it("should provide reactive access to all states", () => {
      const progress1 = createProgress("/path/to/workspace1");
      const progress2 = createProgress("/path/to/workspace2");
      setDeletionState(progress1);
      setDeletionState(progress2);

      const states = deletionStates.value;

      expect(states.size).toBe(2);
      expect(states.get("/path/to/workspace1")).toEqual(progress1);
      expect(states.get("/path/to/workspace2")).toEqual(progress2);
    });
  });

  describe("reset", () => {
    it("should clear all states", () => {
      const progress1 = createProgress("/path/to/workspace1");
      const progress2 = createProgress("/path/to/workspace2");
      setDeletionState(progress1);
      setDeletionState(progress2);

      reset();

      expect(deletionStates.value.size).toBe(0);
      expect(isDeleting("/path/to/workspace1")).toBe(false);
      expect(isDeleting("/path/to/workspace2")).toBe(false);
    });
  });

  describe("getDeletionStatus", () => {
    it('should return "none" when no state exists', () => {
      expect(getDeletionStatus("/path/to/workspace")).toBe("none");
    });

    it('should return "in-progress" during deletion', () => {
      const progress = createProgress("/path/to/workspace", {
        completed: false,
        hasErrors: false,
      });
      setDeletionState(progress);

      expect(getDeletionStatus("/path/to/workspace")).toBe("in-progress");
    });

    it('should return "none" after successful deletion (state cleared)', () => {
      const progress = createProgress("/path/to/workspace", {
        completed: true,
        hasErrors: false,
      });
      setDeletionState(progress);
      clearDeletion("/path/to/workspace");

      expect(getDeletionStatus("/path/to/workspace")).toBe("none");
    });

    it('should return "error" on failure', () => {
      const progress = createProgress("/path/to/workspace", {
        completed: true,
        hasErrors: true,
      });
      setDeletionState(progress);

      expect(getDeletionStatus("/path/to/workspace")).toBe("error");
    });

    it("should transition from error to in-progress on retry", () => {
      // Start in error state
      const errorProgress = createProgress("/path/to/workspace", {
        completed: true,
        hasErrors: true,
      });
      setDeletionState(errorProgress);
      expect(getDeletionStatus("/path/to/workspace")).toBe("error");

      // Retry starts new deletion
      const retryProgress = createProgress("/path/to/workspace", {
        completed: false,
        hasErrors: false,
      });
      setDeletionState(retryProgress);
      expect(getDeletionStatus("/path/to/workspace")).toBe("in-progress");
    });
  });
});
