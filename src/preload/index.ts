/**
 * Preload script for the UI layer.
 * Exposes type-safe IPC API via contextBridge.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { IpcChannels, ApiIpcChannels } from "../shared/ipc";
import type {
  SetupProgress,
  SetupErrorPayload,
  SetupReadyResponse,
  UIModeChangedEvent,
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
  // ============ Setup Commands (registered early in bootstrap) ============
  // These use old IPC channels because they must be available before startServices() runs.
  // The lifecycle handlers are registered inside startServices(), so they're not
  // available during the setup flow.

  /**
   * Check if VS Code setup is complete.
   * Returns { ready: true } if setup done, { ready: false } if setup needed.
   * If setup is needed, main process will start setup asynchronously.
   */
  setupReady: (): Promise<SetupReadyResponse> => ipcRenderer.invoke(IpcChannels.SETUP_READY),

  /**
   * Retry setup after a failure.
   * Cleans vscode directory and re-runs setup.
   */
  setupRetry: (): Promise<void> => ipcRenderer.invoke(IpcChannels.SETUP_RETRY),

  /**
   * Quit the application (from setup error screen).
   */
  setupQuit: (): Promise<void> => ipcRenderer.invoke(IpcChannels.SETUP_QUIT),

  // ============ Setup Events ============

  /**
   * Subscribe to setup progress events.
   * @param callback - Called when setup progress updates
   * @returns Unsubscribe function to remove the listener
   */
  onSetupProgress: createEventSubscription<SetupProgress>(IpcChannels.SETUP_PROGRESS),

  /**
   * Subscribe to setup complete event.
   * @param callback - Called when setup completes successfully
   * @returns Unsubscribe function to remove the listener
   */
  onSetupComplete: createEventSubscription<void>(IpcChannels.SETUP_COMPLETE),

  /**
   * Subscribe to setup error events.
   * @param callback - Called when setup fails
   * @returns Unsubscribe function to remove the listener
   */
  onSetupError: createEventSubscription<SetupErrorPayload>(IpcChannels.SETUP_ERROR),

  // ============ Normal API (api: prefixed channels) ============
  // Primary API using ICodeHydraApi-based backend.
  // Registered in startServices() after setup completes.

  projects: {
    open: (path: string) => ipcRenderer.invoke(ApiIpcChannels.PROJECT_OPEN, { path }),
    close: (projectId: string) => ipcRenderer.invoke(ApiIpcChannels.PROJECT_CLOSE, { projectId }),
    list: () => ipcRenderer.invoke(ApiIpcChannels.PROJECT_LIST),
    get: (projectId: string) => ipcRenderer.invoke(ApiIpcChannels.PROJECT_GET, { projectId }),
    fetchBases: (projectId: string) =>
      ipcRenderer.invoke(ApiIpcChannels.PROJECT_FETCH_BASES, { projectId }),
  },
  workspaces: {
    create: (projectId: string, name: string, base: string) =>
      ipcRenderer.invoke(ApiIpcChannels.WORKSPACE_CREATE, { projectId, name, base }),
    remove: (projectId: string, workspaceName: string, keepBranch?: boolean) =>
      ipcRenderer.invoke(ApiIpcChannels.WORKSPACE_REMOVE, {
        projectId,
        workspaceName,
        keepBranch,
      }),
    get: (projectId: string, workspaceName: string) =>
      ipcRenderer.invoke(ApiIpcChannels.WORKSPACE_GET, { projectId, workspaceName }),
    getStatus: (projectId: string, workspaceName: string) =>
      ipcRenderer.invoke(ApiIpcChannels.WORKSPACE_GET_STATUS, { projectId, workspaceName }),
  },
  ui: {
    selectFolder: () => ipcRenderer.invoke(ApiIpcChannels.UI_SELECT_FOLDER),
    getActiveWorkspace: () => ipcRenderer.invoke(ApiIpcChannels.UI_GET_ACTIVE_WORKSPACE),
    switchWorkspace: (projectId: string, workspaceName: string, focus?: boolean) =>
      ipcRenderer.invoke(ApiIpcChannels.UI_SWITCH_WORKSPACE, { projectId, workspaceName, focus }),
    setDialogMode: (isOpen: boolean) =>
      ipcRenderer.invoke(ApiIpcChannels.UI_SET_DIALOG_MODE, { isOpen }),
    focusActiveWorkspace: () => ipcRenderer.invoke(ApiIpcChannels.UI_FOCUS_ACTIVE_WORKSPACE),
    setMode: (mode: string) => ipcRenderer.invoke(ApiIpcChannels.UI_SET_MODE, { mode }),
  },
  lifecycle: {
    getState: () => ipcRenderer.invoke(ApiIpcChannels.LIFECYCLE_GET_STATE),
    setup: () => ipcRenderer.invoke(ApiIpcChannels.LIFECYCLE_SETUP),
    quit: () => ipcRenderer.invoke(ApiIpcChannels.LIFECYCLE_QUIT),
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
