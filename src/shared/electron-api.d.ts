/**
 * Type definitions for the Electron API exposed via contextBridge.
 * This file is in shared/ so both main/preload and renderer can access the types.
 */

import type { UIModeChangedEvent, LogContext, LifecycleAgentType, AgentInfo } from "./ipc";
import type { UIMode } from "./ipc";
import type { ShortcutKey } from "./shortcuts";
import type { DialogUserEvent } from "./dialog-types";
import type { NotificationUserEvent } from "./notification-types";

import type {
  Project,
  Workspace,
  WorkspaceRef,
  WorkspaceStatus,
  BaseInfo as ApiBaseInfo,
  InitialPrompt,
} from "./api/types";

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
    clone(url: string): Promise<Project>;
    fetchBases(projectPath: string): Promise<{ readonly bases: readonly ApiBaseInfo[] }>;
  };
  workspaces: {
    create(
      projectPath: string,
      name: string,
      base: string,
      options?: {
        initialPrompt?: InitialPrompt;
        stealFocus?: boolean;
        agent?: LifecycleAgentType;
      }
    ): Promise<Workspace>;
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
    getAgentSession(workspacePath: string): Promise<unknown>;
    setMetadata(workspacePath: string, key: string, value: string | null): Promise<void>;
    getMetadata(workspacePath: string): Promise<Readonly<Record<string, string>>>;
    /**
     * Start hibernating a workspace (fire-and-forget).
     * Tears down the view + agent server, persists `hibernated="true"` metadata,
     * and emits workspace:hibernated. Returns { started: false } if blocked
     * by idempotency.
     */
    hibernate(
      workspacePath: string,
      options?: { skipSwitch?: boolean }
    ): Promise<{ started: boolean }>;
    /**
     * Wake a hibernated workspace (fire-and-forget).
     * Clears the `hibernated` metadata flag and deletes the saved screenshot.
     * The caller is responsible for re-opening the workspace afterwards.
     */
    wake(workspacePath: string): Promise<{ started: boolean }>;
    /**
     * Re-open a previously-existing workspace (e.g., after wake) without
     * re-creating the worktree. Goes through the workspace:open flow with
     * existingWorkspace populated.
     */
    reopen(
      projectPath: string,
      workspacePath: string,
      workspaceName: string,
      branch: string | null,
      metadata: Readonly<Record<string, string>>
    ): Promise<Workspace>;
    /**
     * Get a file:// URL pointing at the saved hibernation screenshot for a
     * workspace. The returned URL may not exist on disk; consumers should
     * handle <img> error events as a missing-screenshot fallback.
     */
    getScreenshot(projectId: string, workspaceName: string): Promise<{ url: string | null }>;
  };
  ui: {
    getActiveWorkspace(): Promise<WorkspaceRef | null>;
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
   * Log API for renderer-to-main process logging.
   * Fire-and-forget - does not return a promise.
   */
  log: {
    debug(logger: string, message: string, context?: LogContext): void;
    info(logger: string, message: string, context?: LogContext): void;
    warn(logger: string, message: string, context?: LogContext): void;
    error(logger: string, message: string, context?: LogContext): void;
  };
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
