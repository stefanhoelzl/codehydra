/**
 * Build/environment information provider.
 * Interface defined in services, implementation provided by main process.
 */
export interface BuildInfo {
  /**
   * Application version string (from __APP_VERSION__, injected by Vite at build time).
   */
  readonly version: string;

  /**
   * Whether this is a development (non-release) build.
   * Set at build time via __IS_DEV_BUILD__ (sourced from CODEHYDRA_RELEASE env var).
   * - true: Local dev and CI dev builds
   * - false: Release builds
   */
  readonly isDevelopment: boolean;

  /**
   * Whether the app is running as a packaged Electron app.
   * Determined at runtime via app.isPackaged.
   * - true: Packaged .app/.exe/.AppImage (including CI dev builds)
   * - false: Running via electron-vite dev
   */
  readonly isPackaged: boolean;

  /**
   * Git branch name (only populated when not packaged).
   * Used to display branch in window title for developer convenience.
   * - Unpackaged: current branch name, or "unknown branch" if git fails
   * - Packaged: undefined
   */
  readonly gitBranch?: string;

  /**
   * Application root path for locating bundled resources.
   * - Unpackaged: process.cwd() (project root)
   * - Packaged: app.getAppPath() (inside ASAR archive)
   */
  readonly appPath: string;

  /**
   * Path to application resources directory (outside ASAR).
   * Used for files that need external process access (scripts, extensions).
   * - Unpackaged: undefined (use appPath-relative paths directly)
   * - Packaged: process.resourcesPath (extraResources destination)
   */
  readonly resourcesPath?: string;
}
