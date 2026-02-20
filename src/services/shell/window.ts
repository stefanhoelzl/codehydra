/**
 * WindowLayer - Abstraction over Electron's BaseWindow.
 *
 * Provides an injectable interface for window management, enabling:
 * - Unit testing with behavioral mocks
 * - Boundary testing against real BaseWindow
 * - Handle-based access pattern (no direct Electron types exposed)
 */

import type { BaseWindow } from "electron";
import type { WindowHandle, Rectangle, ViewHandle } from "./types";
import { createWindowHandle } from "./types";
import { ShellError } from "./errors";
import type { Logger } from "../logging";
import type { ImageLayer } from "../platform/image";
import type { ImageHandle } from "../platform/types";
import type { PlatformInfo } from "../platform/platform-info";

// ============================================================================
// Types
// ============================================================================

/**
 * Options for creating a window.
 */
export interface WindowOptions {
  readonly width?: number;
  readonly height?: number;
  readonly minWidth?: number;
  readonly minHeight?: number;
  readonly title?: string;
  readonly show?: boolean;
}

/**
 * Function to unsubscribe from an event.
 */
export type Unsubscribe = () => void;

/**
 * Content view that can contain child views.
 * Provides methods to add/remove child views.
 */
export interface ContentView {
  addChildView(view: unknown, index?: number): void;
  removeChildView(view: unknown): void;
  readonly children: readonly unknown[];
}

// ============================================================================
// Interface
// ============================================================================

/**
 * Abstraction over Electron's BaseWindow.
 *
 * Uses opaque WindowHandle references instead of exposing BaseWindow directly.
 * This allows testing without Electron dependencies and ensures all window
 * access goes through this abstraction.
 */
export interface WindowLayer {
  /**
   * Create a new window.
   *
   * @param options - Window creation options
   * @returns Handle to the created window
   */
  createWindow(options: WindowOptions): WindowHandle;

  /**
   * Destroy a window.
   *
   * @param handle - Handle to the window
   * @throws ShellError with code WINDOW_NOT_FOUND if handle is invalid
   */
  destroy(handle: WindowHandle): void;

  /**
   * Destroy all windows.
   *
   * @throws ShellError with code WINDOW_HAS_ATTACHED_VIEWS if any window has views attached
   */
  destroyAll(): void;

  /**
   * Get the bounds of a window.
   *
   * @param handle - Handle to the window
   * @returns The window bounds (x, y, width, height)
   * @throws ShellError with code WINDOW_NOT_FOUND if handle is invalid
   */
  getBounds(handle: WindowHandle): Rectangle;

  /**
   * Get the content bounds of a window (excluding title bar/frame).
   *
   * @param handle - Handle to the window
   * @returns The content bounds (x, y, width, height)
   * @throws ShellError with code WINDOW_NOT_FOUND if handle is invalid
   */
  getContentBounds(handle: WindowHandle): Rectangle;

  /**
   * Set the bounds of a window.
   *
   * @param handle - Handle to the window
   * @param bounds - The new bounds
   * @throws ShellError with code WINDOW_NOT_FOUND if handle is invalid
   */
  setBounds(handle: WindowHandle, bounds: Rectangle): void;

  /**
   * Set the overlay icon on the taskbar (Windows only).
   * This method is a no-op on non-Windows platforms.
   *
   * @param handle - Handle to the window
   * @param image - Image handle, or null to clear
   * @param description - Accessibility description for the overlay
   * @throws ShellError with code WINDOW_NOT_FOUND if handle is invalid
   */
  setOverlayIcon(handle: WindowHandle, image: ImageHandle | null, description: string): void;

  /**
   * Set the window icon.
   *
   * @param handle - Handle to the window
   * @param image - Image handle for the icon
   * @throws ShellError with code WINDOW_NOT_FOUND if handle is invalid
   */
  setIcon(handle: WindowHandle, image: ImageHandle): void;

