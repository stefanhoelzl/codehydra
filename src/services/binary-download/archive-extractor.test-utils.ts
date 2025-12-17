/**
 * Test utilities for ArchiveExtractor.
 */

import type { ArchiveExtractor } from "./archive-extractor";
import type { ArchiveErrorCode } from "./errors";
import { ArchiveError } from "./errors";
import { vi, type Mock } from "vitest";

/**
 * Options for creating a mock archive extractor.
 */
export interface MockArchiveExtractorOptions {
  /**
   * If provided, the extract method will reject with this error.
   */
  error?: {
    message: string;
    code: ArchiveErrorCode;
  };
}

/**
 * Mock ArchiveExtractor type with spy on extract.
 */
export interface MockArchiveExtractor {
  extract: Mock<(archivePath: string, destDir: string) => Promise<void>>;
}

/**
 * Create a mock ArchiveExtractor with controllable behavior.
 *
 * @param options - Configuration for the mock
 * @returns Mock ArchiveExtractor with a spy on extract
 */
export function createMockArchiveExtractor(
  options: MockArchiveExtractorOptions = {}
): MockArchiveExtractor {
  return {
    extract: vi.fn(async (): Promise<void> => {
      if (options.error) {
        throw new ArchiveError(options.error.message, options.error.code);
      }
    }),
  };
}

/**
 * Type guard to check if an extractor is a mock.
 */
export function isMockArchiveExtractor(
  extractor: ArchiveExtractor | MockArchiveExtractor
): extractor is MockArchiveExtractor {
  return "mock" in extractor.extract;
}
