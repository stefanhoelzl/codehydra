/**
 * Shared types and pure helpers for view-manager implementations.
 *
 * Anything in this file is implementation-agnostic: no Electron calls, no I/O,
 * no state. The base class and any concrete implementation may depend on it.
 */

import type { SessionHandle, ViewHandle } from "./types";

/**
 * Sidebar minimized width in pixels.
 * Workspace views start at this offset, with expanded sidebar overlaying them.
 */
export const SIDEBAR_MINIMIZED_WIDTH = 20;

/**
 * Minimum window dimensions.
 */
export const MIN_WIDTH = 800;
export const MIN_HEIGHT = 600;

/**
 * Z-index for the UI layer when positioned at the bottom of the view stack.
 * The window's own backgroundColor provides the backdrop, so the UI sits at index 0.
 */
export const Z_UI_BOTTOM = 0;

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
 * Per-workspace state shared by all implementations.
 *
 * Concrete implementations carry their own private state on the view handle
 * itself or in a separate side map; the slot here only covers what the
 * shared coordination layer needs to read.
 */
export interface WorkspaceState {
  /** Handle to the view */
  handle: ViewHandle;
  /** Handle to the session */
  sessionHandle: SessionHandle;
  /** URL to load (stored for lazy loading) */
  url: string;
  /** Whether URL has been loaded */
  urlLoaded: boolean;
  /** Partition name for cleanup */
  partitionName: string;
  /** Current retry attempt count for load failures */
  retryCount: number;
  /** Timer handle for scheduled retry, if any */
  retryTimer: NodeJS.Timeout | null;
  /**
   * When true, the next attach will reload this view's webContents before
   * returning. Set by the render-process-gone handler so the user gets a
   * fresh page on next attach instead of a dead renderer.
   */
  needsReloadOnAttach: boolean;
  /**
   * Watchdog timer armed after a resume-triggered loadURL. Cleared when
   * did-finish-load fires. If it fires, the view is assumed wedged and is
   * destroyed + recreated from scratch.
   */
  reloadWatchdogTimer: NodeJS.Timeout | null;
}

/**
 * Clamps a window size to the configured minimum dimensions.
 */
export function clampSize(size: { width: number; height: number }): {
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

/**
 * Rect for a workspace view: full window minus the minimized sidebar gutter.
 */
export function computeWorkspaceRect(size: { width: number; height: number }): Rect {
  const { width, height } = clampSize(size);
  return {
    x: SIDEBAR_MINIMIZED_WIDTH,
    y: 0,
    width: width - SIDEBAR_MINIMIZED_WIDTH,
    height,
  };
}
