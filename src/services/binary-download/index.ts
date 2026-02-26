/**
 * Binary download module public API.
 */

// Types
export type {
  SupportedPlatform,
  SupportedArch,
  DownloadProgress,
  DownloadProgressCallback,
  DownloadRequest,
} from "./types.js";

// Errors
export type { BinaryDownloadErrorCode, ArchiveErrorCode } from "./errors.js";
export { BinaryDownloadError, ArchiveError } from "./errors.js";

// Archive extractor
export type { ArchiveExtractor } from "./archive-extractor.js";
export { TarExtractor, ZipExtractor, DefaultArchiveExtractor } from "./archive-extractor.js";

// Binary download service
export type { BinaryDownloadService } from "./binary-download-service.js";
export { DefaultBinaryDownloadService } from "./binary-download-service.js";

// Agent binary manager
export type {
  AgentBinaryConfig,
  AgentBinaryPreflightResult,
  AgentBinaryPreflightError,
  AgentBinaryType,
} from "./agent-binary-manager.js";
export { AgentBinaryManager } from "./agent-binary-manager.js";

// Test utilities
export { createArchiveExtractorMock } from "./archive-extractor.state-mock.js";
export type { MockArchiveExtractor } from "./archive-extractor.state-mock.js";
export { createMockBinaryDownloadService } from "./binary-download-service.test-utils.js";
export type { MockBinaryDownloadService } from "./binary-download-service.test-utils.js";
