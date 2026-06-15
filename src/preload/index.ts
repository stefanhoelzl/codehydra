/**
 * Preload script for the UI layer.
 * Exposes type-safe IPC API via contextBridge.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { ApiIpcChannels } from "../shared/ipc";
import type { UIModeChangedEvent } from "../shared/ipc";
import type { UiEvent } from "../shared/ui-event";
import type { UiState } from "../shared/ui-state";
import type { DialogUserEvent } from "../shared/dialog-types";
import type { NotificationUserEvent } from "../shared/notification-types";
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
  // Primary API backed by intent dispatcher.
  // Lifecycle handlers are registered in bootstrap(), others in startServices().

  projects: {
    open: (path?: string) =>
      ipcRenderer.invoke(ApiIpcChannels.PROJECT_OPEN, {
        ...(path !== undefined && { path }),
      }),
  },
  workspaces: {
    hibernate: (workspacePath: string) =>
      ipcRenderer.invoke(ApiIpcChannels.WORKSPACE_HIBERNATE, { workspacePath }),
    wake: (workspacePath: string) =>
      ipcRenderer.invoke(ApiIpcChannels.WORKSPACE_WAKE, { workspacePath }),
  },
  ui: {
    switchWorkspace: (workspacePath: string | null, focus?: boolean) =>
      ipcRenderer.invoke(ApiIpcChannels.UI_SWITCH_WORKSPACE, { workspacePath, focus }),
    setMode: (mode: string) => ipcRenderer.invoke(ApiIpcChannels.UI_SET_MODE, { mode }),
  },
  lifecycle: {
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
  /**
   * Emit a UI event to the main process (renderer → main, fire-and-forget).
   * Validated with zod on the main side; invalid events are dropped there.
   */
  emitEvent: (event: UiEvent) => {
    ipcRenderer.send(ApiIpcChannels.UI_EVENT, event);
  },
  /**
   * Subscribe to UI state snapshots (main → renderer). The presenter pushes
   * the full render-ready UiState on every change.
   */
  onState: createEventSubscription<UiState>(ApiIpcChannels.UI_STATE),
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

  /**
   * Subscribe to theme change events from main process.
   * Fired once on startup with the initial theme and again whenever the OS theme changes.
   * @param callback - Called with "dark" or "light"
   * @returns Unsubscribe function to remove the listener
   */
  onTheme: createEventSubscription<"dark" | "light">(ApiIpcChannels.UI_THEME),
});