  /**
   * Maximize a window.
   *
   * @param handle - Handle to the window
   * @throws ShellError with code WINDOW_NOT_FOUND if handle is invalid
   */
  maximize(handle: WindowHandle): void;

  /**
   * Check if a window is maximized.
   *
   * @param handle - Handle to the window
   * @returns True if the window is maximized
   * @throws ShellError with code WINDOW_NOT_FOUND if handle is invalid
   */
  isMaximized(handle: WindowHandle): boolean;

  /**
   * Check if a window handle refers to a destroyed window.
   *
   * @param handle - Handle to the window
   * @returns True if the window is destroyed or not found
   */
  isDestroyed(handle: WindowHandle): boolean;

  /**
   * Set the window title.
   *
   * @param handle - Handle to the window
   * @param title - The new title
   * @throws ShellError with code WINDOW_NOT_FOUND if handle is invalid
   */
  setTitle(handle: WindowHandle, title: string): void;

  /**
   * Close a window.
   *
   * @param handle - Handle to the window
   * @throws ShellError with code WINDOW_NOT_FOUND if handle is invalid
   */
  close(handle: WindowHandle): void;

  /**
   * Subscribe to window resize events.
   *
   * @param handle - Handle to the window
   * @param callback - Called when window is resized
   * @returns Unsubscribe function
   * @throws ShellError with code WINDOW_NOT_FOUND if handle is invalid
   */
  onResize(handle: WindowHandle, callback: () => void): Unsubscribe;

  /**
   * Subscribe to window maximize events.
   *
   * @param handle - Handle to the window
   * @param callback - Called when window is maximized
   * @returns Unsubscribe function
   * @throws ShellError with code WINDOW_NOT_FOUND if handle is invalid
   */
  onMaximize(handle: WindowHandle, callback: () => void): Unsubscribe;

  /**
   * Subscribe to window unmaximize events.
   *
   * @param handle - Handle to the window
   * @param callback - Called when window is unmaximized
   * @returns Unsubscribe function
   * @throws ShellError with code WINDOW_NOT_FOUND if handle is invalid
   */
  onUnmaximize(handle: WindowHandle, callback: () => void): Unsubscribe;

  /**
   * Subscribe to window close events.
   *
   * @param handle - Handle to the window
   * @param callback - Called when window is about to close
   * @returns Unsubscribe function
   * @throws ShellError with code WINDOW_NOT_FOUND if handle is invalid
   */
  onClose(handle: WindowHandle, callback: () => void): Unsubscribe;

  /**
   * Subscribe to window blur events (window loses OS focus).
   *
   * @param handle - Handle to the window
   * @param callback - Called when window loses focus
   * @returns Unsubscribe function
   * @throws ShellError with code WINDOW_NOT_FOUND if handle is invalid
   */
  onBlur(handle: WindowHandle, callback: () => void): Unsubscribe;

  /**
   * Get the content view of a window.
   * The content view is the container for child views.
   *
   * @param handle - Handle to the window
   * @returns The content view
   * @throws ShellError with code WINDOW_NOT_FOUND if handle is invalid
   */
  getContentView(handle: WindowHandle): ContentView;

  /**
   * Track a view as attached to a window.
   * Used to prevent destroying windows with attached views.
   *
   * @param handle - Handle to the window
   * @param viewHandle - Handle to the view being attached
   * @throws ShellError with code WINDOW_NOT_FOUND if handle is invalid
   */
  trackAttachedView(handle: WindowHandle, viewHandle: ViewHandle): void;

  /**
   * Untrack a view from a window.
   *
   * @param handle - Handle to the window
   * @param viewHandle - Handle to the view being detached
   * @throws ShellError with code WINDOW_NOT_FOUND if handle is invalid
   */
  untrackAttachedView(handle: WindowHandle, viewHandle: ViewHandle): void;

  /**
   * Dispose of all resources.
   * Unlike destroyAll(), this does not throw if views are attached.
   * Used during app shutdown when views have already been disposed.
   */
  dispose(): Promise<void>;
}

