/**
 * Type definitions for the Electron API exposed via contextBridge.
 * This file is in shared/ so both main/preload and renderer can access the types.
 */

import type { DialogUserEvent } from "./dialog-types";
import type { NotificationUserEvent } from "./notification-types";
import type { UiEvent } from "./ui-event";
import type { UiState } from "./ui-state";

import type { Project, Workspace } from "./api/types";

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

  // Workspace removal and project closing are NOT invokes: the renderer
  // emits remove-workspace / close-project ui:events and main owns the
  // confirmation dialogs and dispatches.
  projects: {
    open(path?: string): Promise<Project | null>;
  };
  workspaces: {
    /**
     * Start hibernating a workspace (fire-and-forget).
     * Tears down the view + agent server, persists `hibernated="true"` metadata,
     * and emits workspace:hibernated. Returns { started: false } if blocked
     * by idempotency.
     */
    hibernate(workspacePath: string): Promise<{ started: boolean }>;
    /**
     * Wake a hibernated workspace and bring it back online.
     * Clears the `hibernated` metadata flag, deletes the saved screenshot, and
     * re-runs the open pipeline (restarts the agent server, rebuilds the view).
     * Returns the reopened Workspace, or null if a concurrent wake was deduped.
     */
    wake(workspacePath: string): Promise<Workspace | null>;
  };
  ui: {
    /**
     * Switch to a workspace, or deselect with `null` — no workspace is active
     * afterwards and the creation panel becomes the main view (`focus` is
     * ignored for null).
     */
    switchWorkspace(workspacePath: string | null, focus?: boolean): Promise<void>;
  };
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
