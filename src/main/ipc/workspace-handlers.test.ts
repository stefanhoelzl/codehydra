// @vitest-environment node
/**
 * Tests for workspace IPC handlers.
 */

import { describe, it, expect, vi } from "vitest";
import type {
  Project,
  Workspace,
  WorkspaceCreatePayload,
  WorkspaceRemovePayload,
  WorkspaceSwitchPayload,
  WorkspaceListBasesPayload,
  WorkspaceUpdateBasesPayload,
  WorkspaceIsDirtyPayload,
  ProjectPath,
} from "../../shared/ipc";
import type { IpcMainInvokeEvent } from "electron";

// Mock electron - need BrowserWindow for emitEvent
vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: () => [],
  },
}));

// Mock emitEvent to spy on event emissions
const mockEmitEvent = vi.fn();
vi.mock("./handlers", () => ({
  emitEvent: (...args: unknown[]) => mockEmitEvent(...args),
}));

import {
  createWorkspaceCreateHandler,
  createWorkspaceRemoveHandler,
  createWorkspaceSwitchHandler,
  createWorkspaceListBasesHandler,
  createWorkspaceUpdateBasesHandler,
  createWorkspaceIsDirtyHandler,
} from "./workspace-handlers";

// Mock event
const mockEvent = {} as IpcMainInvokeEvent;

// Helper to create mock appState
function createMockAppState() {
  return {
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
    setLastBaseBranch: vi.fn(),
  };
}

// Helper to create mock viewManager
function createMockViewManager() {
  return {
    getUIView: vi.fn(),
    createWorkspaceView: vi.fn(),
    destroyWorkspaceView: vi.fn(),
    getWorkspaceView: vi.fn(),
    updateBounds: vi.fn(),
    setActiveWorkspace: vi.fn(),
    getActiveWorkspacePath: vi.fn().mockReturnValue(null),
    focusActiveWorkspace: vi.fn(),
    focusUI: vi.fn(),
    destroy: vi.fn(),
  };
}

// Helper to create mock provider
function createMockProvider() {
  return {
    projectRoot: "/test/repo",
    discover: vi.fn(),
    listBases: vi.fn(),
    updateBases: vi.fn(),
    createWorkspace: vi.fn(),
    removeWorkspace: vi.fn(),
    isDirty: vi.fn(),
    isMainWorkspace: vi.fn(),
  };
}