/**
 * Extended WindowLayer interface with internal methods.
 * Used only by code that needs direct access to the underlying BaseWindow.
 */
export interface WindowLayerInternal extends WindowLayer {
  /**
   * Get the raw BaseWindow for a handle.
   * This is an internal method for construction-time access only.
   * Should NOT be used in normal operation.
   *
   * @param handle - Handle to the window
   * @returns The underlying BaseWindow
   * @throws ShellError with code WINDOW_NOT_FOUND if handle is invalid
   */
  _getRawWindow(handle: WindowHandle): BaseWindow;
}

// ============================================================================
// Default Implementation
// ============================================================================

import { BaseWindow as ElectronBaseWindow } from "electron";

interface WindowState {
  window: BaseWindow;
  attachedViews: Set<string>;
}

/**
 * Default implementation of WindowLayer using Electron's BaseWindow.
 */
export class DefaultWindowLayer implements WindowLayerInternal {
  private readonly windows = new Map<string, WindowState>();
  private nextId = 1;

  constructor(
    private readonly imageLayer: ImageLayer,
    private readonly platformInfo: PlatformInfo,
    private readonly logger: Logger
  ) {}

  createWindow(options: WindowOptions): WindowHandle {
    const id = `window-${this.nextId++}`;

    // Build options object, only including defined properties
    const windowOptions: {
      width: number;
      height: number;
      minWidth?: number;
      minHeight?: number;
      title?: string;
      show: boolean;
    } = {
      width: options.width ?? 800,
      height: options.height ?? 600,
      show: options.show ?? true,
    };

    if (options.minWidth !== undefined) {
      windowOptions.minWidth = options.minWidth;
    }
    if (options.minHeight !== undefined) {
      windowOptions.minHeight = options.minHeight;
    }
    if (options.title !== undefined) {
      windowOptions.title = options.title;
    }

    const window = new ElectronBaseWindow(windowOptions);

    this.windows.set(id, {
      window,
      attachedViews: new Set(),
    });
    this.logger.debug("Window created", { id, title: options.title ?? null });
    return createWindowHandle(id);
  }

  destroy(handle: WindowHandle): void {
    const state = this.getWindowState(handle);
    if (state.attachedViews.size > 0) {
      throw new ShellError(
        "WINDOW_HAS_ATTACHED_VIEWS",
        `Window ${handle.id} has ${state.attachedViews.size} attached views`,
        handle.id
      );
    }
    this.windows.delete(handle.id);
    state.window.destroy();
    this.logger.debug("Window destroyed", { id: handle.id });
  }

  destroyAll(): void {
    // Check for attached views first
    for (const [id, state] of this.windows) {
      if (state.attachedViews.size > 0) {
        throw new ShellError(
          "WINDOW_HAS_ATTACHED_VIEWS",
          `Window ${id} has ${state.attachedViews.size} attached views`,
          id
        );
      }
    }

    // Now destroy all
    for (const [id, state] of this.windows) {
      state.window.destroy();
      this.logger.debug("Window destroyed", { id });
    }
    this.windows.clear();
  }

  getBounds(handle: WindowHandle): Rectangle {
    const state = this.getWindowState(handle);
    return state.window.getBounds();
  }

  getContentBounds(handle: WindowHandle): Rectangle {
    const state = this.getWindowState(handle);
    return state.window.getContentBounds();
  }

  setBounds(handle: WindowHandle, bounds: Rectangle): void {
    const state = this.getWindowState(handle);
    state.window.setBounds(bounds);
  }

