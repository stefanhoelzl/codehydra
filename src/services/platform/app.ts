/**
 * AppLayer - Abstraction over Electron's app module.
 *
 * Provides an injectable interface for app-level operations, enabling:
 * - Unit testing with behavioral mocks
 * - Boundary testing against real Electron app
 * - Platform-specific behavior handling (dock on macOS, badges on Linux)
 */

import type { Logger } from "../logging";

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

/**
 * App path names that can be queried.
 */
export type AppPathName =
  | "home"
  | "appData"
  | "userData"
  | "sessionData"
  | "temp"
  | "exe"
  | "desktop"
  | "documents"
  | "downloads"
  | "music"
  | "pictures"
  | "videos"
  | "logs";

// ============================================================================
// Interface
// ============================================================================

/**
 * Abstraction over Electron's app module.
 *
 * Platform-specific behavior:
 * - `dock` is only available on macOS (undefined on other platforms)
 * - `setBadgeCount` works on Linux Unity launcher only
 */
export interface AppLayer {
  /**
   * macOS-specific dock API.
   * Returns undefined on non-macOS platforms.
   */
  readonly dock: AppDock | undefined;

  /**
   * Set the app badge count.
   * Works on Linux Unity launcher. No-op on Windows/macOS.
   *
   * @param count - Badge count (0 to clear)
   * @returns true if successful, false otherwise
   */
  setBadgeCount(count: number): boolean;

  /**
   * Get a special directory or file path.
   *
   * @param name - Name of the path to get
   * @returns The path string
   */
  getPath(name: AppPathName): string;

  /**
   * Append a switch to Chromium's command line.
   *
   * @param key - Switch name
   * @param value - Optional switch value
   */
  commandLineAppendSwitch(key: string, value?: string): void;
}

// ============================================================================
// Default Implementation
// ============================================================================

import { app } from "electron";

/**
 * Default implementation of AppLayer using Electron's app module.
 */
export class DefaultAppLayer implements AppLayer {
  readonly dock: AppDock | undefined;

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

  setBadgeCount(count: number): boolean {
    const result = app.setBadgeCount(count);
    this.logger.debug("Badge count set", { count, success: result });
    return result;
  }

  getPath(name: AppPathName): string {
    return app.getPath(name);
  }

  commandLineAppendSwitch(key: string, value?: string): void {
    if (value !== undefined) {
      app.commandLine.appendSwitch(key, value);
      this.logger.debug("Command line switch appended", { key, value });
    } else {
      app.commandLine.appendSwitch(key);
      this.logger.debug("Command line switch appended", { key });
    }
  }
}
