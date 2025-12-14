/**
 * Project-related IPC handlers.
 */

import { dialog, type IpcMainInvokeEvent } from "electron";
import type { AppState } from "../app-state";
import type { IViewManager } from "../managers/view-manager.interface";
import type {
  Project,
  ProjectOpenPayload,
  ProjectClosePayload,
  ProjectPath,
  ProjectListResponse,
} from "../../shared/ipc";
import { emitEvent } from "./handlers";

/**
 * Creates a handler for project:open.
 * Opens a project by path, validates it's a git repository.
 */
export function createProjectOpenHandler(
  appState: Pick<AppState, "openProject">
): (event: IpcMainInvokeEvent, payload: ProjectOpenPayload) => Promise<Project> {
  return async (_event, payload) => {
    const project = await appState.openProject(payload.path);
    emitEvent("project:opened", { project });
    return project;
  };
}

/**
 * Creates a handler for project:close.
 * Closes a project and destroys all its workspace views.
 */
export function createProjectCloseHandler(
  appState: Pick<AppState, "closeProject">
): (event: IpcMainInvokeEvent, payload: ProjectClosePayload) => Promise<void> {
  return async (_event, payload) => {
    await appState.closeProject(payload.path);
    emitEvent("project:closed", { path: payload.path as ProjectPath });
  };
}

/**
 * Creates a handler for project:list.
 * Returns all open projects and the currently active workspace path.
 */
export function createProjectListHandler(
  appState: Pick<AppState, "getAllProjects">,
  viewManager: Pick<IViewManager, "getActiveWorkspacePath">
): (event: IpcMainInvokeEvent, payload: void) => Promise<ProjectListResponse> {
  return async () => {
    return {
      projects: await appState.getAllProjects(),
      activeWorkspacePath: viewManager.getActiveWorkspacePath(),
    };
  };
}

/**
 * Creates a handler for project:select-folder.
 * Shows a folder picker dialog.
 */
export function createProjectSelectFolderHandler(): (
  event: IpcMainInvokeEvent,
  payload: void
) => Promise<string | null> {
  return async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
      title: "Select Git Repository",
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return result.filePaths[0] ?? null;
  };
}
