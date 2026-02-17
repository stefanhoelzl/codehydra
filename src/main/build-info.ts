/**
 * Electron implementation of BuildInfo.
 * isDevelopment is set at build time via __IS_DEV_BUILD__.
 * isPackaged is determined at runtime via app.isPackaged.
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
 * BuildInfo implementation using build-time and runtime Electron flags.
 *
 * - isDevelopment: Set at build time via __IS_DEV_BUILD__ (true for non-release builds)
 * - isPackaged: Set at runtime via app.isPackaged (true for packaged .app/.exe/.AppImage)
 *
 * When not packaged, also captures the git branch name for display in the window title.
 */
export class ElectronBuildInfo implements BuildInfo {
  readonly version: string;
  readonly isDevelopment: boolean;
  readonly isPackaged: boolean;
  readonly gitBranch?: string;
  readonly appPath: string;
  readonly resourcesPath?: string;

  constructor(gitBranchFn: () => string = getGitBranch) {
    // Cache at construction time - these values should never change during runtime
    // __APP_VERSION__ is injected by Vite at build time (git-based versioning)
    this.version = __APP_VERSION__;
    this.isDevelopment = __IS_DEV_BUILD__;
    this.isPackaged = app.isPackaged;

    if (!this.isPackaged) {
      this.gitBranch = gitBranchFn();
    }

    // Use app.getAppPath() for consistent resolution across dev/prod
    // In dev: returns project root (same as process.cwd())
    // In prod: returns path inside ASAR archive
    this.appPath = app.getAppPath();

    // Resources path for external process access (outside ASAR)
    // Only set when packaged - unpackaged mode accesses files directly from appPath
    if (this.isPackaged) {
      this.resourcesPath = process.resourcesPath;
    }
  }
}
