/**
 * Workspace-related IPC handlers.
 */

import type { IpcMainInvokeEvent } from "electron";
import type { AppState } from "../app-state";
import type { IViewManager } from "../managers/view-manager.interface";
import type {
  Workspace,
  BaseInfo,
  RemovalResult,
  UpdateBasesResult,
  WorkspaceCreatePayload,
  WorkspaceRemovePayload,
  WorkspaceSwitchPayload,
  WorkspaceListBasesPayload,
  WorkspaceUpdateBasesPayload,
  WorkspaceIsDirtyPayload,
  ProjectPath,
  WorkspacePath,
} from "../../shared/ipc";
import { WorkspaceError } from "../../services/errors";
import { emitEvent } from "./handlers";

/**
 * Creates a handler for workspace:create.
 * Creates a new workspace, creates its view, and sets it as active.
 */
export function createWorkspaceCreateHandler(
  // setLastBaseBranch is included to save the base branch used for workspace creation.
  // This enables the CreateWorkspaceDialog to pre-select the last-used branch as the default
  // when opening the dialog again for the same project.
  appState: Pick<
    AppState,
    "getProject" | "getWorkspaceProvider" | "getWorkspaceUrl" | "addWorkspace" | "setLastBaseBranch"
  >,
  viewManager: Pick<IViewManager, "setActiveWorkspace">
): (event: IpcMainInvokeEvent, payload: WorkspaceCreatePayload) => Promise<Workspace> {
  return async (_event, payload) => {
    const project = appState.getProject(payload.projectPath);
    if (!project) {
      throw new WorkspaceError("Project not open", "PROJECT_NOT_OPEN");
    }

    const provider = appState.getWorkspaceProvider(payload.projectPath);
    if (!provider) {
      throw new WorkspaceError("Workspace provider not found", "PROVIDER_NOT_FOUND");
    }

    // Create the workspace via git worktree
    const workspace = await provider.createWorkspace(payload.name, payload.baseBranch);

    // Add workspace to app state (this also creates the view)
    appState.addWorkspace(payload.projectPath, workspace);

    // Set as active workspace (focuses by default)
    viewManager.setActiveWorkspace(workspace.path);

    // Emit event with the base branch to update project's defaultBaseBranch in renderer
    emitEvent("workspace:created", {
      projectPath: payload.projectPath as ProjectPath,
      workspace,
      defaultBaseBranch: payload.baseBranch,
    });

    // Save the base branch as the last used for this project
    appState.setLastBaseBranch(payload.projectPath, payload.baseBranch);

    return workspace;
  };
}

/**
 * Creates a handler for workspace:remove.
 * Removes a workspace and destroys its view.
 * If the removed workspace was active, automatically selects the next workspace.
 */
export function createWorkspaceRemoveHandler(
  appState: Pick<
    AppState,
    "findProjectForWorkspace" | "getWorkspaceProvider" | "removeWorkspace" | "getAllProjects"
  >,
  viewManager: Pick<IViewManager, "getActiveWorkspacePath" | "setActiveWorkspace">
): (event: IpcMainInvokeEvent, payload: WorkspaceRemovePayload) => Promise<RemovalResult> {
  return async (_event, payload) => {
    const project = appState.findProjectForWorkspace(payload.workspacePath);
    if (!project) {
      throw new WorkspaceError("Workspace not found", "WORKSPACE_NOT_FOUND");
    }

    const provider = appState.getWorkspaceProvider(project.path);
    if (!provider) {
      throw new WorkspaceError("Workspace provider not found", "PROVIDER_NOT_FOUND");
    }

    // Check if we're removing the active workspace
    const wasActive = viewManager.getActiveWorkspacePath() === payload.workspacePath;

    // Remove the workspace via git worktree
    const result = await provider.removeWorkspace(payload.workspacePath, payload.deleteBranch);

    // Remove workspace from app state (this also destroys the view)
    appState.removeWorkspace(project.path, payload.workspacePath);

    // Emit removed event
    emitEvent("workspace:removed", {
      projectPath: project.path as ProjectPath,
      workspacePath: payload.workspacePath as WorkspacePath,
    });

    // If the removed workspace was active, select the next workspace
    if (wasActive) {
      const nextWorkspacePath = findNextWorkspace(await appState.getAllProjects(), project.path);
      viewManager.setActiveWorkspace(nextWorkspacePath);

      // Emit switched event so renderer updates (even when null, so UI shows empty state)
      emitEvent("workspace:switched", {
        workspacePath: nextWorkspacePath as WorkspacePath | null,
      });
    }

    return result;
  };
}

