/**
 * Platform information provider.
 * Abstracts process.platform and os.homedir() for testability.
 */
export interface PlatformInfo {
  /** Operating system platform: 'linux', 'darwin', 'win32' */
  readonly platform: NodeJS.Platform;

  /** User's home directory */
  readonly homeDir: string;
}
