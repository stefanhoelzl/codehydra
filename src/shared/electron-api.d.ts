/**
 * Type definitions for the Electron API exposed via contextBridge.
 * This file is in shared/ so both main/preload and renderer can access the types.
 */

import type { UIModeChangedEvent, LifecycleAgentType, AgentInfo } from "./ipc";
import type { UIMode } from "./ipc";
import type { ShortcutKey } from "./shortcuts";
import type { DialogUserEvent } from "./dialog-types";
import type { NotificationUserEvent } from "./notification-types";
import type { UiEvent } from "./ui-event";

import type { Project, Workspace, WorkspaceStatus } from "./api/types";

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

  projects: {
    open(path?: string): Promise<Project | null>;
    close(projectPath: string, options?: { removeLocalRepo?: boolean }): Promise<void>;
  };
  workspaces: {
    /**
     * Start workspace removal (fire-and-forget).
     * Progress is emitted via workspace:deletion-progress events.
     * Returns { started: true } on success, { started: false } if blocked by idempotency.
     *
     * @param workspacePath Absolute path to the workspace to remove
     * @param options Optional removal options
     */
    remove(
      workspacePath: string,
      options?: {
        keepBranch?: boolean;
        skipSwitch?: boolean;
        force?: boolean;
        ignoreWarnings?: boolean;
        blockingPids?: readonly number[];
      }
    ): Promise<{ started: boolean }>;
    getStatus(workspacePath: string, options?: { refresh?: boolean }): Promise<WorkspaceStatus>;
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
    /**
     * Get a file:// URL pointing at the saved hibernation screenshot for a
     * workspace. The returned URL may not exist on disk; consumers should
     * handle <img> error events as a missing-screenshot fallback.
     */
    getScreenshot(projectId: string, workspaceName: string): Promise<{ url: string | null }>;
  };
  ui: {
    switchWorkspace(workspacePath: string, focus?: boolean): Promise<void>;
    setMode(mode: UIMode): Promise<void>;
  };
  lifecycle: {
    /**
     * Signal that the renderer is ready to receive state.
     * The main process emits domain events for all current state before resolving.
     * Returns app-wide bootstrap data (default agent + available agents).
     */
    ready(): Promise<{
      defaultAgent: LifecycleAgentType | null;
      availableAgents: readonly AgentInfo[];
    }>;
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
   * Subscribe to API events.
   * @param event - Event name (without api: prefix)
   * @param callback - Event handler
   * @returns Unsubscribe function
   */
  on<T>(event: string, callback: (event: T) => void): Unsubscribe;

  /**
   * Subscribe to UI mode change events.
   * @param callback - Called when UI mode changes (workspace, shortcut, dialog)
   * @returns Unsubscribe function to remove the listener
   */
  onModeChange(callback: (event: UIModeChangedEvent) => void): Unsubscribe;

  /**
   * Subscribe to shortcut key events from main process.
   * Fired when a shortcut key is pressed while shortcut mode is active.
   * @param callback - Called with the normalized shortcut key (e.g., "up", "down", "enter", "0"-"9")
   * @returns Unsubscribe function to remove the listener
   */
  onShortcut(callback: (key: ShortcutKey) => void): Unsubscribe;

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