/**
 * Finds the next workspace to select after removal.
 * Priority: same project first, then other projects.
 *
 * @param projects - All open projects
 * @param currentProjectPath - Path of the project that had a workspace removed
 * @returns Path of the next workspace to select, or null if none available
 */
function findNextWorkspace(
  projects: readonly { readonly path: string; readonly workspaces: readonly { path: string }[] }[],
  currentProjectPath: string
): string | null {
  // First try to find a workspace in the same project
  const currentProject = projects.find((p) => p.path === currentProjectPath);
  if (currentProject && currentProject.workspaces.length > 0) {
    return currentProject.workspaces[0]?.path ?? null;
  }

  // Otherwise find first workspace in any project
  for (const project of projects) {
    if (project.workspaces.length > 0) {
      return project.workspaces[0]?.path ?? null;
    }
  }

  return null;
}

/**
 * Creates a handler for workspace:switch.
 * Switches the active workspace.
 */
export function createWorkspaceSwitchHandler(
  appState: Pick<AppState, "findProjectForWorkspace">,
  viewManager: Pick<IViewManager, "setActiveWorkspace" | "focusUI">
): (event: IpcMainInvokeEvent, payload: WorkspaceSwitchPayload) => Promise<void> {
  return async (_event, payload) => {
    const project = appState.findProjectForWorkspace(payload.workspacePath);
    if (!project) {
      throw new WorkspaceError("Workspace not found", "WORKSPACE_NOT_FOUND");
    }

    // Set active workspace, skipping focus if explicitly requested (e.g., during shortcut mode navigation)
    viewManager.setActiveWorkspace(payload.workspacePath, payload.focusWorkspace !== false);

    // Emit event
    emitEvent("workspace:switched", {
      workspacePath: payload.workspacePath as WorkspacePath,
    });
  };
}

/**
 * Creates a handler for workspace:list-bases.
 * Lists available branches for workspace creation.
 */
export function createWorkspaceListBasesHandler(
  appState: Pick<AppState, "getProject" | "getWorkspaceProvider">
): (event: IpcMainInvokeEvent, payload: WorkspaceListBasesPayload) => Promise<BaseInfo[]> {
  return async (_event, payload) => {
    const project = appState.getProject(payload.projectPath);
    if (!project) {
      throw new WorkspaceError("Project not open", "PROJECT_NOT_OPEN");
    }

    const provider = appState.getWorkspaceProvider(payload.projectPath);
    if (!provider) {
      throw new WorkspaceError("Workspace provider not found", "PROVIDER_NOT_FOUND");
    }

    const bases = await provider.listBases();
    return [...bases]; // Convert readonly array to mutable for IPC
  };
}

/**
 * Creates a handler for workspace:update-bases.
 * Fetches from remotes to update available branches.
 */
export function createWorkspaceUpdateBasesHandler(
  appState: Pick<AppState, "getProject" | "getWorkspaceProvider">
): (event: IpcMainInvokeEvent, payload: WorkspaceUpdateBasesPayload) => Promise<UpdateBasesResult> {
  return async (_event, payload) => {
    const project = appState.getProject(payload.projectPath);
    if (!project) {
      throw new WorkspaceError("Project not open", "PROJECT_NOT_OPEN");
    }

    const provider = appState.getWorkspaceProvider(payload.projectPath);
    if (!provider) {
      throw new WorkspaceError("Workspace provider not found", "PROVIDER_NOT_FOUND");
    }

    return provider.updateBases();
  };
}

/**
 * Creates a handler for workspace:is-dirty.
 * Checks if a workspace has uncommitted changes.
 */
export function createWorkspaceIsDirtyHandler(
  appState: Pick<AppState, "findProjectForWorkspace" | "getWorkspaceProvider">
): (event: IpcMainInvokeEvent, payload: WorkspaceIsDirtyPayload) => Promise<boolean> {
  return async (_event, payload) => {
    const project = appState.findProjectForWorkspace(payload.workspacePath);
    if (!project) {
      throw new WorkspaceError("Workspace not found", "WORKSPACE_NOT_FOUND");
    }

    const provider = appState.getWorkspaceProvider(project.path);
    if (!provider) {
      throw new WorkspaceError("Workspace provider not found", "PROVIDER_NOT_FOUND");
    }

    return provider.isDirty(payload.workspacePath);
  };
}
