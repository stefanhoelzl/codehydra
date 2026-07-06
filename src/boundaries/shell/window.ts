/**
 * WindowBoundary - Abstraction over Electron's BaseWindow.
 *
 * Provides an injectable interface for window management, enabling:
 * - Unit testing with behavioral mocks
 * - Boundary testing against real BaseWindow
 * - Handle-based access pattern (no direct Electron types exposed)
 */

import type { BrowserWindow, WebContents } from "electron";
import type { WindowHandle, Rectangle, WebPreferences } from "./types";
import { createWindowHandle } from "./types";
import { ShellError } from "../../shared/errors/shell-errors";
import type { Logger } from "../platform/logging";
import type { ImageBoundary } from "./image";
import type { ImageHandle } from "./image-types";
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
  readonly backgroundColor?: string;
  /**
   * Web preferences for the window's own webContents. When provided, the
   * window hosts a full-size web page directly (BrowserWindow) — the page
   * auto-fills the window, so no child view or manual bounds management is
   * needed. Its webContents is reachable via getWebContents().
   */
  readonly webPreferences?: WebPreferences;
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
export interface WindowBoundary {
  /**
   * Create a new window.
   *
   * @param options - Window creation options
   * @returns Handle to the created window
   */
  createWindow(options: WindowOptions): WindowHandle;

  /**
   * Get the content bounds of a window (excluding title bar/frame).
   *
   * @param handle - Handle to the window
   * @returns The content bounds (x, y, width, height)
   * @throws ShellError with code WINDOW_NOT_FOUND if handle is invalid
   */
  getContentBounds(handle: WindowHandle): Rectangle;

  /**
   * Set the overlay icon on the taskbar (Windows only).
   * This method is a no-op on non-Windows platforms.
   *
   * @param handle - Handle to the window
   * @param image - Image handle, or null to clear
   * @param description - Accessibility description for the overlay
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
   * Set the window background color.
   *
   * Shows through transparent child views. Used to keep the backdrop in sync
   * with the active OS theme without spinning up a dedicated backdrop view.
   *
   * @param handle - Handle to the window
   * @param color - CSS hex color (e.g. "#16161a")
   * @throws ShellError with code WINDOW_NOT_FOUND if handle is invalid
   */
  setBackgroundColor(handle: WindowHandle, color: string): void;

  /**
   * Focus a window (request OS-level focus).
   *
   * @param handle - Handle to the window
   * @throws ShellError with code WINDOW_NOT_FOUND if handle is invalid
   */
  focus(handle: WindowHandle): void;

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
   * Get the window's own webContents (the full-size page hosted directly by a
   * BrowserWindow). Only meaningful when the window was created with
   * webPreferences. Used by ViewBoundary.adoptWindowWebContents so the UI's
   * webContents concerns route through the ViewBoundary abstraction.
   *
   * @param handle - Handle to the window
   * @throws ShellError with code WINDOW_NOT_FOUND if handle is invalid
   */
  getWebContents(handle: WindowHandle): WebContents;

  /**
   * Dispose of all resources.
   * Does not throw if views are attached.
   * Used during app shutdown when views have already been disposed.
   */
  dispose(): Promise<void>;
}

// ============================================================================
// Default Implementation
// ============================================================================

import { BrowserWindow as ElectronBrowserWindow } from "electron";

interface WindowState {
  window: BrowserWindow;
}

/**
 * Default implementation of WindowBoundary using Electron's BaseWindow.
 */
export class DefaultWindowBoundary implements WindowBoundary {
  private readonly windows = new Map<string, WindowState>();
  private nextId = 1;

  constructor(
    private readonly imageLayer: ImageBoundary,
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
      backgroundColor?: string;
      webPreferences?: Electron.WebPreferences;
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
    if (options.backgroundColor !== undefined) {
      windowOptions.backgroundColor = options.backgroundColor;
    }
    if (options.webPreferences !== undefined) {
      const prefs: Electron.WebPreferences = {
        nodeIntegration: options.webPreferences.nodeIntegration ?? false,
        contextIsolation: options.webPreferences.contextIsolation ?? true,
        sandbox: options.webPreferences.sandbox ?? true,
      };
      if (options.webPreferences.partition !== undefined) {
        prefs.partition = options.webPreferences.partition;
      }
      if (options.webPreferences.preload !== undefined) {
        prefs.preload = options.webPreferences.preload;
      }
      windowOptions.webPreferences = prefs;
    }

    const window = new ElectronBrowserWindow(windowOptions);

    this.windows.set(id, {
      window,
    });
    this.logger.debug("Window created", { id, title: options.title ?? null });
    return createWindowHandle(id);
  }

  getContentBounds(handle: WindowHandle): Rectangle {
    const state = this.getWindowState(handle);
    return state.window.getContentBounds();
  }

  setOverlayIcon(handle: WindowHandle, image: ImageHandle | null, description: string): void {
    // No-op on non-Windows platforms
    if (this.platformInfo.platform !== "win32") {
      return;
    }

    try {
      const state = this.getWindowState(handle);
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

  setBackgroundColor(handle: WindowHandle, color: string): void {
    const state = this.getWindowState(handle);
    state.window.setBackgroundColor(color);
  }

  getWebContents(handle: WindowHandle): WebContents {
    const state = this.getWindowState(handle);
    return state.window.webContents;
  }

  focus(handle: WindowHandle): void {
    const state = this.getWindowState(handle);
    state.window.focus();
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

  async dispose(): Promise<void> {
    // Destroy all windows
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
