/**
 * Preload script for the UI layer.
 * Exposes type-safe IPC API via contextBridge.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { ApiIpcChannels } from "../shared/ipc";
import type { UiEvent } from "../shared/ui-event";
import type { UiState } from "../shared/ui-state";

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
  // Renderer→main gestures are fire-and-forget ui:events (emitEvent) and the
  // dialog/notification framework events below; there are no invoke commands.
  // main→renderer state arrives on onState (api:ui:state). Dialog/notification
  // user interactions are carried as ui:event kinds via emitEvent.

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
   * Subscribe to theme change events from main process.
   * Fired once on startup with the initial theme and again whenever the OS theme changes.
   * @param callback - Called with "dark" or "light"
   * @returns Unsubscribe function to remove the listener
   */
  onTheme: createEventSubscription<"dark" | "light">(ApiIpcChannels.UI_THEME),
});
