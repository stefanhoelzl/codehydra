/**
 * Tests for the dialog state store.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ProjectId, WorkspaceName, WorkspaceRef } from "@shared/api/types";

// Test project IDs
const testProjectId = "test-project-12345678" as ProjectId;
const activeProjectId = "active-project-87654321" as ProjectId;
const firstProjectId = "first-project-11111111" as ProjectId;
const secondProjectId = "second-project-22222222" as ProjectId;
const explicitProjectId = "explicit-project-33333333" as ProjectId;

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

// Create mock functions for projects store
const { mockActiveWorkspace, mockProjects } = vi.hoisted(() => ({
  mockActiveWorkspace: vi.fn(),
  mockProjects: vi.fn(),
}));

// Mock $lib/stores/projects.svelte.js - uses activeWorkspace now, not activeProject
vi.mock("./projects.svelte.js", () => ({
  activeWorkspace: {
    get value() {
      return mockActiveWorkspace();
    },
  },
  projects: {
    get value() {
      return mockProjects();
    },
  },
}));

// Import after mocks
import {
  dialogState,
  openCreateDialog,
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

  describe("openCreateDialog", () => {
    it("sets type to 'create' with explicit projectId", () => {
      openCreateDialog(testProjectId);

      expect(dialogState.value).toEqual({
        type: "create",
        projectId: testProjectId,
      });
    });

    it("uses provided defaultProjectId when specified", () => {
      // Setup mocks to return different values
      mockActiveWorkspace.mockReturnValue({
        projectId: activeProjectId,
        workspaceName: "ws1" as WorkspaceName,
        path: "/active/project/.worktrees/ws1",
      });
      mockProjects.mockReturnValue([
        { id: firstProjectId, path: "/first/project", name: "first" },
        { id: secondProjectId, path: "/second/project", name: "second" },
      ]);

      // Open with explicit ID - should use that, not active or first
      openCreateDialog(explicitProjectId);

      expect(dialogState.value).toEqual({
        type: "create",
        projectId: explicitProjectId,
      });
    });

    it("uses activeWorkspace projectId when no defaultProjectId provided", () => {
      mockActiveWorkspace.mockReturnValue({
        projectId: activeProjectId,
        workspaceName: "ws1" as WorkspaceName,
        path: "/active/project/.worktrees/ws1",
      });
      mockProjects.mockReturnValue([
        { id: firstProjectId, path: "/first/project", name: "first" },
        { id: secondProjectId, path: "/second/project", name: "second" },
      ]);

      // Open without ID - should use activeWorkspace's projectId
      openCreateDialog();

      expect(dialogState.value).toEqual({
        type: "create",
        projectId: activeProjectId,
      });
    });

    it("uses first project ID when no active and no defaultProjectId", () => {
      mockActiveWorkspace.mockReturnValue(null);
      mockProjects.mockReturnValue([
        { id: firstProjectId, path: "/first/project", name: "first" },
        { id: secondProjectId, path: "/second/project", name: "second" },
      ]);

      // Open without ID and no active - should use first project
      openCreateDialog();

      expect(dialogState.value).toEqual({
        type: "create",
        projectId: firstProjectId,
      });
    });

    it("opens without projectId when no projects available", () => {
      mockActiveWorkspace.mockReturnValue(null);
      mockProjects.mockReturnValue([]);

      // Open with no projects - dialog opens with no projectId
      openCreateDialog();

      expect(dialogState.value).toEqual({ type: "create" });
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
      openCreateDialog(testProjectId);
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
    it("opening create dialog after remove closes remove", () => {
      const workspaceRef = createWorkspaceRef(testProjectId, "ws1", "/test/workspace");
      openRemoveDialog(workspaceRef);
      expect(dialogState.value.type).toBe("remove");

      openCreateDialog(testProjectId);
      expect(dialogState.value.type).toBe("create");
    });

    it("opening remove dialog after create closes create", () => {
      openCreateDialog(testProjectId);
      expect(dialogState.value.type).toBe("create");

      const workspaceRef = createWorkspaceRef(testProjectId, "ws1", "/test/workspace");
      openRemoveDialog(workspaceRef);
      expect(dialogState.value.type).toBe("remove");
    });

    it("opening close-project dialog after create closes create", () => {
      openCreateDialog(testProjectId);
      expect(dialogState.value.type).toBe("create");

      openCloseProjectDialog(activeProjectId);
      expect(dialogState.value.type).toBe("close-project");
    });

    it("opening create dialog after close-project closes close-project", () => {
      openCloseProjectDialog(testProjectId);
      expect(dialogState.value.type).toBe("close-project");

      openCreateDialog(activeProjectId);
      expect(dialogState.value.type).toBe("create");
    });
  });
});
