/**
 * Test utilities for BinaryDownloadService.
 */

import type { DownloadRequest, DownloadProgressCallback } from "./types";
import type { BinaryDownloadErrorCode } from "./errors";
import { BinaryDownloadError } from "./errors";
import { vi, type Mock } from "vitest";

/**
 * Options for creating a mock BinaryDownloadService.
 */
export interface MockBinaryDownloadServiceOptions {
  /**
   * If set, isInstalled returns this value for all directories.
   */
  installed?: boolean;

  /**
   * If set, download throws this error.
   */
  downloadError?: {
    message: string;
    code: BinaryDownloadErrorCode;
  };
}

/**
 * Mock BinaryDownloadService with spies on all methods.
 */
export interface MockBinaryDownloadService {
  isInstalled: Mock<(destDir: string) => Promise<boolean>>;
  download: Mock<
    (request: DownloadRequest, onProgress?: DownloadProgressCallback) => Promise<void>
  >;
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
  return {
    isInstalled: vi.fn(async (): Promise<boolean> => {
      return options.installed ?? false;
    }),

    download: vi.fn(async (): Promise<void> => {
      if (options.downloadError) {
        throw new BinaryDownloadError(options.downloadError.message, options.downloadError.code);
      }
    }),
  };
}
