/**
 * Type definitions for the Electron API exposed via contextBridge.
 * This file is in shared/ so both main/preload and renderer can access the types.
 */

import type {
  SetupProgress,
  SetupErrorPayload,
  SetupReadyResponse,
  UIModeChangedEvent,
} from "./ipc";
import type { UIMode } from "./ipc";

import type {
  Project,
  Workspace,
  WorkspaceRef,
  WorkspaceStatus,
  WorkspaceRemovalResult,
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
 * The API has two layers:
 * 1. Setup commands/events - registered early in bootstrap, available during setup
 * 2. Normal API - registered after setup completes, primary API for normal operation
 */
export interface Api {
  // ============ Setup Commands (registered early in bootstrap) ============
  // These use old IPC channels because they must be available before startServices() runs.
  // The lifecycle handlers are registered inside startServices(), so they're not
  // available during the setup flow.

  /**
   * Check if VS Code setup is complete.
   * Returns { ready: true } if setup done, { ready: false } if setup needed.
   * If setup is needed, main process will start setup asynchronously.
   */
  setupReady(): Promise<SetupReadyResponse>;

  /**
   * Retry setup after a failure.
   * Cleans vscode directory and re-runs setup.
   */
  setupRetry(): Promise<void>;

  /**
   * Quit the application (from setup error screen).
   */
  setupQuit(): Promise<void>;

  // ============ Setup Events ============

  /**
   * Subscribe to setup progress events.
   * @param callback - Called when setup progress updates
   * @returns Unsubscribe function to remove the listener
   */
  onSetupProgress(callback: (progress: SetupProgress) => void): Unsubscribe;

  /**
   * Subscribe to setup complete event.
   * @param callback - Called when setup completes successfully
   * @returns Unsubscribe function to remove the listener
   */
  onSetupComplete(callback: () => void): Unsubscribe;

  /**
   * Subscribe to setup error events.
   * @param callback - Called when setup fails
   * @returns Unsubscribe function to remove the listener
   */
  onSetupError(callback: (error: SetupErrorPayload) => void): Unsubscribe;

  // ============ Normal API (api: prefixed channels) ============
  // Primary API using ICodeHydraApi-based backend.
  // Registered in startServices() after setup completes.

  projects: {
    open(path: string): Promise<Project>;
    close(projectId: string): Promise<void>;
    list(): Promise<readonly Project[]>;
    get(projectId: string): Promise<Project | undefined>;
    fetchBases(projectId: string): Promise<{ readonly bases: readonly ApiBaseInfo[] }>;
  };
  workspaces: {
    create(projectId: string, name: string, base: string): Promise<Workspace>;
    remove(
      projectId: string,
      workspaceName: string,
      keepBranch?: boolean
    ): Promise<WorkspaceRemovalResult>;
    get(projectId: string, workspaceName: string): Promise<Workspace | undefined>;
    getStatus(projectId: string, workspaceName: string): Promise<WorkspaceStatus>;
  };
  ui: {
    selectFolder(): Promise<string | null>;
    getActiveWorkspace(): Promise<WorkspaceRef | null>;
    switchWorkspace(projectId: string, workspaceName: string, focus?: boolean): Promise<void>;
    setDialogMode(isOpen: boolean): Promise<void>;
    focusActiveWorkspace(): Promise<void>;
    setMode(mode: UIMode): Promise<void>;
  };
  lifecycle: {
    getState(): Promise<AppStateType>;
    setup(): Promise<SetupResult>;
    quit(): Promise<void>;
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
}

declare global {
  interface Window {
    api: Api;
  }
}

export {};
