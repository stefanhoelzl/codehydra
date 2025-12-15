/**
 * API-based IPC handlers.
 *
 * These handlers are thin adapters that:
 * 1. Validate input
 * 2. Delegate to ICodeHydraApi methods
 * 3. Serialize responses
 *
 * Validation errors are thrown as Error instances.
 */

import { ipcMain, type WebContents } from "electron";
import * as path from "path";
import type { ICodeHydraApi, Unsubscribe } from "../../shared/api/interfaces";
import type { ProjectId, WorkspaceName } from "../../shared/api/types";
import { isProjectId, isWorkspaceName } from "../../shared/api/types";
import { ApiIpcChannels, type UIMode } from "../../shared/ipc";

// =============================================================================
// Validation Helpers
// =============================================================================

/**
 * Validation error thrown when input fails validation.
 */
class ApiValidationError extends Error {
  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = "ApiValidationError";
  }
}

/**
 * Validate that a value is a non-empty string.
 */
function validateString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ApiValidationError(field, "must be a non-empty string");
  }
  return value;
}

/**
 * Validate that a path is absolute.
 */
function validateAbsolutePath(value: unknown, field: string): string {
  const str = validateString(value, field);
  if (!path.isAbsolute(str)) {
    throw new ApiValidationError(field, "must be an absolute path");
  }
  return str;
}

/**
 * Validate that a value is a valid ProjectId.
 */
function validateProjectId(value: unknown, field: string): ProjectId {
  const str = validateString(value, field);
  if (!isProjectId(str)) {
    throw new ApiValidationError(field, "must be a valid ProjectId (format: name-xxxxxxxx)");
  }
  return str;
}

/**
 * Validate that a value is a valid WorkspaceName.
 */
function validateWorkspaceName(value: unknown, field: string): WorkspaceName {
  const str = validateString(value, field);
  if (!isWorkspaceName(str)) {
    throw new ApiValidationError(
      field,
      "must be a valid WorkspaceName (1-100 chars, alphanumeric start)"
    );
  }
  return str;
}

/**
 * Validate that a value is a boolean.
 */
function validateBoolean(value: unknown, field: string, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  if (typeof value !== "boolean") {
    throw new ApiValidationError(field, "must be a boolean");
  }
  return value;
}

/**
 * Valid UI modes.
 */
const VALID_UI_MODES: readonly UIMode[] = ["workspace", "dialog", "shortcut"];

/**
 * Validate that a value is a valid UIMode.
 */
function validateUIMode(value: unknown, field: string): UIMode {
  const str = validateString(value, field);
  if (!VALID_UI_MODES.includes(str as UIMode)) {
    throw new ApiValidationError(field, `must be one of: ${VALID_UI_MODES.join(", ")}`);
  }
  return str as UIMode;
}

// =============================================================================
// Handler Registration
// =============================================================================

/**
 * Register all API-based IPC handlers.
 *
 * @param api - The ICodeHydraApi instance to delegate to
 */
