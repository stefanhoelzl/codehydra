/**
 * Type definitions for the Electron API exposed via contextBridge.
 * This file is in shared/ so both main/preload and renderer can access the types.
 */

import type { UIModeChangedEvent, LogContext, LifecycleAgentType } from "./ipc";
import type { UIMode } from "./ipc";
import type { ShortcutKey } from "./shortcuts";

import type {
  Project,
  Workspace,
  WorkspaceRef,
  WorkspaceStatus,
  BaseInfo as ApiBaseInfo,
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
  // Primary API using ICodeHydraApi-based backend.
  // Lifecycle handlers are registered in bootstrap(), others in startServices().

  projects: {
    open(path: string): Promise<Project>;
    close(projectId: string, options?: { removeLocalRepo?: boolean }): Promise<void>;
    clone(url: string): Promise<Project>;
    list(): Promise<readonly Project[]>;
    get(projectId: string): Promise<Project | undefined>;
    fetchBases(projectId: string): Promise<{ readonly bases: readonly ApiBaseInfo[] }>;
  };
  workspaces: {
    create(projectId: string, name: string, base: string): Promise<Workspace>;
    /**
     * Start workspace removal (fire-and-forget).
     * Progress is emitted via workspace:deletion-progress events.
     * Returns { started: true } on success, { started: false } if blocked by idempotency.
     *
     * @param projectId Project containing the workspace
     * @param workspaceName Name of the workspace to remove
     * @param options Optional removal options
     */
    remove(
      projectId: string,
      workspaceName: string,
      options?: {
        keepBranch?: boolean;
        skipSwitch?: boolean;
        force?: boolean;
        unblock?: "kill" | "close" | "ignore";
        isRetry?: boolean;
      }
    ): Promise<{ started: boolean }>;
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
    /**
     * Signal that the renderer is ready to receive state.
     * The main process emits domain events for all current state before resolving.
     */
    ready(): Promise<void>;
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
   * Send agent selected event to main process.
   * Used when user selects an agent in the agent selection dialog.
   * Fire-and-forget - does not return a promise.
   */
  sendAgentSelected(agent: LifecycleAgentType): void;

  /**
   * Send retry event to main process.
   * Used when user clicks retry after a setup/startup error.
   * Fire-and-forget - does not return a promise.
   */
  sendRetry(): void;
}

declare global {
  interface Window {
    api: Api;
  }
}

export {};