describe("workspace:create handler", () => {
  it("creates workspace and view, sets active", async () => {
    const mockAppState = createMockAppState();
    const mockViewManager = createMockViewManager();
    const mockProvider = createMockProvider();

    const project: Project = {
      path: "/test/repo" as ProjectPath,
      name: "repo",
      workspaces: [],
    };
    const workspace: Workspace = {
      name: "feature-branch",
      path: "/test/repo/.worktrees/feature-branch",
      branch: "feature-branch",
    };

    mockAppState.getProject.mockReturnValue(project);
    mockAppState.getWorkspaceProvider.mockReturnValue(mockProvider);
    mockAppState.getWorkspaceUrl.mockReturnValue(
      "http://localhost:8080/?folder=/test/repo/.worktrees/feature-branch"
    );
    mockProvider.createWorkspace.mockResolvedValue(workspace);

    const handler = createWorkspaceCreateHandler(mockAppState, mockViewManager);
    const payload: WorkspaceCreatePayload = {
      projectPath: "/test/repo",
      name: "feature-branch",
      baseBranch: "main",
    };

    const result = await handler(mockEvent, payload);

    expect(mockProvider.createWorkspace).toHaveBeenCalledWith("feature-branch", "main");
    expect(mockAppState.addWorkspace).toHaveBeenCalledWith("/test/repo", workspace);
    // setActiveWorkspace is called without focus parameter (defaults to true)
    expect(mockViewManager.setActiveWorkspace).toHaveBeenCalledWith(workspace.path);
    expect(result).toEqual(workspace);
  });

  it("throws for closed project", async () => {
    const mockAppState = createMockAppState();
    const mockViewManager = createMockViewManager();

    mockAppState.getProject.mockReturnValue(undefined);

    const handler = createWorkspaceCreateHandler(mockAppState, mockViewManager);
    const payload: WorkspaceCreatePayload = {
      projectPath: "/test/repo",
      name: "feature-branch",
      baseBranch: "main",
    };

    await expect(handler(mockEvent, payload)).rejects.toThrow("Project not open");
  });

  it("calls appState.setLastBaseBranch() with baseBranch", async () => {
    const mockAppState = createMockAppState();
    const mockViewManager = createMockViewManager();
    const mockProvider = createMockProvider();

    const project: Project = {
      path: "/test/repo" as ProjectPath,
      name: "repo",
      workspaces: [],
    };
    const workspace: Workspace = {
      name: "feature-branch",
      path: "/test/repo/.worktrees/feature-branch",
      branch: "feature-branch",
    };

    mockAppState.getProject.mockReturnValue(project);
    mockAppState.getWorkspaceProvider.mockReturnValue(mockProvider);
    mockProvider.createWorkspace.mockResolvedValue(workspace);

    const handler = createWorkspaceCreateHandler(mockAppState, mockViewManager);
    const payload: WorkspaceCreatePayload = {
      projectPath: "/test/repo",
      name: "feature-branch",
      baseBranch: "develop",
    };

    await handler(mockEvent, payload);

    expect(mockAppState.setLastBaseBranch).toHaveBeenCalledWith("/test/repo", "develop");
  });

  it("still returns workspace correctly after saving branch", async () => {
    const mockAppState = createMockAppState();
    const mockViewManager = createMockViewManager();
    const mockProvider = createMockProvider();

    const project: Project = {
      path: "/test/repo" as ProjectPath,
      name: "repo",
      workspaces: [],
    };
    const workspace: Workspace = {
      name: "feature-branch",
      path: "/test/repo/.worktrees/feature-branch",
      branch: "feature-branch",
    };

    mockAppState.getProject.mockReturnValue(project);
    mockAppState.getWorkspaceProvider.mockReturnValue(mockProvider);
    mockProvider.createWorkspace.mockResolvedValue(workspace);

    const handler = createWorkspaceCreateHandler(mockAppState, mockViewManager);
    const payload: WorkspaceCreatePayload = {
      projectPath: "/test/repo",
      name: "feature-branch",
      baseBranch: "main",
    };

    const result = await handler(mockEvent, payload);

    expect(result).toEqual(workspace);
    expect(mockAppState.setLastBaseBranch).toHaveBeenCalled();
  });

  it("calls emitEvent before setLastBaseBranch for correct ordering", async () => {
    const mockAppState = createMockAppState();
    const mockViewManager = createMockViewManager();
    const mockProvider = createMockProvider();

    const project: Project = {
      path: "/test/repo" as ProjectPath,
      name: "repo",
      workspaces: [],
    };
    const workspace: Workspace = {
      name: "feature-branch",
      path: "/test/repo/.worktrees/feature-branch",
      branch: "feature-branch",
    };

    mockAppState.getProject.mockReturnValue(project);
    mockAppState.getWorkspaceProvider.mockReturnValue(mockProvider);
    mockProvider.createWorkspace.mockResolvedValue(workspace);

    // Track call order
    const callOrder: string[] = [];
    mockEmitEvent.mockImplementation(() => {
      callOrder.push("emitEvent");
    });
    mockAppState.setLastBaseBranch.mockImplementation(() => {
      callOrder.push("setLastBaseBranch");
    });

    const handler = createWorkspaceCreateHandler(mockAppState, mockViewManager);
    const payload: WorkspaceCreatePayload = {
      projectPath: "/test/repo",
      name: "feature-branch",
      baseBranch: "main",
    };

    await handler(mockEvent, payload);

    // Verify emitEvent is called before setLastBaseBranch
    expect(callOrder).toEqual(["emitEvent", "setLastBaseBranch"]);
  });

  it("emits workspace:created event with defaultBaseBranch", async () => {
    const mockAppState = createMockAppState();
    const mockViewManager = createMockViewManager();
    const mockProvider = createMockProvider();

    const project: Project = {
      path: "/test/repo" as ProjectPath,
      name: "repo",
      workspaces: [],
    };
    const workspace: Workspace = {
      name: "feature-branch",
      path: "/test/repo/.worktrees/feature-branch",
      branch: "feature-branch",
    };

    mockAppState.getProject.mockReturnValue(project);
    mockAppState.getWorkspaceProvider.mockReturnValue(mockProvider);
    mockProvider.createWorkspace.mockResolvedValue(workspace);
    mockEmitEvent.mockClear();

    const handler = createWorkspaceCreateHandler(mockAppState, mockViewManager);
    const payload: WorkspaceCreatePayload = {
      projectPath: "/test/repo",
      name: "feature-branch",
      baseBranch: "develop",
    };

    await handler(mockEvent, payload);

    // Verify emitEvent was called with defaultBaseBranch
    expect(mockEmitEvent).toHaveBeenCalledWith("workspace:created", {
      projectPath: "/test/repo",
      workspace,
      defaultBaseBranch: "develop",
    });
  });
});

