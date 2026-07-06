/**
 * Window manager for the main application window.
 * Handles BaseWindow creation, resize events, and lifecycle management.
 *
 * This is a facade over WindowBoundary that provides a higher-level API
 * for the main application window.
 *
 * Uses two-phase initialization:
 * 1. Constructor: stores deps, title, iconPath (pure, no Electron calls)
 * 2. create(): creates the BaseWindow and wires event listeners
 */

import type { Logger } from "../platform/logging";
import type { ImageBoundary } from "./image";
import type { ImageHandle } from "./image-types";
import type { WindowBoundary } from "./window";
import type { AppBoundary } from "./app";
import type { WindowHandle, WebPreferences } from "./types";
import { getErrorMessage } from "../../shared/error-utils";

/**
 * Theme name reported to the renderer and used to pick a window backdrop color.
 */
export type Theme = "dark" | "light";

/**
 * Window backdrop colors. Match --ch-background fallbacks in variables.css so
 * the native backdrop blends with the renderer's painted background.
 */
const BACKGROUND_COLOR_DARK = "#16161a";
const BACKGROUND_COLOR_LIGHT = "#ffffff";

function colorForTheme(theme: Theme): string {
  return theme === "dark" ? BACKGROUND_COLOR_DARK : BACKGROUND_COLOR_LIGHT;
}

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
  readonly windowLayer: WindowBoundary;
  readonly imageLayer: ImageBoundary;
  readonly appLayer: Pick<AppBoundary, "shouldUseDarkColors" | "onThemeUpdated">;
  readonly logger: Logger;
}

/**
 * Manages the main application window.
 */
export class WindowManager {
  private readonly windowLayer: WindowBoundary;
  private readonly imageLayer: ImageBoundary;
  private readonly appLayer: Pick<AppBoundary, "shouldUseDarkColors" | "onThemeUpdated">;
  private readonly logger: Logger;
  private readonly title: string;
  private readonly iconPath: string | undefined;
  private readonly resizeCallbacks: Set<() => void> = new Set();
  private readonly themeChangeCallbacks: Set<(theme: Theme) => void> = new Set();
  private windowHandle!: WindowHandle;
  private currentTheme: Theme = "dark";

  constructor(deps: WindowManagerDeps, title: string = "CodeHydra", iconPath?: string) {
    this.windowLayer = deps.windowLayer;
    this.imageLayer = deps.imageLayer;
    this.appLayer = deps.appLayer;
    this.logger = deps.logger;
    this.title = title;
    this.iconPath = iconPath;
  }

  /**
   * Creates the BaseWindow and wires event listeners.
   * Must be called before using any window operations.
   */
  create(webPreferences?: WebPreferences): void {
    this.currentTheme = this.appLayer.shouldUseDarkColors() ? "dark" : "light";

    this.windowHandle = this.windowLayer.createWindow({
      width: 1200,
      height: 800,
      minWidth: 800,
      minHeight: 600,
      title: this.title,
      backgroundColor: colorForTheme(this.currentTheme),
      // When provided, the window hosts the UI page directly (BrowserWindow):
      // the page auto-fills the window, so no child view or manual sizing.
      ...(webPreferences !== undefined ? { webPreferences } : {}),
    });

    this.appLayer.onThemeUpdated(() => {
      const next: Theme = this.appLayer.shouldUseDarkColors() ? "dark" : "light";
      if (next === this.currentTheme) return;
      this.currentTheme = next;
      try {
        if (!this.windowLayer.isDestroyed(this.windowHandle)) {
          this.windowLayer.setBackgroundColor(this.windowHandle, colorForTheme(next));
        }
      } catch (error) {
        this.logger.warn("Failed to update window background color", {
          error: getErrorMessage(error),
        });
      }
      for (const cb of this.themeChangeCallbacks) {
        try {
          cb(next);
        } catch (error) {
          this.logger.warn("Theme change callback failed", { error: getErrorMessage(error) });
        }
      }
    });

    // Set the window icon for taskbar/dock display
    if (this.iconPath) {
      try {
        const iconHandle = this.imageLayer.createFromPath(this.iconPath);
        if (!this.imageLayer.isEmpty(iconHandle)) {
          this.windowLayer.setIcon(this.windowHandle, iconHandle);
        }
        this.imageLayer.release(iconHandle);
      } catch {
        // Icon loading failed, continue without icon
        // This is non-critical - the window will use the default icon
      }
    }

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

    this.logger.info("Window created");
  }

  private notifyResizeCallbacks(): void {
    for (const callback of this.resizeCallbacks) {
      callback();
    }
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
   * Maximizes the window.
   *
   * The window is a BrowserWindow whose page auto-fills the window, so there is
   * nothing to size after maximizing — no bounds settling, no view resizing.
   * (This is what makes the Wayland fractional-scaling maximize bug moot: we
   * never read getContentBounds() to size anything.)
   */
  async maximizeAsync(): Promise<void> {
    this.windowLayer.maximize(this.windowHandle);
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
    this.windowLayer.setOverlayIcon(this.windowHandle, image, description);
  }

  /**
   * Focuses the window (requests OS-level focus).
   */
  focus(): void {
    this.windowLayer.focus(this.windowHandle);
  }

  /**
   * Returns the current resolved theme.
   */
  getTheme(): Theme {
    return this.currentTheme;
  }

  /**
   * Subscribe to theme changes (after the initial value).
   *
   * @param callback - Called with the new theme when the OS theme changes
   * @returns Unsubscribe function
   */
  onThemeChange(callback: (theme: Theme) => void): Unsubscribe {
    this.themeChangeCallbacks.add(callback);
    return () => {
      this.themeChangeCallbacks.delete(callback);
    };
  }
}
