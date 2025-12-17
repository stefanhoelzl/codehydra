/**
 * Test utilities for BinaryDownloadService.
 */

// Note: BinaryDownloadService is referenced in type comments only
import type { BinaryType, DownloadProgressCallback } from "./types";
import type { BinaryDownloadErrorCode } from "./errors";
import { BinaryDownloadError } from "./errors";
import { vi, type Mock } from "vitest";

/**
 * Options for creating a mock BinaryDownloadService.
 */
export interface MockBinaryDownloadServiceOptions {
  /**
   * If set, isInstalled returns this value for all binaries.
   */
  installed?: boolean;

  /**
   * Per-binary installed status.
   */
  installedBinaries?: Record<BinaryType, boolean>;

  /**
   * If set, download throws this error.
   */
  downloadError?: {
    message: string;
    code: BinaryDownloadErrorCode;
  };

  /**
   * Custom binary paths to return.
   */
  binaryPaths?: Record<BinaryType, string>;
}

/**
 * Mock BinaryDownloadService with spies on all methods.
 */
export interface MockBinaryDownloadService {
  isInstalled: Mock<(binary: BinaryType) => Promise<boolean>>;
  download: Mock<(binary: BinaryType, onProgress?: DownloadProgressCallback) => Promise<void>>;
  getBinaryPath: Mock<(binary: BinaryType) => string>;
  createWrapperScripts: Mock<() => Promise<void>>;
}

/**
 * Create a mock BinaryDownloadService with controllable behavior.
 *
 * @param options - Configuration for the mock
 * @returns Mock BinaryDownloadService with spies
 */
export function createMockBinaryDownloadService(
  options: MockBinaryDownloadServiceOptions = {}
): MockBinaryDownloadService {
  const defaultPaths: Record<BinaryType, string> = {
    "code-server": "/app-data/code-server/4.106.3/bin/code-server",
    opencode: "/app-data/opencode/0.1.47/opencode",
  };

  return {
    isInstalled: vi.fn(async (binary: BinaryType): Promise<boolean> => {
      if (options.installedBinaries) {
        return options.installedBinaries[binary] ?? false;
      }
      return options.installed ?? false;
    }),

    download: vi.fn(async (): Promise<void> => {
      if (options.downloadError) {
        throw new BinaryDownloadError(options.downloadError.message, options.downloadError.code);
      }
    }),

    getBinaryPath: vi.fn((binary: BinaryType): string => {
      if (options.binaryPaths) {
        return options.binaryPaths[binary] ?? defaultPaths[binary];
      }
      return defaultPaths[binary];
    }),

    createWrapperScripts: vi.fn(async (): Promise<void> => {}),
  };
}
