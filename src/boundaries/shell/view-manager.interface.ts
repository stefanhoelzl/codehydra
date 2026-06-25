/**
 * Interface for the UI view manager. Enables testability (modules mock this
 * narrow surface instead of the Electron boundaries).
 *
 * Since workspace iframes moved into the UI renderer's DOM, this manager owns
 * exactly one WebContentsView: the UI layer. Workspace surfaces (mounting,
 * visibility, loading indication, focus restoration) are renderer concerns,
 * derived from the workspace stores.
 */

import type { UIMode } from "../../shared/ipc";
import type { ViewHandle } from "./types";
import type { DevtoolsTarget, KeyboardTarget } from "./view-manager-types";

/**
 * Timeout for workspace loading in milliseconds.
 * If the agent doesn't report status within this time, the loading
 * indication is dropped anyway.
 */
export const WORKSPACE_LOADING_TIMEOUT_MS = 10000;

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
   * Routes focus according to the current mode:
   * - "dialog" / "hover": no-op (the renderer's focus traps own focus)
   * - "shortcut": focus the UI webContents (Alt+X key handling)
   * - "workspace": focus the UI webContents, then ask the renderer to focus
   *   the active workspace iframe
   */
  focus(): void;

  /**
   * Sets the UI mode. Pure state. No view operations are tied to mode
   * anymore — the renderer derives everything visual from the mirrored
   * mode state.
   */
  setMode(mode: UIMode): void;

  /** Returns the current UI mode. */
  getMode(): UIMode;

  /**
   * Asks the renderer to reload every mounted workspace iframe (re-assigning
   * each frame's src) and re-focus the active one. Called after code-server
   * restarts, when the iframes' connections to the replaced server are stale.
   *
   * Best-effort: before the WorkspaceFrames component mounts the hook is
   * undefined, and a mid-load UI rejects the call silently.
   */
  reloadFrames(): void;

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
