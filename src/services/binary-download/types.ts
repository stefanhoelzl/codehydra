/**
 * Types for binary download operations.
 */

import type { SupportedArch } from "../platform/platform-info.js";

// Re-export SupportedArch from platform-info to avoid duplication
export type { SupportedArch };

/**
 * Binary types supported for download.
 */
export type BinaryType = "code-server" | "opencode";

/**
 * Supported operating system platforms.
 */
export type SupportedPlatform = "darwin" | "linux" | "win32";

/**
 * Progress information for binary downloads.
 */
export interface DownloadProgress {
  /** Number of bytes downloaded so far */
  bytesDownloaded: number;
  /** Total bytes to download, null if Content-Length not provided */
  totalBytes: number | null;
}

/**
 * Callback for download progress updates.
 */
export type DownloadProgressCallback = (progress: DownloadProgress) => void;

/**
 * Configuration for a downloadable binary.
 */
export interface BinaryConfig {
  /** Type of binary (code-server or opencode) */
  readonly type: BinaryType;
  /** Version string (e.g., "4.106.3") */
  readonly version: string;
  /** Get the download URL for a specific platform and architecture */
  readonly getUrl: (platform: SupportedPlatform, arch: SupportedArch) => string;
  /** Get the relative path to the binary executable within the extracted directory */
  readonly extractedBinaryPath: (platform: SupportedPlatform) => string;
}
