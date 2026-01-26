/**
 * Auto-update service for the application.
 *
 * Uses electron-updater directly (singleton with Electron lifecycle integration).
 * Checks once per app session at startup, downloads in background, applies on next app quit.
 *
 * Platform support:
 * - Windows (NSIS): Full auto-update
 * - macOS (DMG): Full auto-update
 * - Linux (AppImage): Full auto-update
 * - Windows (portable), Linux (.deb/.rpm): Not supported - start() is no-op
 */

import { autoUpdater } from "electron-updater";
import type { Logger } from "./logging";

/** Delay before update check (avoid startup I/O contention) */
const STARTUP_DELAY_MS = 10 * 1000;

/**
 * Callback type for update available events.
 * @param version - The version string of the available update
 */
export type UpdateAvailableCallback = (version: string) => void;

/**
 * Auto-updater service dependencies.
 */
export interface AutoUpdaterDeps {
  readonly logger: Logger;
  readonly isDevelopment: boolean;
}

/**
 * Auto-updater service.
 *
 * Wraps electron-updater to provide:
 * - Single check per app session (after startup delay)
 * - Error handling (log but don't crash)
 * - Callback for update-downloaded events
 */
export class AutoUpdater {
  private readonly logger: Logger;
  private readonly isDevelopment: boolean;
  private readonly callbacks: Set<UpdateAvailableCallback> = new Set();
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(deps: AutoUpdaterDeps) {
    this.logger = deps.logger;
    this.isDevelopment = deps.isDevelopment;

    // Configure update feed URL if build-time values are provided
    if (__UPDATE_PROVIDER__ && __UPDATE_OWNER__ && __UPDATE_REPO__) {
      autoUpdater.setFeedURL({
        provider: __UPDATE_PROVIDER__ as "github",
        owner: __UPDATE_OWNER__,
        repo: __UPDATE_REPO__,
      });
    }

    // Configure electron-updater
    // autoInstallOnAppQuit is true by default
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    // Wire up event handlers
    this.handleError = this.handleError.bind(this);
    this.handleUpdateDownloaded = this.handleUpdateDownloaded.bind(this);

    autoUpdater.on("error", this.handleError);
    autoUpdater.on("update-downloaded", this.handleUpdateDownloaded);
  }

  /**
   * Start the auto-updater.
   *
   * No-op if:
   * - Running in development mode
   * - Platform doesn't support auto-updates (portable, deb, rpm)
   */
  start(): void {
    // Skip in development mode
    if (this.isDevelopment) {
      this.logger.debug("Skipping update check (development mode)");
      return;
    }

    // Skip on unsupported platforms
    // electron-updater handles this internally, but we log it for clarity
    const platform = process.platform;
    const isAppImage = process.env.APPIMAGE !== undefined;
    const isNsis = platform === "win32"; // NSIS is the only Windows target
    const isMac = platform === "darwin";

    if (platform === "linux" && !isAppImage) {
      this.logger.debug("Skipping update check (Linux non-AppImage)");
      return;
    }

    if (!isNsis && !isMac && !isAppImage) {
      this.logger.debug("Skipping update check (unsupported platform)", {
        platform,
      });
      return;
    }

    // Wait before first check to avoid competing with startup I/O
    this.logger.debug("Scheduling update check", {
      delayMs: STARTUP_DELAY_MS,
    });

    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.checkForUpdates();
    }, STARTUP_DELAY_MS);
  }

  /**
   * Register a callback for when an update is downloaded and ready.
   *
   * @param callback - Called with version string when update is ready
   * @returns Unsubscribe function
   */
  onUpdateAvailable(callback: UpdateAvailableCallback): () => void {
    this.callbacks.add(callback);
    return () => {
      this.callbacks.delete(callback);
    };
  }

  /**
   * Clean up event listeners and timers.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    // Clear startup timer if pending
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }

    // Remove event listeners
    autoUpdater.off("error", this.handleError);
    autoUpdater.off("update-downloaded", this.handleUpdateDownloaded);

    this.callbacks.clear();
    this.logger.debug("Auto-updater disposed");
  }

  /**
   * Check for updates.
   */
  private async checkForUpdates(): Promise<void> {
    if (this.disposed) return;

    try {
      this.logger.info("Checking for updates");
      await autoUpdater.checkForUpdates();
    } catch (error) {
      // Log but don't throw - updates are non-critical
      this.logger.warn("Update check failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Handle electron-updater error events.
   */
  private handleError(error: Error): void {
    // Log but don't crash - updates are non-critical
    this.logger.warn("Auto-update error", {
      error: error.message,
    });
  }

  /**
   * Handle update-downloaded events.
   */
  private handleUpdateDownloaded(info: { version: string }): void {
    this.logger.info("Update downloaded", { version: info.version });

    // Notify all registered callbacks
    for (const callback of this.callbacks) {
      try {
        callback(info.version);
      } catch (error) {
        this.logger.warn("Update callback error", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