  setOverlayIcon(handle: WindowHandle, image: ImageHandle | null, description: string): void {
    // No-op on non-Windows platforms
    if (this.platformInfo.platform !== "win32") {
      return;
    }

    const state = this.getWindowState(handle);
    try {
      const nativeImage = image ? this.imageLayer.getNativeImage(image) : null;
      state.window.setOverlayIcon(nativeImage, description);
    } catch (error) {
      // Log but don't throw - overlay icon is non-critical
      this.logger.warn("Failed to set overlay icon", {
        id: handle.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  setIcon(handle: WindowHandle, image: ImageHandle): void {
    const state = this.getWindowState(handle);
    const nativeImage = this.imageLayer.getNativeImage(image);
    if (nativeImage) {
      state.window.setIcon(nativeImage);
    }
  }

  maximize(handle: WindowHandle): void {
    const state = this.getWindowState(handle);
    state.window.maximize();
  }

  isMaximized(handle: WindowHandle): boolean {
    const state = this.getWindowState(handle);
    return state.window.isMaximized();
  }

  isDestroyed(handle: WindowHandle): boolean {
    const state = this.windows.get(handle.id);
    if (!state) {
      return true;
    }
    return state.window.isDestroyed();
  }

  setTitle(handle: WindowHandle, title: string): void {
    const state = this.getWindowState(handle);
    state.window.setTitle(title);
  }

  close(handle: WindowHandle): void {
    const state = this.getWindowState(handle);
    state.window.close();
  }

  onResize(handle: WindowHandle, callback: () => void): Unsubscribe {
    const state = this.getWindowState(handle);
    state.window.on("resize", callback);
    return () => {
      if (!state.window.isDestroyed()) {
        state.window.off("resize", callback);
      }
    };
  }

  onMaximize(handle: WindowHandle, callback: () => void): Unsubscribe {
    const state = this.getWindowState(handle);
    state.window.on("maximize", callback);
    return () => {
      if (!state.window.isDestroyed()) {
        state.window.off("maximize", callback);
      }
    };
  }

  onUnmaximize(handle: WindowHandle, callback: () => void): Unsubscribe {
    const state = this.getWindowState(handle);
    state.window.on("unmaximize", callback);
    return () => {
      if (!state.window.isDestroyed()) {
        state.window.off("unmaximize", callback);
      }
    };
  }

  onClose(handle: WindowHandle, callback: () => void): Unsubscribe {
    const state = this.getWindowState(handle);
    state.window.on("close", callback);
    return () => {
      if (!state.window.isDestroyed()) {
        state.window.off("close", callback);
      }
    };
  }

  onBlur(handle: WindowHandle, callback: () => void): Unsubscribe {
    const state = this.getWindowState(handle);
    state.window.on("blur", callback);
    return () => {
      if (!state.window.isDestroyed()) {
        state.window.off("blur", callback);
      }
    };
  }

  getContentView(handle: WindowHandle): ContentView {
    const state = this.getWindowState(handle);
    return state.window.contentView;
  }

  trackAttachedView(handle: WindowHandle, viewHandle: ViewHandle): void {
    const state = this.getWindowState(handle);
    state.attachedViews.add(viewHandle.id);
  }

  untrackAttachedView(handle: WindowHandle, viewHandle: ViewHandle): void {
    const state = this.getWindowState(handle);
    state.attachedViews.delete(viewHandle.id);
  }

  _getRawWindow(handle: WindowHandle): BaseWindow {
    const state = this.getWindowState(handle);
    return state.window;
  }

  async dispose(): Promise<void> {
    // Destroy all windows without checking for attached views
    // Used during app shutdown when views have already been disposed
    for (const [id, state] of this.windows) {
      try {
        if (!state.window.isDestroyed()) {
          state.window.destroy();
        }
        this.logger.debug("Window destroyed", { id });
      } catch {
        // Ignore errors during cleanup
      }
    }
    this.windows.clear();
  }

  private getWindowState(handle: WindowHandle): WindowState {
    const state = this.windows.get(handle.id);
    if (!state) {
      throw new ShellError("WINDOW_NOT_FOUND", `Window ${handle.id} not found`, handle.id);
    }
    if (state.window.isDestroyed()) {
      this.windows.delete(handle.id);
      throw new ShellError("WINDOW_DESTROYED", `Window ${handle.id} was destroyed`, handle.id);
    }
    return state;
  }
}
