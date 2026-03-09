/**
 * Auto-update service for the application.
 *
 * Uses electron-updater directly (singleton with Electron lifecycle integration).
 * Separates detection from download: checkForUpdates() detects, downloadUpdate()
 * downloads on demand, quitAndInstall() restarts the app.
 *
 * Platform support:
 * - Windows (NSIS): Full auto-update
 * - macOS (DMG): Full auto-update
 * - Linux (AppImage): Full auto-update
 * - Windows (portable), Linux (.deb/.rpm): Not supported - start() is no-op
 */

import { autoUpdater } from "electron-updater";
import type { Logger } from "./logging";

/**
 * Callback type for update detected events (update-available, before download).
 * @param version - The version string of the detected update
 */
export type UpdateDetectedCallback = (version: string) => void;

/**
 * Callback type for update downloaded events (download complete).
 * @param version - The version string of the downloaded update
 */
export type UpdateDownloadedCallback = (version: string) => void;

/**
 * Callback type for download progress events.
 */
export type DownloadProgressCallback = (info: { percent: number }) => void;

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
 * - Detection via checkForUpdates() (fires onUpdateDetected)
 * - Manual download via downloadUpdate() (fires onDownloadProgress, onUpdateDownloaded)
 * - Install via quitAndInstall()
 * - Error handling (log but don't crash)
 */
export class AutoUpdater {
  private readonly logger: Logger;
  private readonly isDevelopment: boolean;
  private readonly detectedCallbacks: Set<UpdateDetectedCallback> = new Set();
  private readonly downloadedCallbacks: Set<UpdateDownloadedCallback> = new Set();
  private readonly progressCallbacks: Set<DownloadProgressCallback> = new Set();
  private disposed = false;
  private downloadCancelled = false;

  constructor(deps: AutoUpdaterDeps) {
    this.logger = deps.logger;
    this.isDevelopment = deps.isDevelopment;

    if (!this.isDevelopment) {
      // Configure electron-updater
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = false;

      // Route electron-updater logs through app logger
      autoUpdater.logger = {
        info: (message) => this.logger.info(String(message ?? "")),
        warn: (message) => this.logger.warn(String(message ?? "")),
        error: (message) => this.logger.error(String(message ?? "")),
        debug: (message) => this.logger.debug(String(message ?? "")),
      };

      // Wire up event handlers
      this.handleError = this.handleError.bind(this);
      this.handleUpdateAvailable = this.handleUpdateAvailable.bind(this);
      this.handleUpdateDownloaded = this.handleUpdateDownloaded.bind(this);
      this.handleDownloadProgress = this.handleDownloadProgress.bind(this);

      autoUpdater.on("error", this.handleError);
      autoUpdater.on("update-available", this.handleUpdateAvailable);
      autoUpdater.on("update-downloaded", this.handleUpdateDownloaded);
      autoUpdater.on("download-progress", this.handleDownloadProgress);
    }
  }

  /**
   * Check for updates. Returns true if an update is available.
   * Does NOT start download — use downloadUpdate() for that.
   *
   * No-op returning false if:
   * - Running in development mode
   * - Platform doesn't support auto-updates (portable, deb, rpm)
   * - Already disposed
   */
  async checkForUpdates(): Promise<boolean> {
    if (this.isDevelopment) {
      this.logger.debug("Skipping update check (development mode)");
      return false;
    }

    if (this.disposed) return false;

    if (!this.isPlatformSupported()) return false;

    try {
      this.logger.info("Checking for updates");
      const found = await new Promise<boolean>((resolve) => {
        const onAvailable = (): void => {
          cleanup();
          resolve(true);
        };
        const onNotAvailable = (): void => {
          cleanup();
          resolve(false);
        };
        const cleanup = (): void => {
          autoUpdater.off("update-available", onAvailable);
          autoUpdater.off("update-not-available", onNotAvailable);
        };
        autoUpdater.on("update-available", onAvailable);
        autoUpdater.on("update-not-available", onNotAvailable);
        autoUpdater.checkForUpdates().catch(() => {
          cleanup();
          resolve(false);
        });
      });
      return found;
    } catch (error) {
      this.logger.warn("Update check failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Start downloading the update.
   * Fires onDownloadProgress callbacks during download and onUpdateDownloaded on completion.
   * Throws if cancelled via cancelDownload().
   */
  async downloadUpdate(): Promise<void> {
    if (this.isDevelopment || this.disposed) return;

    this.downloadCancelled = false;

    try {
      await autoUpdater.downloadUpdate();
      if (this.downloadCancelled) {
        throw new Error("Download cancelled");
      }
    } catch (error) {
      this.logger.warn("Update download failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Cancel an in-progress download.
   * Sets a flag that causes downloadUpdate() to throw on next check.
   */
  cancelDownload(): void {
    this.downloadCancelled = true;
  }

  /**
   * Quit the application and install the downloaded update.
   */
  quitAndInstall(): void {
    if (this.isDevelopment) return;

    this.logger.info("Quitting and installing update");
    autoUpdater.quitAndInstall(true, true);
  }

  /**
   * Start the auto-updater (legacy — just logs).
   * The check-deps hook now calls checkForUpdates() directly.
   */
  start(): void {
    if (this.isDevelopment) {
      this.logger.debug("Skipping auto-updater start (development mode)");
      return;
    }
    this.logger.debug("Auto-updater started");
  }

  /**
   * Register a callback for when an update is detected (before download).
   */
  onUpdateDetected(callback: UpdateDetectedCallback): () => void {
    this.detectedCallbacks.add(callback);
    return () => {
      this.detectedCallbacks.delete(callback);
    };
  }

  /**
   * Register a callback for when an update has been downloaded.
   */
  onUpdateDownloaded(callback: UpdateDownloadedCallback): () => void {
    this.downloadedCallbacks.add(callback);
    return () => {
      this.downloadedCallbacks.delete(callback);
    };
  }

  /**
   * Register a callback for download progress updates.
   */
  onDownloadProgress(callback: DownloadProgressCallback): () => void {
    this.progressCallbacks.add(callback);
    return () => {
      this.progressCallbacks.delete(callback);
    };
  }

  /**
   * Clean up event listeners and timers.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    // Remove event listeners (only registered when not in dev mode)
    if (!this.isDevelopment) {
      autoUpdater.off("error", this.handleError);
      autoUpdater.off("update-available", this.handleUpdateAvailable);
      autoUpdater.off("update-downloaded", this.handleUpdateDownloaded);
      autoUpdater.off("download-progress", this.handleDownloadProgress);
    }

    this.detectedCallbacks.clear();
    this.downloadedCallbacks.clear();
    this.progressCallbacks.clear();
    this.logger.debug("Auto-updater disposed");
  }

  private isPlatformSupported(): boolean {
    const platform = process.platform;
    const isAppImage = process.env.APPIMAGE !== undefined;
    const isNsis = platform === "win32";
    const isMac = platform === "darwin";

    if (platform === "linux" && !isAppImage) {
      this.logger.debug("Skipping update check (Linux non-AppImage)");
      return false;
    }

    if (!isNsis && !isMac && !isAppImage) {
      this.logger.debug("Skipping update check (unsupported platform)", {
        platform,
      });
      return false;
    }

    return true;
  }

  /**
   * Handle update-available events — notify detected callbacks.
   * Does NOT start download (autoDownload is false).
   */
  private handleUpdateAvailable(info: { version: string }): void {
    this.logger.info("Update detected", { version: info.version });
    for (const callback of this.detectedCallbacks) {
      try {
        callback(info.version);
      } catch (error) {
        this.logger.warn("Update detected callback error", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Handle electron-updater error events.
   */
  private handleError(error: Error): void {
    this.logger.warn("Auto-update error", {
      error: error.message,
    });
  }

  /**
   * Handle download-progress events.
   */
  private handleDownloadProgress(info: { percent: number }): void {
    for (const callback of this.progressCallbacks) {
      try {
        callback(info);
      } catch (error) {
        this.logger.warn("Download progress callback error", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Handle update-downloaded events.
   */
  private handleUpdateDownloaded(info: { version: string }): void {
    this.logger.info("Update downloaded", { version: info.version });
    for (const callback of this.downloadedCallbacks) {
      try {
        callback(info.version);
      } catch (error) {
        this.logger.warn("Update downloaded callback error", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
