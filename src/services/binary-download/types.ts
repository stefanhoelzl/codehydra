/**
 * Types for binary download operations.
 */

import type { SupportedArch } from "../platform/platform-info.js";

// Re-export SupportedArch from platform-info to avoid duplication
export type { SupportedArch };

/**
 * Binary types supported for download.
 */
export type BinaryType = "code-server" | "opencode" | "claude";

/**
 * Supported operating system platforms.
 */
export type SupportedPlatform = "darwin" | "linux" | "win32";

/**
 * Phase of the download/extract operation.
 */
export type DownloadPhase = "downloading" | "extracting";

/**
 * Progress information for binary downloads.
 */
export interface DownloadProgress {
  /** Current phase of operation */
  phase: DownloadPhase;
  /** Number of bytes downloaded so far (only for downloading phase) */
  bytesDownloaded: number;
  /** Total bytes to download, null if Content-Length not provided (only for downloading phase) */
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
  /** Type of binary (code-server, opencode, or claude) */
  readonly type: BinaryType;
  /**
   * Version string (e.g., "4.106.3") or null.
   * When null, the version should be fetched dynamically using getLatestVersion().
   */
  readonly version: string | null;
  /** Get the download URL for a specific platform and architecture */
  readonly getUrl: (platform: SupportedPlatform, arch: SupportedArch) => string;
  /** Get the relative path to the binary executable within the extracted directory */
  readonly extractedBinaryPath: (platform: SupportedPlatform) => string;
}