describe("workspace:remove handler", () => {
  it("removes workspace and view", async () => {
    const mockAppState = createMockAppState();
    const mockViewManager = createMockViewManager();
    const mockProvider = createMockProvider();

    const project: Project = {
      path: "/test/repo" as ProjectPath,
      name: "repo",
      workspaces: [
        { name: "ws1", path: "/test/repo/.worktrees/ws1", branch: "ws1" },
        { name: "ws2", path: "/test/repo/.worktrees/ws2", branch: "ws2" },
      ],
    };

    mockAppState.findProjectForWorkspace.mockReturnValue(project);
    mockAppState.getWorkspaceProvider.mockReturnValue(mockProvider);
    mockAppState.getAllProjects.mockResolvedValue([project]);
    mockProvider.removeWorkspace.mockResolvedValue({ workspaceRemoved: true, baseDeleted: false });
    mockViewManager.getActiveWorkspacePath.mockReturnValue(null); // Not removing active workspace

    const handler = createWorkspaceRemoveHandler(mockAppState, mockViewManager);
    const payload: WorkspaceRemovePayload = {
      workspacePath: "/test/repo/.worktrees/ws1",
      deleteBranch: false,
    };

    const result = await handler(mockEvent, payload);

    expect(mockProvider.removeWorkspace).toHaveBeenCalledWith("/test/repo/.worktrees/ws1", false);
    expect(mockAppState.removeWorkspace).toHaveBeenCalledWith(
      "/test/repo",
      "/test/repo/.worktrees/ws1"
    );
    expect(result).toEqual({ workspaceRemoved: true, baseDeleted: false });
  });

  it("selects next workspace when removing active workspace", async () => {
    const mockAppState = createMockAppState();
    const mockViewManager = createMockViewManager();
    const mockProvider = createMockProvider();

    const project: Project = {
      path: "/test/repo" as ProjectPath,
      name: "repo",
      workspaces: [
        { name: "ws1", path: "/test/repo/.worktrees/ws1", branch: "ws1" },
        { name: "ws2", path: "/test/repo/.worktrees/ws2", branch: "ws2" },
      ],
    };

    mockAppState.findProjectForWorkspace.mockReturnValue(project);
    mockAppState.getWorkspaceProvider.mockReturnValue(mockProvider);
    // After removal, ws2 is still in the project
    mockAppState.getAllProjects.mockResolvedValue([
      {
        ...project,
        workspaces: [{ name: "ws2", path: "/test/repo/.worktrees/ws2", branch: "ws2" }],
      },
    ]);
    mockProvider.removeWorkspace.mockResolvedValue({ workspaceRemoved: true, baseDeleted: false });
    mockViewManager.getActiveWorkspacePath.mockReturnValue("/test/repo/.worktrees/ws1"); // Removing active workspace

    const handler = createWorkspaceRemoveHandler(mockAppState, mockViewManager);
    const payload: WorkspaceRemovePayload = {
      workspacePath: "/test/repo/.worktrees/ws1",
      deleteBranch: false,
    };

    await handler(mockEvent, payload);

    // Should select ws2 as the next workspace
    expect(mockViewManager.setActiveWorkspace).toHaveBeenCalledWith("/test/repo/.worktrees/ws2");
  });

  it("emits workspace:switched with null when removing last workspace", async () => {
    const mockAppState = createMockAppState();
    const mockViewManager = createMockViewManager();
    const mockProvider = createMockProvider();

    // Project with only one workspace
    const project: Project = {
      path: "/test/repo" as ProjectPath,
      name: "repo",
      workspaces: [{ name: "ws1", path: "/test/repo/.worktrees/ws1", branch: "ws1" }],
    };

    mockAppState.findProjectForWorkspace.mockReturnValue(project);
    mockAppState.getWorkspaceProvider.mockReturnValue(mockProvider);
    // After removal, no workspaces remain
    mockAppState.getAllProjects.mockResolvedValue([{ ...project, workspaces: [] }]);
    mockProvider.removeWorkspace.mockResolvedValue({ workspaceRemoved: true, baseDeleted: false });
    mockViewManager.getActiveWorkspacePath.mockReturnValue("/test/repo/.worktrees/ws1"); // Removing the active (and only) workspace

    mockEmitEvent.mockClear();

    const handler = createWorkspaceRemoveHandler(mockAppState, mockViewManager);
    const payload: WorkspaceRemovePayload = {
      workspacePath: "/test/repo/.worktrees/ws1",
      deleteBranch: false,
    };

    await handler(mockEvent, payload);

    // Should set active workspace to null
    expect(mockViewManager.setActiveWorkspace).toHaveBeenCalledWith(null);

    // Should emit workspace:switched with null so renderer shows empty state
    expect(mockEmitEvent).toHaveBeenCalledWith("workspace:switched", { workspacePath: null });
  });

  it("throws WORKSPACE_NOT_FOUND for unknown workspace", async () => {
    const mockAppState = createMockAppState();
    const mockViewManager = createMockViewManager();

    mockAppState.findProjectForWorkspace.mockReturnValue(undefined);

    const handler = createWorkspaceRemoveHandler(mockAppState, mockViewManager);
    const payload: WorkspaceRemovePayload = {
      workspacePath: "/unknown/workspace",
      deleteBranch: false,
    };

    await expect(handler(mockEvent, payload)).rejects.toThrow("Workspace not found");
  });
});

