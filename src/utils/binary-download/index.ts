/**
 * Binary download utility module.
 */

// Types
export type {
  ArchiveDownloadRequest,
  ArchiveExtension,
  DownloadPhase,
  DownloadProgress,
  DownloadProgressCallback,
  DownloadRequest,
  FileDownloadRequest,
} from "./types.js";

// Download functions
export type { DownloadDeps } from "./download.js";
export { downloadBinary, isBinaryInstalled } from "./download.js";

// Platform guards
export { assertWindowsX64 } from "./platform.js";
