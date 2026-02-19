/**
 * Preload script for the UI layer.
 * Exposes type-safe IPC API via contextBridge.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { ApiIpcChannels } from "../shared/ipc";
import type {
  UIModeChangedEvent,
  LogContext,
  LifecycleAgentType,
  AgentSelectedPayload,
} from "../shared/ipc";
import type { ShortcutKey } from "../shared/shortcuts";

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
  // Primary API using ICodeHydraApi-based backend.
  // Lifecycle handlers are registered in bootstrap(), others in startServices().

  projects: {
    open: (path: string) => ipcRenderer.invoke(ApiIpcChannels.PROJECT_OPEN, { path }),
    close: (projectId: string, options?: { removeLocalRepo?: boolean }) =>
      ipcRenderer.invoke(ApiIpcChannels.PROJECT_CLOSE, { projectId, ...options }),
    clone: (url: string) => ipcRenderer.invoke(ApiIpcChannels.PROJECT_CLONE, { url }),
    fetchBases: (projectId: string) =>
      ipcRenderer.invoke(ApiIpcChannels.PROJECT_FETCH_BASES, { projectId }),
  },
  workspaces: {
    create: (projectId: string, name: string, base: string) =>
      ipcRenderer.invoke(ApiIpcChannels.WORKSPACE_CREATE, { projectId, name, base }),
    remove: (
      projectId: string,
      workspaceName: string,
      options?: {
        keepBranch?: boolean;
        skipSwitch?: boolean;
        force?: boolean;
        workspacePath?: string;
      }
    ): Promise<{ started: boolean }> =>
      ipcRenderer.invoke(ApiIpcChannels.WORKSPACE_REMOVE, {
        projectId,
        workspaceName,
        ...options,
      }),
    getStatus: (projectId: string, workspaceName: string) =>
      ipcRenderer.invoke(ApiIpcChannels.WORKSPACE_GET_STATUS, { projectId, workspaceName }),
    getAgentSession: (projectId: string, workspaceName: string) =>
      ipcRenderer.invoke(ApiIpcChannels.WORKSPACE_GET_AGENT_SESSION, {
        projectId,
        workspaceName,
      }),
    setMetadata: (projectId: string, workspaceName: string, key: string, value: string | null) =>
      ipcRenderer.invoke(ApiIpcChannels.WORKSPACE_SET_METADATA, {
        projectId,
        workspaceName,
        key,
        value,
      }),
    getMetadata: (projectId: string, workspaceName: string) =>
      ipcRenderer.invoke(ApiIpcChannels.WORKSPACE_GET_METADATA, { projectId, workspaceName }),
  },
  ui: {
    selectFolder: () => ipcRenderer.invoke(ApiIpcChannels.UI_SELECT_FOLDER),
    getActiveWorkspace: () => ipcRenderer.invoke(ApiIpcChannels.UI_GET_ACTIVE_WORKSPACE),
    switchWorkspace: (projectId: string, workspaceName: string, focus?: boolean) =>
      ipcRenderer.invoke(ApiIpcChannels.UI_SWITCH_WORKSPACE, { projectId, workspaceName, focus }),
    setMode: (mode: string) => ipcRenderer.invoke(ApiIpcChannels.UI_SET_MODE, { mode }),
  },
  lifecycle: {
    ready: () => ipcRenderer.invoke(ApiIpcChannels.LIFECYCLE_READY),
    quit: () => ipcRenderer.invoke(ApiIpcChannels.LIFECYCLE_QUIT),
  },
  /**
   * Send agent selected event to main process.
   * Used when user selects an agent in the agent selection dialog.
   */
  sendAgentSelected: (agent: LifecycleAgentType) => {
    const payload: AgentSelectedPayload = { agent };
    ipcRenderer.send(ApiIpcChannels.LIFECYCLE_AGENT_SELECTED, payload);
  },
  /**
   * Send retry event to main process.
   * Used when user clicks retry after a setup/startup error.
   */
  sendRetry: () => {
    ipcRenderer.send(ApiIpcChannels.LIFECYCLE_RETRY);
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
