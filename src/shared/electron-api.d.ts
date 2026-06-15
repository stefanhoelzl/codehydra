/**
 * Type definitions for the Electron API exposed via contextBridge.
 * This file is in shared/ so both main/preload and renderer can access the types.
 */

import type { DialogUserEvent } from "./dialog-types";
import type { NotificationUserEvent } from "./notification-types";
import type { UiEvent } from "./ui-event";
import type { UiState } from "./ui-state";

/**
 * Function to unsubscribe from an event.
 */
export type Unsubscribe = () => void;

/**
 * Type-safe Electron API exposed to the renderer via contextBridge.
 *
 * Setup is driven by the main process (app:setup intent).
 * Renderer subscribes to lifecycle events and responds to agent selection requests.
 */
export interface Api {
  // ============ API (api: prefixed channels) ============
  // Primary API backed by intent dispatcher.
  // Lifecycle handlers are registered in bootstrap(), others in startServices().

  // Renderer→main gestures are NOT invokes: the renderer emits ui:events
  // (switch-workspace / wake-workspace / remove-workspace / close-project)
  // carrying opaque identity, and main owns resolution, confirmation dialogs,
  // and dispatch. (Project open + hibernate have no renderer gesture — the
  // creation panel and the `h` shortcut drive them entirely main-side.)
  lifecycle: {
    /**
     * Quit the application.
     */
    quit(): Promise<void>;
  };
  /**
   * Emit a UI event to the main process (api:ui:event channel).
   * Fire-and-forget - does not return a promise.
   */
  emitEvent(event: UiEvent): void;
  /**
   * Subscribe to UI state snapshots (api:ui:state channel).
   * The presenter pushes the full render-ready UiState on every change.
   * INVARIANT: subscribe before emitting the `ui-connected` event — the first
   * push is emitted by the app:ready operation that ui-connected triggers, so a
   * listener registered later misses it (there is no replay).
   * @param callback - Called with each pushed snapshot
   * @returns Unsubscribe function to remove the listener
   */
  onState(callback: (state: UiState) => void): Unsubscribe;
  /**
   * Subscribe to API events.
   * @param event - Event name (without api: prefix)
   * @param callback - Event handler
   * @returns Unsubscribe function
   */
  on<T>(event: string, callback: (event: T) => void): Unsubscribe;

  /**
   * Subscribe to theme change events from main process.
   * Fired once on startup with the initial theme and again whenever the OS theme changes.
   */
  onTheme(callback: (theme: "dark" | "light") => void): Unsubscribe;

  /**
   * Send dialog user event to main process.
   * Used when the user interacts with a declarative dialog (clicks an action button).
   * Fire-and-forget - does not return a promise.
   */
  sendDialogEvent(event: DialogUserEvent): void;

  /**
   * Send notification user event to main process.
   * Used when the user interacts with a sidebar notification (dismiss or action button).
   * Fire-and-forget - does not return a promise.
   */
  sendNotificationEvent(event: NotificationUserEvent): void;
}

declare global {
  interface Window {
    api: Api;
  }
}

export {};
