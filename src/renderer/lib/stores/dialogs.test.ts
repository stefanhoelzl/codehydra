/**
 * Tests for the dialog state store.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ProjectId, WorkspaceName, WorkspaceRef } from "@shared/api/types";

// Test project IDs
const testProjectId = "test-project-12345678" as ProjectId;
const activeProjectId = "active-project-87654321" as ProjectId;

// Helper to create WorkspaceRef
function createWorkspaceRef(
  projectId: ProjectId,
  workspaceName: string,
  path: string
): WorkspaceRef {
  return {
    projectId,
    workspaceName: workspaceName as WorkspaceName,
    path,
  };
}

// Import after mocks
import {
  dialogState,
  openRemoveDialog,
  openCloseProjectDialog,
  closeDialog,
  reset,
} from "./dialogs.svelte.js";

describe("dialog state store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reset();
  });

  afterEach(() => {
    // Clean up any test elements
    document.body.innerHTML = "";
  });

  describe("initial state", () => {
    it("initializes with type 'closed'", () => {
      expect(dialogState.value).toEqual({ type: "closed" });
    });
  });

  describe("openRemoveDialog", () => {
    it("sets type to 'remove' with workspaceRef", () => {
      const workspaceRef = createWorkspaceRef(testProjectId, "ws1", "/test/project/.worktrees/ws1");
      openRemoveDialog(workspaceRef);

      expect(dialogState.value).toEqual({
        type: "remove",
        workspaceRef,
      });
    });
  });

  describe("closeDialog", () => {
    it("sets type to 'closed'", () => {
      openCloseProjectDialog(testProjectId);
      closeDialog();

      expect(dialogState.value).toEqual({ type: "closed" });
    });
  });

  describe("openCloseProjectDialog", () => {
    it("sets type to 'close-project' with projectId", () => {
      openCloseProjectDialog(testProjectId);

      expect(dialogState.value).toEqual({
        type: "close-project",
        projectId: testProjectId,
      });
    });

    it("stores only projectId, not full project object", () => {
      openCloseProjectDialog(activeProjectId);

      // Verify state contains only projectId
      const state = dialogState.value;
      expect(state.type).toBe("close-project");
      if (state.type === "close-project") {
        expect(state.projectId).toBe(activeProjectId);
        expect(Object.keys(state)).toEqual(["type", "projectId"]);
      }
    });
  });

  describe("closeDialog from close-project", () => {
    it("resets state to closed from close-project", () => {
      openCloseProjectDialog(testProjectId);
      expect(dialogState.value.type).toBe("close-project");

      closeDialog();

      expect(dialogState.value).toEqual({ type: "closed" });
    });
  });

  describe("opening new dialog closes previous (exclusive)", () => {
    it("opening close-project dialog after remove closes remove", () => {
      const workspaceRef = createWorkspaceRef(testProjectId, "ws1", "/test/workspace");
      openRemoveDialog(workspaceRef);
      expect(dialogState.value.type).toBe("remove");

      openCloseProjectDialog(activeProjectId);
      expect(dialogState.value.type).toBe("close-project");
    });

    it("opening remove dialog after close-project closes close-project", () => {
      openCloseProjectDialog(activeProjectId);
      expect(dialogState.value.type).toBe("close-project");

      const workspaceRef = createWorkspaceRef(testProjectId, "ws1", "/test/workspace");
      openRemoveDialog(workspaceRef);
      expect(dialogState.value.type).toBe("remove");
    });
  });
});
