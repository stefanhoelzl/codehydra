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
import { isProjectId, isWorkspaceName, isValidMetadataKey } from "../../shared/api/types";
import { ApiIpcChannels, type UIMode } from "../../shared/ipc";
import type { Logger } from "../../services/logging";

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
const VALID_UI_MODES: readonly UIMode[] = ["workspace", "dialog", "shortcut", "hover"];

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

/**
 * Validate that a value is a valid metadata key.
 */
function validateMetadataKey(value: unknown, field: string): string {
  const str = validateString(value, field);
  if (!isValidMetadataKey(str)) {
    throw new ApiValidationError(
      field,
      "must be a valid metadata key (start with letter, contain only letters/digits/hyphens, no trailing hyphen)"
    );
  }
  return str;
}

/**
 * Validate that a value is a string or null.
 */
function validateStringOrNull(value: unknown, field: string): string | null {
  if (value === null) return null;
  return validateString(value, field);
}

// =============================================================================
// Logging Wrapper
// =============================================================================

/**
 * Execute a handler with logging for timing and errors.
 * Logs request/response/error at DEBUG/DEBUG/WARN levels.
 *
 * @param logger - Logger for the [api] scope
 * @param channel - IPC channel name for logging
 * @param fn - Handler function to execute
 */
async function logged<T>(logger: Logger, channel: string, fn: () => Promise<T>): Promise<T> {
  const startTime = Date.now();
  logger.debug("Request", { channel });
  try {
    const result = await fn();
    const duration = Date.now() - startTime;
    logger.debug("Response", { channel, duration });
    return result;
  } catch (error) {
    const duration = Date.now() - startTime;
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Error", { channel, error: message, duration });
    throw error;
  }
}

// =============================================================================
// Handler Registration
// =============================================================================

/**
 * Register all API-based IPC handlers.
 *
 * @param api - The ICodeHydraApi instance to delegate to
 * @param logger - Logger for the [api] scope
 */
