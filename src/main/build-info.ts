/**
 * Electron implementation of BuildInfo.
 * Uses Electron's app.isPackaged to determine build mode.
 */

import { app } from "electron";
import type { BuildInfo } from "../services/platform/build-info";

/**
 * BuildInfo implementation using Electron's app.isPackaged.
 *
 * - app.isPackaged = false → isDevelopment = true (running via electron-vite dev)
 * - app.isPackaged = true → isDevelopment = false (packaged app)
 */
export class ElectronBuildInfo implements BuildInfo {
  readonly isDevelopment: boolean;

  constructor() {
    // Cache at construction time - this value should never change during runtime
    this.isDevelopment = !app.isPackaged;
  }
}
