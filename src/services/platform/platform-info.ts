/**
 * Platform information provider.
 * Abstracts process.platform, process.arch, and os.homedir() for testability.
 */

/**
 * Supported CPU architectures.
 */
export type SupportedArch = "x64" | "arm64";

export interface PlatformInfo {
  /** Operating system platform: 'linux', 'darwin', 'win32' */
  readonly platform: NodeJS.Platform;

  /** CPU architecture: 'x64' or 'arm64' */
  readonly arch: SupportedArch;

  /** User's home directory */
  readonly homeDir: string;
}
