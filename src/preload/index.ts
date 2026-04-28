/**
 * Preload script for the UI layer.
 * Exposes type-safe IPC API via contextBridge.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { ApiIpcChannels } from "../shared/ipc";
import type { UIModeChangedEvent, LogContext } from "../shared/ipc";
import type { DialogUserEvent } from "../shared/dialog-types";
import type { NotificationUserEvent } from "../shared/notification-types";
import type { ShortcutKey } from "../shared/shortcuts";
import type { InitialPrompt } from "../shared/api/types";

/**
 * Function to unsubscribe from an event.
 */
type Unsubscribe = () => void;

/**
 * Creates a type-safe event subscription function.
 */
function createEventSubscription<T>(channel: string) {
  return (callback: (event: T) => void): Unsubscribe => {
    const handler = (_event: IpcRendererEvent, data: T) => callback(data);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  };
}

// Expose the API to the renderer process
contextBridge.exposeInMainWorld("api", {
  // ============ API (api: prefixed channels) ============
  // Primary API backed by intent dispatcher.
  // Lifecycle handlers are registered in bootstrap(), others in startServices().

  projects: {
    open: (path?: string) =>
      ipcRenderer.invoke(ApiIpcChannels.PROJECT_OPEN, {
        ...(path !== undefined && { path }),
      }),
    close: (projectPath: string, options?: { removeLocalRepo?: boolean }) =>
      ipcRenderer.invoke(ApiIpcChannels.PROJECT_CLOSE, { projectPath, ...options }),
    clone: (url: string) => ipcRenderer.invoke(ApiIpcChannels.PROJECT_CLONE, { url }),
    fetchBases: (projectPath: string) =>
      ipcRenderer.invoke(ApiIpcChannels.PROJECT_FETCH_BASES, { projectPath }),
  },
  workspaces: {
    create: (
      projectPath: string,
      name: string,
      base: string,
      options?: { initialPrompt?: InitialPrompt; stealFocus?: boolean }
    ) =>
      ipcRenderer.invoke(ApiIpcChannels.WORKSPACE_CREATE, {
        projectPath,
        name,
        base,
        ...options,
      }),
    remove: (
      workspacePath: string,
      options?: {
        keepBranch?: boolean;
        skipSwitch?: boolean;
        force?: boolean;
        ignoreWarnings?: boolean;
        blockingPids?: readonly number[];
      }
    ): Promise<{ started: boolean }> =>
      ipcRenderer.invoke(ApiIpcChannels.WORKSPACE_REMOVE, {
        workspacePath,
        ...options,
      }),
    getStatus: (workspacePath: string) =>
      ipcRenderer.invoke(ApiIpcChannels.WORKSPACE_GET_STATUS, { workspacePath }),
    getAgentSession: (workspacePath: string) =>
      ipcRenderer.invoke(ApiIpcChannels.WORKSPACE_GET_AGENT_SESSION, { workspacePath }),
    setMetadata: (workspacePath: string, key: string, value: string | null) =>
      ipcRenderer.invoke(ApiIpcChannels.WORKSPACE_SET_METADATA, {
        workspacePath,
        key,
        value,
      }),
    getMetadata: (workspacePath: string) =>
      ipcRenderer.invoke(ApiIpcChannels.WORKSPACE_GET_METADATA, { workspacePath }),
    hibernate: (workspacePath: string, options?: { skipSwitch?: boolean }) =>
      ipcRenderer.invoke(ApiIpcChannels.WORKSPACE_HIBERNATE, { workspacePath, ...options }),
    wake: (workspacePath: string) =>
      ipcRenderer.invoke(ApiIpcChannels.WORKSPACE_WAKE, { workspacePath }),
    reopen: (
      projectPath: string,
      workspacePath: string,
      workspaceName: string,
      branch: string | null,
      metadata: Readonly<Record<string, string>>
    ) =>
      ipcRenderer.invoke(ApiIpcChannels.WORKSPACE_REOPEN, {
        projectPath,
        workspacePath,
        workspaceName,
        branch,
        metadata,
      }),
    getScreenshot: (projectId: string, workspaceName: string) =>
      ipcRenderer.invoke(ApiIpcChannels.WORKSPACE_GET_SCREENSHOT, { projectId, workspaceName }),
  },
  ui: {
    getActiveWorkspace: () => ipcRenderer.invoke(ApiIpcChannels.UI_GET_ACTIVE_WORKSPACE),
    switchWorkspace: (workspacePath: string, focus?: boolean) =>
      ipcRenderer.invoke(ApiIpcChannels.UI_SWITCH_WORKSPACE, { workspacePath, focus }),
    setMode: (mode: string) => ipcRenderer.invoke(ApiIpcChannels.UI_SET_MODE, { mode }),
  },
  lifecycle: {
    ready: () => ipcRenderer.invoke(ApiIpcChannels.LIFECYCLE_READY),
    quit: () => ipcRenderer.invoke(ApiIpcChannels.LIFECYCLE_QUIT),
  },
  /**
   * Send dialog user event to main process.
   * Used when the user interacts with a declarative dialog (clicks an action button).
   */
  sendDialogEvent: (event: DialogUserEvent) => {
    ipcRenderer.send(ApiIpcChannels.DIALOG_EVENT, event);
  },
  /**
   * Send notification user event to main process.
   * Used when the user interacts with a sidebar notification (dismiss or action button).
   */
  sendNotificationEvent: (event: NotificationUserEvent) => {
    ipcRenderer.send(ApiIpcChannels.NOTIFICATION_EVENT, event);
  },
  // Log API (renderer → main, fire-and-forget)
  log: {
    debug: (logger: string, message: string, context?: LogContext) =>
      ipcRenderer.send(ApiIpcChannels.LOG_DEBUG, { logger, message, context }),
    info: (logger: string, message: string, context?: LogContext) =>
      ipcRenderer.send(ApiIpcChannels.LOG_INFO, { logger, message, context }),
    warn: (logger: string, message: string, context?: LogContext) =>
      ipcRenderer.send(ApiIpcChannels.LOG_WARN, { logger, message, context }),
    error: (logger: string, message: string, context?: LogContext) =>
      ipcRenderer.send(ApiIpcChannels.LOG_ERROR, { logger, message, context }),
  },
  // Event subscription using api: prefixed channels
  on: <T>(event: string, callback: (event: T) => void): Unsubscribe => {
    const channel = `api:${event}`;
    const handler = (_event: IpcRendererEvent, data: T) => callback(data);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },

  /**
   * Subscribe to UI mode change events.
   * @param callback - Called when UI mode changes (workspace, shortcut, dialog)
   * @returns Unsubscribe function to remove the listener
   */
  onModeChange: createEventSubscription<UIModeChangedEvent>(ApiIpcChannels.UI_MODE_CHANGED),

  /**
   * Subscribe to shortcut key events from main process.
   * Fired when a shortcut key is pressed while shortcut mode is active.
   * @param callback - Called with the normalized shortcut key (e.g., "up", "down", "enter", "0"-"9")
   * @returns Unsubscribe function to remove the listener
   */
  onShortcut: createEventSubscription<ShortcutKey>(ApiIpcChannels.SHORTCUT_KEY),
});