export function registerApiHandlers(api: ICodeHydraApi): void {
  // ---------------------------------------------------------------------------
  // Project API
  // ---------------------------------------------------------------------------

  ipcMain.handle(ApiIpcChannels.PROJECT_OPEN, async (_event, payload: unknown) => {
    const p = payload as Record<string, unknown>;
    const projectPath = validateAbsolutePath(p?.path, "path");
    return await api.projects.open(projectPath);
  });

  ipcMain.handle(ApiIpcChannels.PROJECT_CLOSE, async (_event, payload: unknown) => {
    const p = payload as Record<string, unknown>;
    const projectId = validateProjectId(p?.projectId, "projectId");
    return await api.projects.close(projectId);
  });

  ipcMain.handle(ApiIpcChannels.PROJECT_LIST, async () => {
    return await api.projects.list();
  });

  ipcMain.handle(ApiIpcChannels.PROJECT_GET, async (_event, payload: unknown) => {
    const p = payload as Record<string, unknown>;
    const projectId = validateProjectId(p?.projectId, "projectId");
    return await api.projects.get(projectId);
  });

  ipcMain.handle(ApiIpcChannels.PROJECT_FETCH_BASES, async (_event, payload: unknown) => {
    const p = payload as Record<string, unknown>;
    const projectId = validateProjectId(p?.projectId, "projectId");
    return await api.projects.fetchBases(projectId);
  });

  // ---------------------------------------------------------------------------
  // Workspace API
  // ---------------------------------------------------------------------------

  ipcMain.handle(ApiIpcChannels.WORKSPACE_CREATE, async (_event, payload: unknown) => {
    const p = payload as Record<string, unknown>;
    const projectId = validateProjectId(p?.projectId, "projectId");
    const name = validateString(p?.name, "name");
    const base = validateString(p?.base, "base");
    return await api.workspaces.create(projectId, name, base);
  });

  ipcMain.handle(ApiIpcChannels.WORKSPACE_REMOVE, async (_event, payload: unknown) => {
    const p = payload as Record<string, unknown>;
    const projectId = validateProjectId(p?.projectId, "projectId");
    const workspaceName = validateWorkspaceName(p?.workspaceName, "workspaceName");
    const keepBranch = validateBoolean(p?.keepBranch, "keepBranch", true);
    return await api.workspaces.remove(projectId, workspaceName, keepBranch);
  });

  ipcMain.handle(ApiIpcChannels.WORKSPACE_GET, async (_event, payload: unknown) => {
    const p = payload as Record<string, unknown>;
    const projectId = validateProjectId(p?.projectId, "projectId");
    const workspaceName = validateWorkspaceName(p?.workspaceName, "workspaceName");
    return await api.workspaces.get(projectId, workspaceName);
  });

  ipcMain.handle(ApiIpcChannels.WORKSPACE_GET_STATUS, async (_event, payload: unknown) => {
    const p = payload as Record<string, unknown>;
    const projectId = validateProjectId(p?.projectId, "projectId");
    const workspaceName = validateWorkspaceName(p?.workspaceName, "workspaceName");
    return await api.workspaces.getStatus(projectId, workspaceName);
  });

  // ---------------------------------------------------------------------------
  // UI API
  // ---------------------------------------------------------------------------

  ipcMain.handle(ApiIpcChannels.UI_SELECT_FOLDER, async () => {
    return await api.ui.selectFolder();
  });

  ipcMain.handle(ApiIpcChannels.UI_GET_ACTIVE_WORKSPACE, async () => {
    return await api.ui.getActiveWorkspace();
  });

  ipcMain.handle(ApiIpcChannels.UI_SWITCH_WORKSPACE, async (_event, payload: unknown) => {
    const p = payload as Record<string, unknown>;
    const projectId = validateProjectId(p?.projectId, "projectId");
    const workspaceName = validateWorkspaceName(p?.workspaceName, "workspaceName");
    const focus = validateBoolean(p?.focus, "focus", true);
    return await api.ui.switchWorkspace(projectId, workspaceName, focus);
  });

  ipcMain.handle(ApiIpcChannels.UI_SET_MODE, async (_event, payload: unknown) => {
    const p = payload as Record<string, unknown>;
    const mode = validateUIMode(p?.mode, "mode");
    return await api.ui.setMode(mode);
  });

  // ---------------------------------------------------------------------------
  // Lifecycle API
  // ---------------------------------------------------------------------------

  ipcMain.handle(ApiIpcChannels.LIFECYCLE_GET_STATE, async () => {
    return await api.lifecycle.getState();
  });

  ipcMain.handle(ApiIpcChannels.LIFECYCLE_SETUP, async () => {
    return await api.lifecycle.setup();
  });

  ipcMain.handle(ApiIpcChannels.LIFECYCLE_QUIT, async () => {
    return await api.lifecycle.quit();
  });
}

// =============================================================================
// Event Wiring
// =============================================================================

/**
 * Wire API events to IPC emission.
 *
 * Subscribes to all API events and forwards them to the renderer via webContents.send().
 *
 * @param api - The ICodeHydraApi instance to subscribe to
 * @param getWebContents - Function to get the WebContents to send events to
 * @returns Cleanup function that unsubscribes from all events
 */
export function wireApiEvents(
  api: ICodeHydraApi,
  getWebContents: () => WebContents | null
): Unsubscribe {
  const unsubscribers: Unsubscribe[] = [];

  // Helper to send events to renderer
  const send = (channel: string, payload?: unknown): void => {
    const webContents = getWebContents();
    if (webContents && !webContents.isDestroyed()) {
      webContents.send(channel, payload);
    }
  };

  // Project events
  unsubscribers.push(
    api.on("project:opened", (event) => {
      send(ApiIpcChannels.PROJECT_OPENED, event);
    })
  );

  unsubscribers.push(
    api.on("project:closed", (event) => {
      send(ApiIpcChannels.PROJECT_CLOSED, event);
    })
  );

  unsubscribers.push(
    api.on("project:bases-updated", (event) => {
      send(ApiIpcChannels.PROJECT_BASES_UPDATED, event);
    })
  );

  // Workspace events
  unsubscribers.push(
    api.on("workspace:created", (event) => {
      send(ApiIpcChannels.WORKSPACE_CREATED, event);
    })
  );

  unsubscribers.push(
    api.on("workspace:removed", (event) => {
      send(ApiIpcChannels.WORKSPACE_REMOVED, event);
    })
  );

  unsubscribers.push(
    api.on("workspace:switched", (event) => {
      send(ApiIpcChannels.WORKSPACE_SWITCHED, event);
    })
  );

  unsubscribers.push(
    api.on("workspace:status-changed", (event) => {
      send(ApiIpcChannels.WORKSPACE_STATUS_CHANGED, event);
    })
  );

  // UI mode events
  unsubscribers.push(
    api.on("ui:mode-changed", (event) => {
      send(ApiIpcChannels.UI_MODE_CHANGED, event);
    })
  );

  // Setup events
  unsubscribers.push(
    api.on("setup:progress", (event) => {
      send(ApiIpcChannels.SETUP_PROGRESS, event);
    })
  );

  // Return cleanup function
  return () => {
    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }
  };
}
