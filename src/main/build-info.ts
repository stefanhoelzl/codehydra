/**
 * Electron implementation of BuildInfo.
 * Uses Electron's app.isPackaged to determine build mode.
 */

import { execSync } from "node:child_process";
import { app } from "electron";
import type { BuildInfo } from "../services/platform/build-info";

/**
 * Get the current git branch name synchronously.
 * Returns "unknown branch" if git command fails (not a repo, git not installed, etc.).
 *
 * Exported for testing purposes.
 *
 * @returns Current branch name or "unknown branch" on failure
 */
export function getGitBranch(): string {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      encoding: "utf-8",
      timeout: 1000,
      stdio: ["pipe", "pipe", "pipe"], // Suppress stderr output
    }).trim();
  } catch {
    return "unknown branch";
  }
}

/**
 * BuildInfo implementation using Electron's app.isPackaged.
 *
 * - app.isPackaged = false → isDevelopment = true (running via electron-vite dev)
 * - app.isPackaged = true → isDevelopment = false (packaged app)
 *
 * In development mode, also captures the git branch name for display in the window title.
 */
export class ElectronBuildInfo implements BuildInfo {
  readonly isDevelopment: boolean;
  readonly gitBranch?: string;
  readonly appPath: string;

  constructor(gitBranchFn: () => string = getGitBranch) {
    // Cache at construction time - these values should never change during runtime
    this.isDevelopment = !app.isPackaged;

    if (this.isDevelopment) {
      this.gitBranch = gitBranchFn();
    }

    // Use app.getAppPath() for consistent resolution across dev/prod
    // In dev: returns project root (same as process.cwd())
    // In prod: returns path inside ASAR archive
    this.appPath = app.getAppPath();
  }
}
