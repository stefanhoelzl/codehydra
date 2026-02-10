/**
 * Binary download module public API.
 */

// Types
export type {
  BinaryType,
  SupportedPlatform,
  SupportedArch,
  DownloadProgress,
  DownloadProgressCallback,
  BinaryConfig,
} from "./types.js";

// Errors
export type { BinaryDownloadErrorCode, ArchiveErrorCode } from "./errors.js";
export { BinaryDownloadError, ArchiveError } from "./errors.js";

// Version constants
export { CODE_SERVER_VERSION, OPENCODE_VERSION, BINARY_CONFIGS } from "./versions.js";

// Archive extractor
export type { ArchiveExtractor } from "./archive-extractor.js";
export { TarExtractor, ZipExtractor, DefaultArchiveExtractor } from "./archive-extractor.js";

// Binary download service
export type { BinaryDownloadService } from "./binary-download-service.js";
export { DefaultBinaryDownloadService } from "./binary-download-service.js";

// Agent binary manager
export type {
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