describe("workspace:switch handler", () => {
  it("switches active workspace and focuses by default", async () => {
    const mockAppState = createMockAppState();
    const mockViewManager = createMockViewManager();

    const project: Project = {
      path: "/test/repo" as ProjectPath,
      name: "repo",
      workspaces: [{ name: "ws1", path: "/test/repo/.worktrees/ws1", branch: "ws1" }],
    };

    mockAppState.findProjectForWorkspace.mockReturnValue(project);

    const handler = createWorkspaceSwitchHandler(mockAppState, mockViewManager);
    const payload: WorkspaceSwitchPayload = {
      workspacePath: "/test/repo/.worktrees/ws1",
    };

    await handler(mockEvent, payload);

    // setActiveWorkspace is called with focus=true (default)
    expect(mockViewManager.setActiveWorkspace).toHaveBeenCalledWith(
      "/test/repo/.worktrees/ws1",
      true
    );
  });

  it("skips focus when focusWorkspace is false", async () => {
    const mockAppState = createMockAppState();
    const mockViewManager = createMockViewManager();

    const project: Project = {
      path: "/test/repo" as ProjectPath,
      name: "repo",
      workspaces: [{ name: "ws1", path: "/test/repo/.worktrees/ws1", branch: "ws1" }],
    };

    mockAppState.findProjectForWorkspace.mockReturnValue(project);

    const handler = createWorkspaceSwitchHandler(mockAppState, mockViewManager);
    const payload: WorkspaceSwitchPayload = {
      workspacePath: "/test/repo/.worktrees/ws1",
      focusWorkspace: false,
    };

    await handler(mockEvent, payload);

    // setActiveWorkspace is called with focus=false
    expect(mockViewManager.setActiveWorkspace).toHaveBeenCalledWith(
      "/test/repo/.worktrees/ws1",
      false
    );
  });

  it("throws for workspace from closed project", async () => {
    const mockAppState = createMockAppState();
    const mockViewManager = createMockViewManager();

    mockAppState.findProjectForWorkspace.mockReturnValue(undefined);

    const handler = createWorkspaceSwitchHandler(mockAppState, mockViewManager);
    const payload: WorkspaceSwitchPayload = {
      workspacePath: "/unknown/workspace",
    };

    await expect(handler(mockEvent, payload)).rejects.toThrow("Workspace not found");
  });
});

