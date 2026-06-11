/**
 * Shared types and pure helpers for the UI view manager.
 *
 * Anything in this file is implementation-agnostic: no Electron calls, no I/O,
 * no state.
 */

import type { KeyboardInput } from "./view";
import type { Unsubscribe } from "./view-manager.interface";

/**
 * Minimum window dimensions.
 */
const MIN_WIDTH = 800;
const MIN_HEIGHT = 600;

/**
 * Rectangle in window coordinates.
 */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

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

/**
 * Clamps a window size to the configured minimum dimensions.
 */
function clampSize(size: { width: number; height: number }): {
  width: number;
  height: number;
} {
  return {
    width: Math.max(size.width, MIN_WIDTH),
    height: Math.max(size.height, MIN_HEIGHT),
  };
}

/**
 * Rect for the UI layer: full window (so dialogs and overlays can cover
 * everything).
 */
export function computeUIRect(size: { width: number; height: number }): Rect {
  const { width, height } = clampSize(size);
  return { x: 0, y: 0, width, height };
}
