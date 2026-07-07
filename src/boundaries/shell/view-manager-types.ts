/**
 * Shared types and pure helpers for the UI view manager.
 *
 * Anything in this file is implementation-agnostic: no Electron calls, no I/O,
 * no state.
 */

import type { KeyboardInput } from "./view";
import type { Unsubscribe } from "./view-manager.interface";

/**
 * Narrow capability handle for opening/closing devtools on a view, without
 * exposing the underlying ViewHandle to consumers. Returned by
 * IViewManager.getUIDevtoolsTarget.
 */
export interface DevtoolsTarget {
  /** Stable identifier (handle id of the underlying view). */
  readonly id: string;
  /** Toggle devtools: open if closed, close if open. */
  toggle(): void;
  /** True if devtools are currently open on this view. */
  isOpen(): boolean;
}

/**
 * Narrow capability handle for keyboard input + lifecycle events on a view,
 * without exposing the underlying ViewHandle. Returned by
 * IViewManager.getUIKeyboardTarget.
 */
export interface KeyboardTarget {
  /** Stable identifier (handle id of the underlying view). Used by consumers
   *  as a map key for de-duplication across registrations. */
  readonly id: string;
  /** Subscribe to before-input-event on this view. */
  onBeforeInput(callback: (input: KeyboardInput, preventDefault: () => void) => void): Unsubscribe;
  /** Subscribe to the view-destroyed event. */
  onDestroyed(callback: () => void): Unsubscribe;
}
