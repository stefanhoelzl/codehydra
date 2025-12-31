/**
 * Type definitions for the Electron API exposed via contextBridge.
 * This file is in shared/ so both main/preload and renderer can access the types.
 */

import type { UIModeChangedEvent, LogContext } from "./ipc";
import type { UIMode } from "./ipc";
import type { ShortcutKey } from "./shortcuts";

import type {
  Project,
  Workspace,
  WorkspaceRef,
  WorkspaceStatus,
  SetupResult,
  AppState as AppStateType,
  BaseInfo as ApiBaseInfo,
} from "./api/types";

/**
 * Function to unsubscribe from an event.
 */
export type Unsubscribe = () => void;

/**
 * Type-safe Electron API exposed to the renderer via contextBridge.
 *
 * All setup operations use the lifecycle API (lifecycle.getState, lifecycle.setup, lifecycle.quit).
 * Setup progress events are consumed via on("setup:progress", handler).
 */
export interface Api {
  // ============ API (api: prefixed channels) ============
  // Primary API using ICodeHydraApi-based backend.
  // Lifecycle handlers are registered in bootstrap(), others in startServices().

  projects: {
    open(path: string): Promise<Project>;
    close(projectId: string): Promise<void>;
    list(): Promise<readonly Project[]>;
    get(projectId: string): Promise<Project | undefined>;
    fetchBases(projectId: string): Promise<{ readonly bases: readonly ApiBaseInfo[] }>;
  };
  workspaces: {
    create(projectId: string, name: string, base: string): Promise<Workspace>;
    /**
     * Start workspace removal (fire-and-forget).
     * Progress is emitted via workspace:deletion-progress events.
     * Returns immediately with { started: true }.
     *
     * @param projectId Project containing the workspace
     * @param workspaceName Name of the workspace to remove
     * @param keepBranch If true, keep the git branch after removing worktree (default: true)
     * @param skipSwitch If true, don't switch away from this workspace when active (for retry)
     * @param unblock Unblock option: "kill" to kill processes, "close" to close handles (elevated), "ignore" to skip detection
     * @param isRetry If true, skip proactive detection (user claims they fixed it)
     */
    remove(
      projectId: string,
      workspaceName: string,
      keepBranch?: boolean,
      skipSwitch?: boolean,
      unblock?: "kill" | "close" | "ignore",
      isRetry?: boolean
    ): Promise<{ started: true }>;
    /**
     * Force remove a workspace (skip cleanup operations).
     * Used for "Close Anyway" when deletion fails.
     * Removes workspace from internal state without running cleanup.
     */
    forceRemove(projectId: string, workspaceName: string): Promise<void>;
    get(projectId: string, workspaceName: string): Promise<Workspace | undefined>;
    getStatus(projectId: string, workspaceName: string): Promise<WorkspaceStatus>;
    /**
     * Get the OpenCode server port for a workspace.
     * @param projectId Project containing the workspace
     * @param workspaceName Name of the workspace
     * @returns Port number if server is running, null if not running or not initialized
     */
    getOpencodePort(projectId: string, workspaceName: string): Promise<number | null>;
    setMetadata(
      projectId: string,
      workspaceName: string,
      key: string,
      value: string | null
    ): Promise<void>;
    getMetadata(
      projectId: string,
      workspaceName: string
    ): Promise<Readonly<Record<string, string>>>;
  };
  ui: {
    selectFolder(): Promise<string | null>;
    getActiveWorkspace(): Promise<WorkspaceRef | null>;
    switchWorkspace(projectId: string, workspaceName: string, focus?: boolean): Promise<void>;
    setMode(mode: UIMode): Promise<void>;
  };
  lifecycle: {
    getState(): Promise<AppStateType>;
    setup(): Promise<SetupResult>;
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
}

declare global {
  interface Window {
    api: Api;
  }
}

export {};
