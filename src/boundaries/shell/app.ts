/**
 * AppBoundary - Abstraction over Electron's app module.
 *
 * Provides an injectable interface for app-level operations, enabling:
 * - Unit testing with behavioral mocks
 * - Boundary testing against real Electron app
 * - Platform-specific behavior handling (dock on macOS, badges on Linux)
 */

import type { Logger } from "../platform/logging";
import { pathToFileURL } from "node:url";

/**
 * Function to unsubscribe from an event.
 */
export type Unsubscribe = () => void;

// ============================================================================
// Types
// ============================================================================

/**
 * Dock API for macOS.
 * Only available on macOS platform.
 */
export interface AppDock {
  /**
   * Set the dock badge text.
   * @param text - Badge text (empty string to clear)
   */
  setBadge(text: string): void;
}

// ============================================================================
// Interface
// ============================================================================

/**
 * Abstraction over Electron's app module.
 *
 * Platform-specific behavior:
 * - `dock` is only available on macOS (undefined on other platforms)
 */
export interface AppBoundary {
  /**
   * macOS-specific dock API.
   * Returns undefined on non-macOS platforms.
   */
  readonly dock: AppDock | undefined;

  /**
   * Open a URL in the system's default handler (browser for http/https, mail client for mailto).
   *
   * @param url - URL to open
   */
  openUrl(url: string): Promise<void>;

  /**
   * Open a local file path in the system's default handler.
   * Converts the path to a file:// URI internally.
   *
   * @param filePath - Absolute path to the file or folder
   */
  openPath(filePath: string): Promise<void>;

  /**
   * Control whether the OS is allowed to enter power-saving / sleep.
   *
   * Wraps Electron's `powerSaveBlocker`, owning a single blocker internally:
   * - `allow = false` starts a `prevent-display-sleep` blocker (if not already active),
   *   keeping the system and display awake.
   * - `allow = true` stops the active blocker (if any), letting the OS sleep normally.
   *
   * Idempotent: repeated calls with the same value are no-ops (never start a
   * second blocker, never double-stop).
   *
   * @param allow - true to permit OS sleep, false to prevent it
   */
  allowPowerSaving(allow: boolean): void;

  /**
   * Relaunch the app: schedule a fresh instance to start on exit, then quit the
   * current one. Used by the settings dialog's "Save & Restart" to apply
   * restart-scoped config changes.
   */
  relaunch(): void;

  /**
   * Whether the OS is currently using a dark color scheme.
   */
  shouldUseDarkColors(): boolean;

  /**
   * Subscribe to OS theme change events.
   *
   * @param callback - Called whenever the OS theme changes
   * @returns Unsubscribe function
   */
  onThemeUpdated(callback: () => void): Unsubscribe;
}

// ============================================================================
// Default Implementation
// ============================================================================

import { app, shell, nativeTheme, powerSaveBlocker } from "electron";

/**
 * Default implementation of AppBoundary using Electron's app module.
 */
export class DefaultAppBoundary implements AppBoundary {
  readonly dock: AppDock | undefined;

  /** Id of the active power-save blocker, or null when sleep is allowed. */
  private powerBlockerId: number | null = null;

  constructor(private readonly logger: Logger) {
    // app.dock is only available on macOS
    if (process.platform === "darwin" && app.dock) {
      this.dock = {
        setBadge: (text: string) => {
          app.dock?.setBadge(text);
          this.logger.debug("Dock badge set", { text });
        },
      };
    }
  }

  async openUrl(url: string): Promise<void> {
    await shell.openExternal(url);
  }

  async openPath(filePath: string): Promise<void> {
    await shell.openExternal(pathToFileURL(filePath).href);
  }

  allowPowerSaving(allow: boolean): void {
    if (allow) {
      if (this.powerBlockerId !== null) {
        if (powerSaveBlocker.isStarted(this.powerBlockerId)) {
          powerSaveBlocker.stop(this.powerBlockerId);
        }
        this.logger.debug("Power saving allowed (sleep blocker released)", {
          id: this.powerBlockerId,
        });
        this.powerBlockerId = null;
      }
      return;
    }

    if (this.powerBlockerId !== null && powerSaveBlocker.isStarted(this.powerBlockerId)) {
      return; // Already preventing sleep
    }
    this.powerBlockerId = powerSaveBlocker.start("prevent-display-sleep");
    this.logger.debug("Power saving prevented (display-sleep blocker started)", {
      id: this.powerBlockerId,
    });
  }

  relaunch(): void {
    this.logger.info("Relaunching app");
    app.relaunch();
    app.quit();
  }

  shouldUseDarkColors(): boolean {
    return nativeTheme.shouldUseDarkColors;
  }

  onThemeUpdated(callback: () => void): Unsubscribe {
    nativeTheme.on("updated", callback);
    return () => {
      nativeTheme.off("updated", callback);
    };
  }
}
