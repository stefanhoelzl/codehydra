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
}
