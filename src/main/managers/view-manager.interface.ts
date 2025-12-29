/**
 * Interface for ViewManager to enable testability.
 * Allows mocking in handler tests.
 */

import type { WebContentsView } from "electron";
import type { UIMode, UIModeChangedEvent } from "../../shared/ipc";

/**
 * Function to unsubscribe from an event.
 */
export type Unsubscribe = () => void;

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
   * @returns The created WebContentsView (detached, URL not loaded)
   */
  createWorkspaceView(workspacePath: string, url: string, projectPath: string): WebContentsView;

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
}
