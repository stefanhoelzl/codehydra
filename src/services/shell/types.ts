/**
 * Common types for shell layer abstractions.
 *
 * These branded types provide type-safe handles that prevent
 * accidental mixing of different handle types at compile time.
 */

/**
 * Opaque handle to a window.
 * Used by WindowLayer to reference BaseWindow instances without exposing Electron types.
 */
export interface WindowHandle {
  readonly id: string;
  readonly __brand: "WindowHandle";
}

/**
 * Opaque handle to a view.
 * Used by ViewLayer to reference WebContentsView instances without exposing Electron types.
 */
export interface ViewHandle {
  readonly id: string;
  readonly __brand: "ViewHandle";
}

/**
 * Opaque handle to a session.
 * Used by SessionLayer to reference Session instances without exposing Electron types.
 */
export interface SessionHandle {
  readonly id: string;
  readonly __brand: "SessionHandle";
}

/**
 * Rectangle dimensions for window/view bounds.
 */
export interface Rectangle {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Web preferences for view creation.
 */
export interface WebPreferences {
  readonly nodeIntegration?: boolean;
  readonly contextIsolation?: boolean;
  readonly sandbox?: boolean;
  readonly partition?: string;
  readonly preload?: string;
  readonly webviewTag?: boolean;
}

/**
 * Creates a WindowHandle with the given ID.
 * Used by layer implementations to create handles.
 */
export function createWindowHandle(id: string): WindowHandle {
  return { id, __brand: "WindowHandle" };
}

/**
 * Creates a ViewHandle with the given ID.
 * Used by layer implementations to create handles.
 */
export function createViewHandle(id: string): ViewHandle {
  return { id, __brand: "ViewHandle" };
}

/**
 * Creates a SessionHandle with the given ID.
 * Used by layer implementations to create handles.
 */
export function createSessionHandle(id: string): SessionHandle {
  return { id, __brand: "SessionHandle" };
}
