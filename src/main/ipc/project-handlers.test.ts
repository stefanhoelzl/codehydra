// @vitest-environment node
/**
 * Tests for project IPC handlers.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Project } from "../../shared/ipc";
import type { IpcMainInvokeEvent } from "electron";

// Mock electron
const mockShowOpenDialog = vi.fn();
const mockGetAllWindows = vi.fn(() => []);

vi.mock("electron", () => ({
  dialog: {
    showOpenDialog: (...args: unknown[]) => mockShowOpenDialog(...args),
  },
  BrowserWindow: {
    getAllWindows: () => mockGetAllWindows(),
  },
}));

import {
  createProjectOpenHandler,
  createProjectCloseHandler,
  createProjectListHandler,
  createProjectSelectFolderHandler,
} from "./project-handlers";
import { WorkspaceError } from "../../services/errors";

// Mock event
const mockEvent = {} as IpcMainInvokeEvent;

describe("project:open handler", () => {
  const mockAppState = {
    openProject: vi.fn(),
    closeProject: vi.fn(),
    getProject: vi.fn(),
    getAllProjects: vi.fn(),
    getWorkspaceProvider: vi.fn(),
    getWorkspaceUrl: vi.fn(),
    loadPersistedProjects: vi.fn(),
    findProjectForWorkspace: vi.fn(),
    addWorkspace: vi.fn(),
    removeWorkspace: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens project and returns Project object", async () => {
    const project: Project = {
      path: "/test/repo" as Project["path"],
      name: "repo",
      workspaces: [],
    };
    mockAppState.openProject.mockResolvedValue(project);

    const handler = createProjectOpenHandler(mockAppState);
    const result = await handler(mockEvent, { path: "/test/repo" });

    expect(mockAppState.openProject).toHaveBeenCalledWith("/test/repo");
    expect(result).toEqual(project);
  });

  it("throws error for non-git repository", async () => {
    mockAppState.openProject.mockRejectedValue(
      new WorkspaceError("Not a git repository", "NOT_GIT_REPO")
    );

    const handler = createProjectOpenHandler(mockAppState);

    await expect(handler(mockEvent, { path: "/not/a/repo" })).rejects.toThrow(
      "Not a git repository"
    );
  });
});

describe("project:close handler", () => {
  const mockAppState = {
    openProject: vi.fn(),
    closeProject: vi.fn(),
    getProject: vi.fn(),
    getAllProjects: vi.fn(),
    getWorkspaceProvider: vi.fn(),
    getWorkspaceUrl: vi.fn(),
    loadPersistedProjects: vi.fn(),
    findProjectForWorkspace: vi.fn(),
    addWorkspace: vi.fn(),
    removeWorkspace: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("closes project", async () => {
    const handler = createProjectCloseHandler(mockAppState);
    await handler(mockEvent, { path: "/test/repo" });

    expect(mockAppState.closeProject).toHaveBeenCalledWith("/test/repo");
  });
});

describe("project:list handler", () => {
  const mockAppState = {
    openProject: vi.fn(),
    closeProject: vi.fn(),
    getProject: vi.fn(),
    getAllProjects: vi.fn(),
    getWorkspaceProvider: vi.fn(),
    getWorkspaceUrl: vi.fn(),
    loadPersistedProjects: vi.fn(),
    findProjectForWorkspace: vi.fn(),
    addWorkspace: vi.fn(),
    removeWorkspace: vi.fn(),
  };

  const mockViewManager = {
    getActiveWorkspacePath: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns all open projects and active workspace path", async () => {
    const projects: Project[] = [
      { path: "/test/repo1" as Project["path"], name: "repo1", workspaces: [] },
      { path: "/test/repo2" as Project["path"], name: "repo2", workspaces: [] },
    ];
    mockAppState.getAllProjects.mockReturnValue(projects);
    mockViewManager.getActiveWorkspacePath.mockReturnValue("/test/repo1/.worktrees/ws1");

    const handler = createProjectListHandler(mockAppState, mockViewManager);
    const result = await handler(mockEvent, undefined);

    expect(mockAppState.getAllProjects).toHaveBeenCalled();
    expect(mockViewManager.getActiveWorkspacePath).toHaveBeenCalled();
    expect(result).toEqual({
      projects,
      activeWorkspacePath: "/test/repo1/.worktrees/ws1",
    });
  });

  it("returns null activeWorkspacePath when no workspace is active", async () => {
    const projects: Project[] = [];
    mockAppState.getAllProjects.mockReturnValue(projects);
    mockViewManager.getActiveWorkspacePath.mockReturnValue(null);

    const handler = createProjectListHandler(mockAppState, mockViewManager);
    const result = await handler(mockEvent, undefined);

    expect(result).toEqual({
      projects,
      activeWorkspacePath: null,
    });
  });
});

describe("project:select-folder handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows folder picker and returns selected path", async () => {
    mockShowOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ["/selected/folder"],
    });

    const handler = createProjectSelectFolderHandler();
    const result = await handler(mockEvent, undefined);

    expect(mockShowOpenDialog).toHaveBeenCalledWith({
      properties: ["openDirectory"],
      title: "Select Git Repository",
    });
    expect(result).toBe("/selected/folder");
  });

  it("returns null when dialog is canceled", async () => {
    mockShowOpenDialog.mockResolvedValue({
      canceled: true,
      filePaths: [],
    });

    const handler = createProjectSelectFolderHandler();
    const result = await handler(mockEvent, undefined);

    expect(result).toBeNull();
  });

  it("returns null when no path selected", async () => {
    mockShowOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [],
    });

    const handler = createProjectSelectFolderHandler();
    const result = await handler(mockEvent, undefined);

    expect(result).toBeNull();
  });
});
