/**
 * Window manager for the main application window.
 * Handles BaseWindow creation, resize events, and lifecycle management.
 *
 * This is a facade over WindowLayer that provides a higher-level API
 * for the main application window.
 */

import type { BaseWindow } from "electron";
import type { Logger } from "../../services/logging";
import type { PlatformInfo } from "../../services/platform/platform-info";
import type { ImageLayer } from "../../services/platform/image";
import type { ImageHandle } from "../../services/platform/types";
import type { WindowLayerInternal } from "../../services/shell/window";
import type { WindowHandle } from "../../services/shell/types";
import { getErrorMessage } from "../../shared/error-utils";

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
 * Dependencies for creating a WindowManager.
 */
export interface WindowManagerDeps {
  readonly windowLayer: WindowLayerInternal;
  readonly imageLayer: ImageLayer;
  readonly logger: Logger;
  readonly platformInfo: PlatformInfo;
}

/**
 * Manages the main application window.
 */
export class WindowManager {
  private readonly windowLayer: WindowLayerInternal;
  private readonly windowHandle: WindowHandle;
  private readonly logger: Logger;
  private readonly platformInfo: PlatformInfo;
  private readonly resizeCallbacks: Set<() => void> = new Set();

  private constructor(deps: WindowManagerDeps, windowHandle: WindowHandle) {
    this.windowLayer = deps.windowLayer;
    this.windowHandle = windowHandle;
    this.logger = deps.logger;
    this.platformInfo = deps.platformInfo;

    // Set up resize event handler
    this.windowLayer.onResize(this.windowHandle, () => {
      const bounds = this.windowLayer.getContentBounds(this.windowHandle);
      this.logger.debug("Window resized", { width: bounds.width, height: bounds.height });
      this.notifyResizeCallbacks();
    });

    // On Linux, maximize/unmaximize may not trigger resize event,
    // so we need to listen for these separately
    this.windowLayer.onMaximize(this.windowHandle, () => {
      this.logger.debug("Window maximized");
      this.notifyResizeCallbacks();
    });

    this.windowLayer.onUnmaximize(this.windowHandle, () => {
      this.notifyResizeCallbacks();
    });

    // Listen for close event
    this.windowLayer.onClose(this.windowHandle, () => {
      this.logger.info("Window closed");
    });
  }

  private notifyResizeCallbacks(): void {
    for (const callback of this.resizeCallbacks) {
      callback();
    }
  }

  /**
   * Creates a new WindowManager with a configured window.
   *
   * Configuration:
   * - Size: 1200x800 (default), minimum 800x600
   * - Title: Configurable, defaults to "CodeHydra"
   * - Icon: Loaded from iconPath if provided
   * - No application menu
   *
   * @param deps - Dependencies including WindowLayer, ImageLayer, Logger, PlatformInfo
   * @param title - Window title (defaults to "CodeHydra")
   * @param iconPath - Absolute path to the window icon (e.g., from PathProvider.appIconPath)
   */
  static create(
    deps: WindowManagerDeps,
    title: string = "CodeHydra",
    iconPath?: string
  ): WindowManager {
    const windowHandle = deps.windowLayer.createWindow({
      width: 1200,
      height: 800,
      minWidth: 800,
      minHeight: 600,
      title,
    });

    // Set the window icon for taskbar/dock display
    if (iconPath) {
      try {
        const iconHandle = deps.imageLayer.createFromPath(iconPath);
        if (!deps.imageLayer.isEmpty(iconHandle)) {
          deps.windowLayer.setIcon(windowHandle, iconHandle);
        }
        deps.imageLayer.release(iconHandle);
      } catch {
        // Icon loading failed, continue without icon
        // This is non-critical - the window will use the default icon
      }
    }

    deps.logger.info("Window created");
    return new WindowManager(deps, windowHandle);
  }

  /**
   * Returns the underlying BaseWindow instance.
   *
   * @deprecated This method is for backward compatibility during migration.
   * Use WindowLayer methods instead when possible.
   */
  getWindow(): BaseWindow {
    return this.windowLayer._getRawWindow(this.windowHandle);
  }

  /**
   * Returns the WindowHandle for this window.
   */
  getWindowHandle(): WindowHandle {
    return this.windowHandle;
  }

  /**
   * Returns the current content bounds of the window.
   * Uses getContentBounds() to get the actual client area (excluding title bar).
   */
  getBounds(): ContentBounds {
    const bounds = this.windowLayer.getContentBounds(this.windowHandle);
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
   * Maximizes the window and waits for bounds to stabilize.
   *
   * On Linux/GTK, window.maximize() is asynchronous - the maximize event
   * fires immediately but getContentBounds() returns stale values until
   * GTK completes the operation (~16ms observed, 50ms for safety margin).
   * User-initiated resizes work fine; this delay is only needed for
   * programmatic maximize at startup.
   */
  async maximizeAsync(): Promise<void> {
    this.windowLayer.maximize(this.windowHandle);
    await new Promise((resolve) => setTimeout(resolve, 50));
    this.notifyResizeCallbacks();
  }

  /**
   * Sets the window title.
   *
   * @param title - The new window title
   */
  setTitle(title: string): void {
    this.windowLayer.setTitle(this.windowHandle, title);
  }

  /**
   * Sets the overlay icon on the taskbar (Windows only).
   * This method is a no-op on non-Windows platforms.
   *
   * @param image - The overlay image handle, or null to clear
   * @param description - Accessibility description for the overlay
   */
  setOverlayIcon(image: ImageHandle | null, description: string): void {
    // Only Windows supports overlay icons on the taskbar
    if (this.platformInfo.platform !== "win32") {
      return;
    }

    try {
      this.windowLayer.setOverlayIcon(this.windowHandle, image, description);
    } catch (error) {
      // Log but don't throw - overlay icon is non-critical
      this.logger.warn("Failed to set overlay icon", {
        description,
        error: getErrorMessage(error),
      });
    }
  }

  /**
   * Closes the window.
   */
  close(): void {
    this.windowLayer.close(this.windowHandle);
  }
}
