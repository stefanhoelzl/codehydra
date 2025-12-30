/**
 * Interface for ViewManager to enable testability.
 * Allows mocking in handler tests.
 */

import type { WebContentsView } from "electron";
import type { UIMode, UIModeChangedEvent } from "../../shared/ipc";

/**
 * Timeout for workspace loading in milliseconds.
 * If the OpenCode client doesn't attach within this time, the view is shown anyway.
 */
export const WORKSPACE_LOADING_TIMEOUT_MS = 10000;

/**
 * Function to unsubscribe from an event.
 */
export type Unsubscribe = () => void;

/**
 * Callback for loading state changes.
 * @param path - The workspace path
 * @param loading - True when workspace starts loading, false when loaded
 */
export type LoadingChangeCallback = (path: string, loading: boolean) => void;

/**
 * Interface for managing WebContentsViews.
 * Used for dependency injection and testability.
 */
export interface IViewManager {
  /**
   * Returns the UI layer WebContentsView.
   */
  getUIView(): WebContentsView;

  /**
   * Creates a new workspace view.
   *
   * Creates the view but does NOT attach to contentView or load the URL.
   * The view starts in a detached state to minimize GPU usage.
   * URL is loaded lazily when the workspace is first activated via setActiveWorkspace.
   *
   * Uses per-workspace Electron partitions for session isolation (localStorage, cookies).
   * Partition name format: persist:<projectDirName>/<workspaceName>
   *
   * @param workspacePath - Absolute path to the workspace directory
   * @param url - URL to load in the view (code-server URL) - stored for lazy loading
   * @param projectPath - Absolute path to the project directory (for partition naming)
   * @param isNew - If true, marks workspace as loading until OpenCode client attaches.
   *                Defaults to false (existing workspaces loaded on startup skip loading state).
   * @returns The created WebContentsView (detached, URL not loaded)
   */
  createWorkspaceView(
    workspacePath: string,
    url: string,
    projectPath: string,
    isNew?: boolean
  ): WebContentsView;

  /**
   * Destroys a workspace view.
   *
   * Navigates to about:blank before closing to ensure resources are released.
   * Uses a timeout to ensure destruction completes even if navigation hangs.
   *
   * @param workspacePath - Absolute path to the workspace directory
   */
  destroyWorkspaceView(workspacePath: string): Promise<void>;

  /**
   * Gets a workspace view by path.
   *
   * @param workspacePath - Absolute path to the workspace directory
   * @returns The WebContentsView or undefined if not found
   */
  getWorkspaceView(workspacePath: string): WebContentsView | undefined;

  /**
   * Updates all view bounds (called on window resize).
   */
  updateBounds(): void;

  /**
   * Sets the active workspace.
   *
   * Active workspace is attached to contentView with full content bounds.
   * Other workspaces are detached from contentView entirely (not attached, no GPU usage).
   *
   * On first activation, the workspace's URL is loaded (lazy loading).
   * Attach happens BEFORE detach of previous view for visual continuity (no gap).
   *
   * By default, focuses the workspace view so it receives keyboard input.
   *
   * @param workspacePath - Path to the workspace to activate, or null for none
   * @param focus - Whether to focus the workspace view (default: true)
   */
  setActiveWorkspace(workspacePath: string | null, focus?: boolean): void;

  /**
   * Gets the active workspace path.
   *
   * @returns The active workspace path or null if none
   */
  getActiveWorkspacePath(): string | null;

  /**
   * Focuses the active workspace view.
   * Use this to return focus to the workspace (e.g., after exiting shortcut mode).
   */
  focusActiveWorkspace(): void;

  /**
   * Focuses the UI layer view.
   */
  focusUI(): void;

  /**
   * Sets the UI mode.
   * - "workspace": UI at z-index 0, focus active workspace
   * - "shortcut": UI on top, focus UI layer
   * - "dialog": UI on top, no focus change
   *
   * Mode transitions are idempotent - setting the same mode twice does not emit an event.
   *
   * @param mode - The new UI mode
   */
  setMode(mode: UIMode): void;

  /**
   * Gets the current UI mode.
   *
   * @returns The current UI mode
   */
  getMode(): UIMode;

  /**
   * Subscribe to mode change events.
   *
   * @param callback - Called when mode changes, receives mode and previousMode
   * @returns Unsubscribe function
   */
  onModeChange(callback: (event: UIModeChangedEvent) => void): Unsubscribe;

  /**
   * Subscribe to workspace change events.
   *
   * Called when the active workspace changes via setActiveWorkspace().
   * The callback receives the new workspace path (or null if no workspace is active).
   *
   * @param callback - Called when active workspace changes
   * @returns Unsubscribe function
   */
  onWorkspaceChange(callback: (path: string | null) => void): Unsubscribe;

  /**
   * Updates the code-server port.
   * Used after setup completes to update the port for origin checking.
   *
   * @param port - The new code-server port
   */
  updateCodeServerPort(port: number): void;

  /**
   * Checks if a workspace is currently loading.
   * A workspace is loading from creation until first OpenCode client attaches
   * or the 10-second timeout expires.
   *
   * @param workspacePath - Absolute path to the workspace directory
   * @returns True if the workspace is loading, false otherwise
   */
  isWorkspaceLoading(workspacePath: string): boolean;

  /**
   * Marks a workspace as loaded, attaching its view if active.
   * Called when the first OpenCode client attaches or the timeout expires.
   * Idempotent: safe to call multiple times or for non-loading workspaces.
   *
   * @param workspacePath - Absolute path to the workspace directory
   */
  setWorkspaceLoaded(workspacePath: string): void;

  /**
   * Subscribe to loading state changes.
   * Called when a workspace starts or finishes loading.
   *
   * @param callback - Called with (path, loading) when loading state changes
   * @returns Unsubscribe function
   */
  onLoadingChange(callback: LoadingChangeCallback): Unsubscribe;

  /**
   * Preloads a workspace's URL without attaching the view.
   *
   * Loads the code-server URL in the background so the workspace is ready
   * when the user navigates to it. The view remains detached (no GPU usage)
   * until setActiveWorkspace() is called.
   *
   * Idempotent: safe to call multiple times or for already-loaded workspaces.
   *
   * Precondition: workspace must exist (created via createWorkspaceView()).
   *
   * @param workspacePath - Absolute path to the workspace directory
   */
  preloadWorkspaceUrl(workspacePath: string): void;
}
