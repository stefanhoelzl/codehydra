/**
 * Interface for view-manager implementations. Enables testability and allows
 * alternative implementations (e.g. WebContents-based vs. iframe-based) to
 * coexist behind a feature flag.
 *
 * Implementations MUST honor the invariants documented on each method.
 * The conformance test suite (`view-manager.conformance.ts`) encodes most
 * of them.
 */

import type { UIMode, UIModeChangedEvent } from "../../shared/ipc";
import type { ViewHandle } from "./types";
import type { DevtoolsTarget, KeyboardTarget } from "./view-manager-types";

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
 * Interface for managing per-workspace views and the UI layer.
 *
 * Lifecycle invariants:
 * - Two-phase init: `new Impl(deps)` followed by `await create()` before any
 *   other call. `create()` creates the UI view and wires resize listeners.
 * - `destroy()` is idempotent and tears down all per-workspace state.
 *
 * Coordination invariants (apply to every implementation):
 * - `setActiveWorkspace`: the new view MUST be attached BEFORE the previous
 *   view is detached, so there is never a blank frame.
 * - Z-order after `setActiveWorkspace`: if the current mode is `dialog`,
 *   `shortcut`, or `hover`, the UI layer MUST end up on top again.
 * - Idempotency: re-issuing `setMode(same)`, `setActiveWorkspace(samePath)`,
 *   `setWorkspaceLoaded(same)`, and `destroyWorkspaceView(unknown)` is a no-op
 *   and emits no events.
 * - `onLoadingChange`: a subscriber registered after a workspace has already
 *   finished loading MUST receive an immediate `(path, false)` replay for
 *   that workspace, so late-binding consumers don't get stuck.
 * - `focus()` routing is a function of mode + attachment state only; see the
 *   method docstring.
 * - During shutdown (after `destroy()` begins), focus operations are
 *   suppressed; implementations must not reach into freed view handles.
 */
export interface IViewManager {
  /**
   * Creates UI view and wires event subscriptions.
   * MUST be called before any other method. Safe to call only once.
   */
  create(): void;

  /**
   * Returns a narrow capability for toggling devtools on the UI view.
   */
  getUIDevtoolsTarget(): DevtoolsTarget;

  /**
   * Returns a narrow capability for toggling devtools on a workspace view.
   * Returns undefined if the workspace doesn't exist.
   */
  getWorkspaceDevtoolsTarget(workspacePath: string): DevtoolsTarget | undefined;

  /**
   * Returns a narrow capability for subscribing to keyboard input and the
   * destroyed lifecycle on the UI view.
   */
  getUIKeyboardTarget(): KeyboardTarget;

  /**
   * Returns a narrow capability for subscribing to keyboard input and the
   * destroyed lifecycle on a workspace view. Returns undefined if the
   * workspace doesn't exist.
   */
  getWorkspaceKeyboardTarget(workspacePath: string): KeyboardTarget | undefined;

  /**
   * Checks if the UI layer view is available (not destroyed).
   *
   * @returns True if the UI view is available
   */
  isUIAvailable(): boolean;

  /**
   * Sends an IPC message to the UI layer.
   *
   * @param channel - IPC channel name
   * @param args - Arguments to send
   */
  sendToUI(channel: string, ...args: unknown[]): void;

  /**
   * Creates a new workspace view.
   *
   * Creates the view but does NOT attach to contentView or load the URL.
   * The view starts in a detached state to minimize GPU usage.
   * URL is loaded lazily when the workspace is first activated via setActiveWorkspace.
   *
   * All workspaces share a global Electron session partition (`persist:codehydra-global`)
   * to enable extension storage (globalState, secrets) to be shared across workspaces.
   *
   * @param workspacePath - Absolute path to the workspace directory
   * @param url - URL to load in the view (code-server URL) - stored for lazy loading
   * @param projectPath - Absolute path to the project directory.
   *                      Retained for API stability; not currently used for partition naming.
   * @param isNew - If true, marks workspace as loading until OpenCode client attaches.
   *                Defaults to false (existing workspaces loaded on startup skip loading state).
   * @returns Handle to the created view (detached, URL not loaded)
   */
  createWorkspaceView(
    workspacePath: string,
    url: string,
    projectPath: string,
    isNew?: boolean
  ): ViewHandle;

  /**
   * Destroys a workspace view. Idempotent: calling for an unknown path is a
   * no-op.
   *
   * Navigates to about:blank before closing to ensure resources are released.
   * Uses a timeout to ensure destruction completes even if navigation hangs.
   *
   * @param workspacePath - Absolute path to the workspace directory
   */
  destroyWorkspaceView(workspacePath: string): Promise<void>;

  /**
   * Updates view bounds (called on window resize).
   *
   * MUST be O(1) in the number of workspaces: only the UI layer and the
   * active workspace are repositioned. Loading (detached) workspaces still
   * receive bounds updates so the renderer re-layouts at the correct size
   * before they are revealed.
   */
  updateBounds(): void;

  /**
   * Sets the active workspace.
   *
   * Active workspace is attached to contentView with full content bounds.
   * Other workspaces are detached from contentView entirely (not attached, no GPU usage).
   *
   * On first activation, the workspace's URL is loaded (lazy loading).
   * The new view MUST be attached BEFORE the previous view is detached so
   * there is no visual gap. If the current mode is `dialog`, `shortcut`, or
   * `hover`, the UI layer MUST be re-raised to the top after the switch.
   *
   * Idempotent: calling with the same path twice has no observable effect.
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
   * Focuses the correct view based on current mode and attachment state.
   * Single source of truth for focus management.
   *
   * - workspace mode: focuses workspace view if attached, else UI
   * - shortcut mode: focuses UI (keyboard events go to sidebar)
   * - dialog/hover mode: no-op (these modes manage their own focus)
   *
   * Implementations MUST treat focus as a no-op once `destroy()` has begun.
   */
  focus(): void;

  /**
   * Sets the UI mode.
   * - "workspace": UI at z-index 0, focus active workspace
   * - "shortcut": UI on top, focus UI layer
   * - "dialog": UI on top, no focus change
   * - "hover": UI on top, no focus change
   *
   * Idempotent: setting the same mode twice does not emit an event and does
   * not re-focus.
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
   * Late-binding guarantee: when a subscriber registers, it MUST receive an
   * immediate `(path, false)` callback for every workspace that has already
   * finished loading. This prevents consumers registered after startup
   * (e.g. the splash-screen coordinator) from waiting forever.
   *
   * @param callback - Called with (path, loading) when loading state changes
   * @returns Unsubscribe function
   */
  onLoadingChange(callback: LoadingChangeCallback): Unsubscribe;

  /**
   * Reloads all workspace views that have a loaded URL.
   *
   * Skips workspaces that haven't loaded yet (urlLoaded === false)
   * and workspaces currently in loading state.
   * Used to recover from broken WebSocket connections after system resume.
   */
  reloadAllViews(): void;

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

  /**
   * Destroys all views and cleans up resources.
   * Called during application shutdown. Idempotent. After this returns,
   * focus operations are no-ops and view handles must not be touched.
   */
  destroy(): void;

  /**
   * Capture a PNG screenshot of the workspace's current view content.
   *
   * Best-effort: returns null if the workspace has no view, the view has not
   * been activated yet, or capture fails. Does not throw.
   *
   * @param workspacePath - Absolute path to the workspace directory
   * @returns PNG-encoded bytes, or null
   */
  captureWorkspaceView(workspacePath: string): Promise<Buffer | null>;
}