export function registerApiHandlers(api: ICodeHydraApi, logger: Logger): void {
  // ---------------------------------------------------------------------------
  // Project API
  // ---------------------------------------------------------------------------

  ipcMain.handle(ApiIpcChannels.PROJECT_OPEN, async (_event, payload: unknown) =>
    logged(logger, ApiIpcChannels.PROJECT_OPEN, async () => {
      const p = payload as Record<string, unknown>;
      const projectPath = validateAbsolutePath(p?.path, "path");
      return await api.projects.open(projectPath);
    })
  );

  ipcMain.handle(ApiIpcChannels.PROJECT_CLOSE, async (_event, payload: unknown) =>
    logged(logger, ApiIpcChannels.PROJECT_CLOSE, async () => {
      const p = payload as Record<string, unknown>;
      const projectId = validateProjectId(p?.projectId, "projectId");
      return await api.projects.close(projectId);
    })
  );

  ipcMain.handle(ApiIpcChannels.PROJECT_LIST, async () =>
    logged(logger, ApiIpcChannels.PROJECT_LIST, async () => {
      return await api.projects.list();
    })
  );

  ipcMain.handle(ApiIpcChannels.PROJECT_GET, async (_event, payload: unknown) =>
    logged(logger, ApiIpcChannels.PROJECT_GET, async () => {
      const p = payload as Record<string, unknown>;
      const projectId = validateProjectId(p?.projectId, "projectId");
      return await api.projects.get(projectId);
    })
  );

  ipcMain.handle(ApiIpcChannels.PROJECT_FETCH_BASES, async (_event, payload: unknown) =>
    logged(logger, ApiIpcChannels.PROJECT_FETCH_BASES, async () => {
      const p = payload as Record<string, unknown>;
      const projectId = validateProjectId(p?.projectId, "projectId");
      return await api.projects.fetchBases(projectId);
    })
  );

  // ---------------------------------------------------------------------------
  // Workspace API
  // ---------------------------------------------------------------------------

  ipcMain.handle(ApiIpcChannels.WORKSPACE_CREATE, async (_event, payload: unknown) =>
    logged(logger, ApiIpcChannels.WORKSPACE_CREATE, async () => {
      const p = payload as Record<string, unknown>;
      const projectId = validateProjectId(p?.projectId, "projectId");
      const name = validateString(p?.name, "name");
      const base = validateString(p?.base, "base");
      return await api.workspaces.create(projectId, name, base);
    })
  );

  ipcMain.handle(ApiIpcChannels.WORKSPACE_REMOVE, async (_event, payload: unknown) =>
    logged(logger, ApiIpcChannels.WORKSPACE_REMOVE, async () => {
      const p = payload as Record<string, unknown>;
      const projectId = validateProjectId(p?.projectId, "projectId");
      const workspaceName = validateWorkspaceName(p?.workspaceName, "workspaceName");
      const keepBranch = validateBoolean(p?.keepBranch, "keepBranch", true);
      return await api.workspaces.remove(projectId, workspaceName, keepBranch);
    })
  );

  ipcMain.handle(ApiIpcChannels.WORKSPACE_FORCE_REMOVE, async (_event, payload: unknown) =>
    logged(logger, ApiIpcChannels.WORKSPACE_FORCE_REMOVE, async () => {
      const p = payload as Record<string, unknown>;
      const projectId = validateProjectId(p?.projectId, "projectId");
      const workspaceName = validateWorkspaceName(p?.workspaceName, "workspaceName");
      return await api.workspaces.forceRemove(projectId, workspaceName);
    })
  );

  ipcMain.handle(ApiIpcChannels.WORKSPACE_GET, async (_event, payload: unknown) =>
    logged(logger, ApiIpcChannels.WORKSPACE_GET, async () => {
      const p = payload as Record<string, unknown>;
      const projectId = validateProjectId(p?.projectId, "projectId");
      const workspaceName = validateWorkspaceName(p?.workspaceName, "workspaceName");
      return await api.workspaces.get(projectId, workspaceName);
    })
  );

  ipcMain.handle(ApiIpcChannels.WORKSPACE_GET_STATUS, async (_event, payload: unknown) =>
    logged(logger, ApiIpcChannels.WORKSPACE_GET_STATUS, async () => {
      const p = payload as Record<string, unknown>;
      const projectId = validateProjectId(p?.projectId, "projectId");
      const workspaceName = validateWorkspaceName(p?.workspaceName, "workspaceName");
      return await api.workspaces.getStatus(projectId, workspaceName);
    })
  );

  ipcMain.handle(ApiIpcChannels.WORKSPACE_GET_OPENCODE_PORT, async (_event, payload: unknown) =>
    logged(logger, ApiIpcChannels.WORKSPACE_GET_OPENCODE_PORT, async () => {
      const p = payload as Record<string, unknown>;
      const projectId = validateProjectId(p?.projectId, "projectId");
      const workspaceName = validateWorkspaceName(p?.workspaceName, "workspaceName");
      return await api.workspaces.getOpencodePort(projectId, workspaceName);
    })
  );

  ipcMain.handle(ApiIpcChannels.WORKSPACE_SET_METADATA, async (_event, payload: unknown) =>
    logged(logger, ApiIpcChannels.WORKSPACE_SET_METADATA, async () => {
      const p = payload as Record<string, unknown>;
      const projectId = validateProjectId(p?.projectId, "projectId");
      const workspaceName = validateWorkspaceName(p?.workspaceName, "workspaceName");
      const key = validateMetadataKey(p?.key, "key");
      const value = validateStringOrNull(p?.value, "value");
      return await api.workspaces.setMetadata(projectId, workspaceName, key, value);
    })
  );

  ipcMain.handle(ApiIpcChannels.WORKSPACE_GET_METADATA, async (_event, payload: unknown) =>
    logged(logger, ApiIpcChannels.WORKSPACE_GET_METADATA, async () => {
      const p = payload as Record<string, unknown>;
      const projectId = validateProjectId(p?.projectId, "projectId");
      const workspaceName = validateWorkspaceName(p?.workspaceName, "workspaceName");
      return await api.workspaces.getMetadata(projectId, workspaceName);
    })
  );

  // ---------------------------------------------------------------------------
  // UI API
  // ---------------------------------------------------------------------------

  ipcMain.handle(ApiIpcChannels.UI_SELECT_FOLDER, async () =>
    logged(logger, ApiIpcChannels.UI_SELECT_FOLDER, async () => {
      return await api.ui.selectFolder();
    })
  );

  ipcMain.handle(ApiIpcChannels.UI_GET_ACTIVE_WORKSPACE, async () =>
    logged(logger, ApiIpcChannels.UI_GET_ACTIVE_WORKSPACE, async () => {
      return await api.ui.getActiveWorkspace();
    })
  );

  ipcMain.handle(ApiIpcChannels.UI_SWITCH_WORKSPACE, async (_event, payload: unknown) =>
    logged(logger, ApiIpcChannels.UI_SWITCH_WORKSPACE, async () => {
      const p = payload as Record<string, unknown>;
      const projectId = validateProjectId(p?.projectId, "projectId");
      const workspaceName = validateWorkspaceName(p?.workspaceName, "workspaceName");
      const focus = validateBoolean(p?.focus, "focus", true);
      return await api.ui.switchWorkspace(projectId, workspaceName, focus);
    })
  );

  ipcMain.handle(ApiIpcChannels.UI_SET_MODE, async (_event, payload: unknown) =>
    logged(logger, ApiIpcChannels.UI_SET_MODE, async () => {
      const p = payload as Record<string, unknown>;
      const mode = validateUIMode(p?.mode, "mode");
      return await api.ui.setMode(mode);
    })
  );

  // ---------------------------------------------------------------------------
  // Lifecycle API
  // ---------------------------------------------------------------------------
  // NOTE: Lifecycle handlers are registered separately via registerLifecycleHandlers()
  // in bootstrap(), BEFORE startServices() runs. This ensures they're available
  // immediately when the renderer loads (for lifecycle.getState() in onMount).
  // Do NOT register lifecycle handlers here - it would cause duplicate registration.
}

