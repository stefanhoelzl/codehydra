/**
 * IpcBoundary - Abstraction over Electron IPC event listener registration.
 *
 * Provides an injectable interface for IPC event management, enabling:
 * - Integration testing of modules with behavioral mocks
 * - Boundary testing of DefaultIpcBoundary against real ipcMain
 *
 * Supports the fire-and-forget pattern only:
 * - on()/removeListener(): Fire-and-forget events (ipcMain.on)
 *
 * Renderer→main gestures flow through the `api:ui:event` channel and
 * main→renderer state through `api:ui:state` (sent via ViewBoundary's
 * webContents access); there are no request/response invoke handlers.
 */

import type { IpcMainEvent } from "electron";

/**
 * Handler function type for IPC event listeners (fire-and-forget).
 */
export type IpcEventHandler = (event: IpcMainEvent, ...args: unknown[]) => void;

/**
 * Abstraction over IPC event listener registration.
 */
export interface IpcBoundary {
  /**
   * Register a listener for a fire-and-forget IPC event from the renderer.
   * Multiple listeners can be registered for the same channel.
   *
   * @param channel - The IPC channel name
   * @param listener - The event handler function
   */
  on(channel: string, listener: IpcEventHandler): void;

  /**
   * Remove a specific listener for a fire-and-forget IPC event.
   *
   * @param channel - The IPC channel name
   * @param listener - The listener function to remove (must be the same reference)
   */
  removeListener(channel: string, listener: IpcEventHandler): void;
}

// ============================================================================
// Default Implementation
// ============================================================================

import { ipcMain } from "electron";

/**
 * Default implementation of IpcBoundary using Electron's ipcMain.
 */
export class DefaultIpcBoundary implements IpcBoundary {
  on(channel: string, listener: IpcEventHandler): void {
    ipcMain.on(channel, listener);
  }

  removeListener(channel: string, listener: IpcEventHandler): void {
    ipcMain.removeListener(channel, listener);
  }
}
