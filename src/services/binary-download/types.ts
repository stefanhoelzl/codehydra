/**
 * Types for binary download operations.
 */

import type { SupportedArch } from "../platform/platform-info.js";

// Re-export SupportedArch from platform-info to avoid duplication
export type { SupportedArch };

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
 * Request to download and extract a binary.
 */
export interface DownloadRequest {
  /** Name for logging and temp file naming */
  readonly name: string;
  /** Download URL */
  readonly url: string;
  /** Extraction destination directory */
  readonly destDir: string;
  /** Relative path to chmod +x on Unix (optional) */
  readonly executablePath?: string;
  /** Subpath within the extracted archive to promote to destDir root. */
  readonly subPath?: string;
}
