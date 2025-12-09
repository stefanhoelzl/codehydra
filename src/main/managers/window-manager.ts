/**
 * Window manager for the main application window.
 * Handles BaseWindow creation, resize events, and lifecycle management.
 */

import { BaseWindow } from "electron";

/**
 * Function to unsubscribe from an event.
 */
export type Unsubscribe = () => void;

/**
 * Content bounds of the window.
 */
export interface ContentBounds {
  readonly width: number;
  readonly height: number;
}

/**
 * Manages the main application window.
 */
export class WindowManager {
  private readonly window: BaseWindow;
  private readonly resizeCallbacks: Set<() => void> = new Set();

  private constructor(window: BaseWindow) {
    this.window = window;

    // Set up resize event handler
    this.window.on("resize", () => {
      this.notifyResizeCallbacks();
    });

    // On Linux, maximize/unmaximize may not trigger resize event,
    // so we need to listen for these separately
    this.window.on("maximize", () => {
      this.notifyResizeCallbacks();
    });

    this.window.on("unmaximize", () => {
      this.notifyResizeCallbacks();
    });
  }

  private notifyResizeCallbacks(): void {
    for (const callback of this.resizeCallbacks) {
      callback();
    }
  }

  /**
   * Creates a new WindowManager with a configured BaseWindow.
   *
   * Configuration:
   * - Size: 1200x800 (default), minimum 800x600
   * - Title: "CodeHydra"
   * - No application menu
   */
  static create(): WindowManager {
    const window = new BaseWindow({
      width: 1200,
      height: 800,
      minWidth: 800,
      minHeight: 600,
      title: "CodeHydra",
    });

    window.maximize();

    return new WindowManager(window);
  }

  /**
   * Returns the underlying BaseWindow instance.
   */
  getWindow(): BaseWindow {
    return this.window;
  }

  /**
   * Returns the current content bounds of the window.
   * Uses getContentBounds() to get the actual client area (excluding title bar).
   */
  getBounds(): ContentBounds {
    const bounds = this.window.getContentBounds();
    return {
      width: bounds.width,
      height: bounds.height,
    };
  }

  /**
   * Subscribes to window resize events.
   *
   * @param callback - Called when the window is resized
   * @returns Unsubscribe function to remove the listener
   */
  onResize(callback: () => void): Unsubscribe {
    this.resizeCallbacks.add(callback);

    return () => {
      this.resizeCallbacks.delete(callback);
    };
  }

  /**
   * Closes the window.
   */
  close(): void {
    this.window.close();
  }
}
