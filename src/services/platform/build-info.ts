/**
 * Build/environment information provider.
 * Interface defined in services, implementation provided by main process.
 */
export interface BuildInfo {
  /**
   * Whether the app is running in development mode.
   * - true: Development (unpackaged, via electron-vite dev)
   * - false: Production (packaged .app/.exe/.AppImage)
   */
  readonly isDevelopment: boolean;

  /**
   * Git branch name (only populated in development mode).
   * Used to display branch in window title for developer convenience.
   * - In dev mode: current branch name, or "unknown branch" if git fails
   * - In prod mode: undefined
   */
  readonly gitBranch?: string;

  /**
   * Application root path for locating bundled resources.
   * - In dev mode: process.cwd() (project root)
   * - In prod mode: app.getAppPath() (inside ASAR archive)
   */
  readonly appPath: string;
}
