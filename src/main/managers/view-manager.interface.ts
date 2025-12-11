/**
 * Interface for ViewManager to enable testability.
 * Allows mocking in handler tests.
 */

import type { WebContentsView } from "electron";

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
   * @param workspacePath - Absolute path to the workspace directory
   * @param url - URL to load in the view (code-server URL) - stored for lazy loading
   * @returns The created WebContentsView (detached, URL not loaded)
   */
  createWorkspaceView(workspacePath: string, url: string): WebContentsView;

  /**
   * Destroys a workspace view.
   *
   * @param workspacePath - Absolute path to the workspace directory
   */
  destroyWorkspaceView(workspacePath: string): void;

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
   * Sets whether the UI layer should be in dialog mode.
   * In dialog mode, the UI is moved to the top to overlay workspace views.
   *
   * @param isOpen - True to enable dialog mode (UI on top), false for normal mode (UI behind)
   */
  setDialogMode(isOpen: boolean): void;

  /**
   * Updates the code-server port.
   * Used after setup completes to update the port for origin checking.
   *
   * @param port - The new code-server port
   */
  updateCodeServerPort(port: number): void;
}
