/**
 * Interface for the UI view manager. Enables testability (modules mock this
 * narrow surface instead of the Electron boundaries).
 *
 * Since workspace iframes moved into the UI renderer's DOM, this manager owns
 * exactly one WebContentsView: the UI layer. Workspace surfaces (mounting,
 * visibility, loading indication, focus restoration) are renderer concerns,
 * derived from the workspace stores.
 */

import type { ViewHandle } from "./types";
import type { DevtoolsTarget, KeyboardTarget } from "./view-manager-types";

/**
 * Function to unsubscribe from an event.
 */
export type Unsubscribe = () => void;

/**
 * Interface for managing the single UI view.
 *
 * Lifecycle invariants:
 * - Two-phase init: `new Impl(deps)` followed by `create()` before any other
 *   call. `create()` creates the UI view, wires the session handlers that
 *   workspace iframes rely on, and subscribes to window resize.
 * - `destroy()` is idempotent.
 * - `focus()` routing is a function of mode only; see the method docstring.
 */
export interface IViewManager {
  /**
   * Creates the UI view and wires event subscriptions.
   * MUST be called before any other method. Safe to call only once.
   */
  create(): void;

  /**
   * Returns the handle of the UI layer view, for subscribing to view-level
   * events (e.g. the renderer crash guard). Only valid after `create()`.
   */
  getUIViewHandle(): ViewHandle;

  /**
   * Returns a narrow capability for toggling devtools on the UI view.
   * Workspace iframes share this devtools instance (use its frame picker).
   */
  getUIDevtoolsTarget(): DevtoolsTarget;

  /**
   * Returns a narrow capability for subscribing to keyboard input and the
   * destroyed lifecycle on the UI view. `before-input-event` fires at the
   * webContents level, so input typed inside workspace iframes is included.
   */
  getUIKeyboardTarget(): KeyboardTarget;

  /**
   * Checks if the UI layer view is available (not destroyed).
   */
  isUIAvailable(): boolean;

  /**
   * Loads the given HTML (or other) URL into the UI view. Called once by
   * the composition root after `create()` to point the UI at its bundle.
   *
   * @param htmlPath - file:// URL of the UI HTML to load
   */
  loadUIContent(htmlPath: string): Promise<void>;

  /**
   * Sends an IPC message to the UI layer. Pre-create sends are dropped.
   *
   * @param channel - IPC channel name
   * @param args - Arguments to send
   */
  sendToUI(channel: string, ...args: unknown[]): void;

  /**
   * Subscribe to fire-and-forget IPC messages from the UI layer's renderer,
   * scoped to the UI view's webContents. Callable before the view exists: the
   * manager buffers subscribers and wires the underlying listener when the view
   * is created (re-wiring on recreate). The listener receives only the message
   * arguments (the Electron event is swallowed).
   *
   * @param channel - IPC channel name
   * @param listener - Called with the message arguments on each send
   * @returns Unsubscribe function
   */
  onFromUI(channel: string, listener: (...args: unknown[]) => void): Unsubscribe;

  /**
   * Focuses the UI webContents, then asks the renderer to focus the active
   * workspace iframe. Mode is main-owned (the presenter) and no longer
   * mirrored here; the renderer owns the dialog/hover/shortcut focus traps.
   * Callers focus only in a workspace context (app start, post-terminal focus).
   */
  focus(): void;

  /**
   * Asks the renderer to reload every mounted workspace iframe (re-assigning
   * each frame's src) and re-focus the active one. Called after the IDE server
   * restarts, when the iframes' connections to the replaced server are stale.
   *
   * Best-effort: before the WorkspaceFrames component mounts the hook is
   * undefined, and a mid-load UI rejects the call silently.
   */
  reloadFrames(): void;

  /**
   * Resolve after the UI renderer has committed a paint for the current
   * UiState (waits two animation frames). Used to sequence a screenshot after
   * a state-driven layout change — collapsing the sidebar before a hibernation
   * capture — has actually rendered. Best-effort: resolves immediately if the
   * UI view is unavailable or mid-load.
   */
  waitForUIPaint(): Promise<void>;

  /**
   * Capture a PNG screenshot of the active workspace iframe, by clipping a
   * full-view capture to the iframe's bounding rect (no API exists to
   * capture an out-of-process iframe directly).
   *
   * Best-effort: returns null when no workspace iframe is visible or the
   * capture fails. Does not throw.
   */
  captureActiveWorkspaceView(): Promise<Buffer | null>;

  /**
   * Destroys the UI view and unsubscribes listeners.
   * Called during application shutdown. Idempotent.
   */
  destroy(): void;
}