describe("workspace:list-bases handler", () => {
  it("returns available branches", async () => {
    const mockAppState = createMockAppState();
    const mockProvider = createMockProvider();

    const project: Project = {
      path: "/test/repo" as ProjectPath,
      name: "repo",
      workspaces: [],
    };
    const bases = [
      { name: "main", isRemote: false },
      { name: "origin/main", isRemote: true },
    ];

    mockAppState.getProject.mockReturnValue(project);
    mockAppState.getWorkspaceProvider.mockReturnValue(mockProvider);
    mockProvider.listBases.mockResolvedValue(bases);

    const handler = createWorkspaceListBasesHandler(mockAppState);
    const payload: WorkspaceListBasesPayload = {
      projectPath: "/test/repo",
    };

    const result = await handler(mockEvent, payload);

    expect(mockProvider.listBases).toHaveBeenCalled();
    expect(result).toEqual(bases);
  });

  it("throws for closed project", async () => {
    const mockAppState = createMockAppState();

    mockAppState.getProject.mockReturnValue(undefined);

    const handler = createWorkspaceListBasesHandler(mockAppState);
    const payload: WorkspaceListBasesPayload = {
      projectPath: "/test/repo",
    };

    await expect(handler(mockEvent, payload)).rejects.toThrow("Project not open");
  });
});

describe("workspace:update-bases handler", () => {
  it("fetches from remotes", async () => {
    const mockAppState = createMockAppState();
    const mockProvider = createMockProvider();

    const project: Project = {
      path: "/test/repo" as ProjectPath,
      name: "repo",
      workspaces: [],
    };
    const updateResult = {
      fetchedRemotes: ["origin"],
      failedRemotes: [],
    };

    mockAppState.getProject.mockReturnValue(project);
    mockAppState.getWorkspaceProvider.mockReturnValue(mockProvider);
    mockProvider.updateBases.mockResolvedValue(updateResult);

    const handler = createWorkspaceUpdateBasesHandler(mockAppState);
    const payload: WorkspaceUpdateBasesPayload = {
      projectPath: "/test/repo",
    };

    const result = await handler(mockEvent, payload);

    expect(mockProvider.updateBases).toHaveBeenCalled();
    expect(result).toEqual(updateResult);
  });
});

describe("workspace:is-dirty handler", () => {
  it("returns true for dirty workspace", async () => {
    const mockAppState = createMockAppState();
    const mockProvider = createMockProvider();

    const project: Project = {
      path: "/test/repo" as ProjectPath,
      name: "repo",
      workspaces: [{ name: "ws1", path: "/test/repo/.worktrees/ws1", branch: "ws1" }],
    };

    mockAppState.findProjectForWorkspace.mockReturnValue(project);
    mockAppState.getWorkspaceProvider.mockReturnValue(mockProvider);
    mockProvider.isDirty.mockResolvedValue(true);

    const handler = createWorkspaceIsDirtyHandler(mockAppState);
    const payload: WorkspaceIsDirtyPayload = {
      workspacePath: "/test/repo/.worktrees/ws1",
    };

    const result = await handler(mockEvent, payload);

    expect(mockProvider.isDirty).toHaveBeenCalledWith("/test/repo/.worktrees/ws1");
    expect(result).toBe(true);
  });

  it("returns false for clean workspace", async () => {
    const mockAppState = createMockAppState();
    const mockProvider = createMockProvider();

    const project: Project = {
      path: "/test/repo" as ProjectPath,
      name: "repo",
      workspaces: [{ name: "ws1", path: "/test/repo/.worktrees/ws1", branch: "ws1" }],
    };

    mockAppState.findProjectForWorkspace.mockReturnValue(project);
    mockAppState.getWorkspaceProvider.mockReturnValue(mockProvider);
    mockProvider.isDirty.mockResolvedValue(false);

    const handler = createWorkspaceIsDirtyHandler(mockAppState);
    const payload: WorkspaceIsDirtyPayload = {
      workspacePath: "/test/repo/.worktrees/ws1",
    };

    const result = await handler(mockEvent, payload);

    expect(result).toBe(false);
  });
});
