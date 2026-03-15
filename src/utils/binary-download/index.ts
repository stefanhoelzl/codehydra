/**
 * Binary download utility module.
 */

// Types
export type {
  ArchiveExtension,
  DownloadPhase,
  DownloadProgress,
  DownloadProgressCallback,
  DownloadRequest,
} from "./types.js";

// Download functions
export type { DownloadDeps } from "./download.js";
export { downloadBinary, isBinaryInstalled } from "./download.js";
