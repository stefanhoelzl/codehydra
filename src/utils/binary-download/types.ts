/**
 * Types for binary download operations.
 */

/**
 * Supported archive extensions for binary downloads.
 */
export type ArchiveExtension = ".tar.gz" | ".tgz" | ".zip";

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
  /**
   * Units processed so far: bytes downloaded (downloading phase), or extraction
   * progress (extracting phase) — compressed bytes for tar, entry count for zip.
   */
  bytesDownloaded: number;
  /**
   * Total units to process: Content-Length (downloading, null if not provided),
   * or the extraction total (extracting) — archive size for tar, entry count for
   * zip. null when unknown.
   */
  totalBytes: number | null;
}

/**
 * Callback for download progress updates.
 */
export type DownloadProgressCallback = (progress: DownloadProgress) => void;

/** Fields every download request carries. */
interface DownloadRequestBase {
  /** Name for logging and temp file naming */
  readonly name: string;
  /** Download URL */
  readonly url: string;
  /** Destination directory */
  readonly destDir: string;
  /**
   * Expected SHA-256 of the downloaded bytes (hex). Checked before anything is
   * written, so a mismatch leaves nothing on disk.
   */
  readonly sha256?: string;
}

/** Download an archive and extract it into `destDir`. */
export interface ArchiveDownloadRequest extends DownloadRequestBase {
  /** Archive extension for temp file naming (e.g., ".tar.gz", ".zip") */
  readonly archiveExtension: ArchiveExtension;
  /** Relative path to chmod +x on Unix (optional) */
  readonly executablePath?: string;
  /** Subpath within the extracted archive to promote to destDir root. */
  readonly subPath?: string;
}

/** Download a single executable and save it as `destDir/executablePath`. */
export interface FileDownloadRequest extends DownloadRequestBase {
  readonly archiveExtension?: undefined;
  /** File name inside `destDir`; made executable on Unix. */
  readonly executablePath: string;
}

/**
 * Request to download a binary: an archive to extract, or (no
 * `archiveExtension`) a single executable file.
 */
export type DownloadRequest = ArchiveDownloadRequest | FileDownloadRequest;
