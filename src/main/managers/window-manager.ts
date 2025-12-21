/**
 * Window manager for the main application window.
 * Handles BaseWindow creation, resize events, and lifecycle management.
 */

import { BaseWindow, nativeImage, type NativeImage } from "electron";
import type { Logger } from "../../services/logging";
import type { PlatformInfo } from "../../services/platform/platform-info";

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
  private readonly logger: Logger;
  private readonly platformInfo: PlatformInfo;
  private readonly resizeCallbacks: Set<() => void> = new Set();

  private constructor(window: BaseWindow, logger: Logger, platformInfo: PlatformInfo) {
    this.window = window;
    this.logger = logger;
    this.platformInfo = platformInfo;

    // Set up resize event handler
    this.window.on("resize", () => {
      const bounds = this.window.getContentBounds();
      this.logger.debug("Window resized", { width: bounds.width, height: bounds.height });
      this.notifyResizeCallbacks();
    });

    // On Linux, maximize/unmaximize may not trigger resize event,
    // so we need to listen for these separately
    this.window.on("maximize", () => {
      this.logger.debug("Window maximized");
      this.notifyResizeCallbacks();
    });

    this.window.on("unmaximize", () => {
      this.notifyResizeCallbacks();
    });

    // Listen for close event
    this.window.on("close", () => {
      this.logger.info("Window closed");
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
   * - Title: Configurable, defaults to "CodeHydra"
   * - Icon: Loaded from iconPath if provided
   * - No application menu
   *
   * @param logger - Logger for [window] scope
   * @param platformInfo - Platform information for OS-specific behavior
   * @param title - Window title (defaults to "CodeHydra")
   * @param iconPath - Absolute path to the window icon (e.g., from PathProvider.appIconPath)
   */
  static create(
    logger: Logger,
    platformInfo: PlatformInfo,
    title: string = "CodeHydra",
    iconPath?: string
  ): WindowManager {
    const window = new BaseWindow({
      width: 1200,
      height: 800,
      minWidth: 800,
      minHeight: 600,
      title,
    });

    // Set the window icon for taskbar/dock display
    if (iconPath) {
      try {
        const icon = nativeImage.createFromPath(iconPath);
        if (!icon.isEmpty()) {
          window.setIcon(icon);
        }
      } catch {
        // Icon loading failed, continue without icon
        // This is non-critical - the window will use the default icon
      }
    }

    logger.info("Window created");
    return new WindowManager(window, logger, platformInfo);
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
   * Maximizes the window and waits for bounds to stabilize.
   *
   * On Linux/GTK, window.maximize() is asynchronous - the maximize event
   * fires immediately but getContentBounds() returns stale values until
   * GTK completes the operation (~16ms observed, 50ms for safety margin).
   * User-initiated resizes work fine; this delay is only needed for
   * programmatic maximize at startup.
   */
  async maximizeAsync(): Promise<void> {
    this.window.maximize();
    await new Promise((resolve) => setTimeout(resolve, 50));
    this.notifyResizeCallbacks();
  }

  /**
   * Sets the window title.
   *
   * @param title - The new window title
   */
  setTitle(title: string): void {
    this.window.setTitle(title);
  }

  /**
   * Sets the overlay icon on the taskbar (Windows only).
   * This method is a no-op on non-Windows platforms.
   *
   * @param image - The overlay image, or null to clear
   * @param description - Accessibility description for the overlay
   */
  setOverlayIcon(image: NativeImage | null, description: string): void {
    // Only Windows supports overlay icons on the taskbar
    if (this.platformInfo.platform !== "win32") {
      return;
    }

    try {
      this.window.setOverlayIcon(image, description);
    } catch (error) {
      // Log but don't throw - overlay icon is non-critical
      this.logger.warn("Failed to set overlay icon", {
        description,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Closes the window.
   */
  close(): void {
    this.window.close();
  }
}