// =============================================================================
// Window Title Formatting
// =============================================================================

/**
 * Configuration for dynamic window title updates.
 */
export interface TitleConfig {
  /** Function to set the window title */
  setTitle: (title: string) => void;
  /** Default title (used when no workspace active) */
  defaultTitle: string;
  /** Dev branch name (from buildInfo.gitBranch), undefined in production */
  devBranch?: string;
  /** Function to resolve project name from workspace path */
  getProjectName: (workspacePath: string) => string | undefined;
}

/**
 * Formats the window title based on current workspace.
 *
 * Format: "CodeHydra - <project> / <workspace> - (<devBranch>)"
 * No workspace: "CodeHydra - (<devBranch>)" or "CodeHydra"
 *
 * @param projectName - Name of the active project, or undefined
 * @param workspaceName - Name of the active workspace, or undefined
 * @param devBranch - Development branch name (from buildInfo.gitBranch), or undefined
 * @returns Formatted window title
 */
export function formatWindowTitle(
  projectName: string | undefined,
  workspaceName: string | undefined,
  devBranch?: string
): string {
  const base = "CodeHydra";
  const devSuffix = devBranch ? ` - (${devBranch})` : "";

  if (projectName && workspaceName) {
    return `${base} - ${projectName} / ${workspaceName}${devSuffix}`;
  }

  return `${base}${devSuffix}`;
}

// =============================================================================
// Event Wiring
// =============================================================================

/**
 * Wire API events to IPC emission.
 *
 * Subscribes to all API events and forwards them to the renderer via webContents.send().
 * Optionally updates window title on workspace switches.
 *
 * @param api - The ICodeHydraApi instance to subscribe to
 * @param getWebContents - Function to get the WebContents to send events to
 * @param titleConfig - Optional configuration for window title updates
 * @returns Cleanup function that unsubscribes from all events
 */
export function wireApiEvents(
  api: ICodeHydraApi,
  getWebContents: () => WebContents | null,
  titleConfig?: TitleConfig
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

      // Update window title if configured
      if (titleConfig) {
        if (event) {
          const projectName = titleConfig.getProjectName(event.path);
          const title = formatWindowTitle(projectName, event.workspaceName, titleConfig.devBranch);
          titleConfig.setTitle(title);
        } else {
          titleConfig.setTitle(titleConfig.defaultTitle);
        }
      }
    })
  );

  unsubscribers.push(
    api.on("workspace:status-changed", (event) => {
      send(ApiIpcChannels.WORKSPACE_STATUS_CHANGED, event);
    })
  );

  unsubscribers.push(
    api.on("workspace:metadata-changed", (event) => {
      send(ApiIpcChannels.WORKSPACE_METADATA_CHANGED, event);
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
