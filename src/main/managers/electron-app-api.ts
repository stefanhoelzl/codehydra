/**
 * Electron app API abstraction for testability.
 * Wraps Electron's app module methods used for badge management.
 */

import { app } from "electron";

/**
 * Dock API subset for badge management.
 */
export interface DockApi {
  /**
   * Sets the dock badge text.
   * @param badge - The badge text (empty string to clear)
   */
  setBadge(badge: string): void;
}

/**
 * Interface for Electron's app module badge-related methods.
 * Abstracts the Electron app module for dependency injection and testability.
 */
export interface ElectronAppApi {
  /**
   * macOS-specific dock API.
   * Only available on macOS.
   */
  readonly dock: DockApi | undefined;

  /**
   * Sets the app badge count.
   * Works on Linux (Unity launcher only).
   * @param count - The badge count (0 to clear)
   * @returns Whether the call was successful
   */
  setBadgeCount(count: number): boolean;
}

/**
 * Default implementation that wraps the actual Electron app module.
 */
export class DefaultElectronAppApi implements ElectronAppApi {
  readonly dock: DockApi | undefined;

  constructor() {
    // app.dock is only available on macOS
    if (process.platform === "darwin" && app.dock) {
      this.dock = {
        setBadge: (badge: string) => app.dock?.setBadge(badge),
      };
    }
  }

  /**
   * Sets the app badge count (Linux Unity).
   */
  setBadgeCount(count: number): boolean {
    return app.setBadgeCount(count);
  }
}
