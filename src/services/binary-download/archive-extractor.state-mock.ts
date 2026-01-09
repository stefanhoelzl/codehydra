/**
 * Behavioral mock for ArchiveExtractor following the mock.$ state pattern.
 *
 * Provides:
 * - Extraction history tracking
 * - Per-path error configuration
 * - Custom matchers (toHaveExtracted, toHaveNoExtractions)
 *
 * Matchers are auto-registered when this module is imported.
 */

import { expect } from "vitest";
import type { ArchiveExtractor } from "./archive-extractor";
import type { ArchiveErrorCode } from "./errors";
import { ArchiveError } from "./errors";
import { Path } from "../platform/path";
import type {
  MockState,
  MockWithState,
  Snapshot,
  MatcherResult,
  MatcherImplementationsFor,
} from "../../test/state-mock";

// =============================================================================
// Type Definitions
// =============================================================================

/** Record of an extraction operation performed through the mock. */
export interface ExtractionRecord {
  readonly archivePath: string;
  readonly destDir: string;
  readonly timestamp: number;
}

/** Configuration for an extraction result. */
export interface ExtractionResult {
  readonly error?: {
    readonly message: string;
    readonly code: ArchiveErrorCode;
  };
}

/** Mock state - pure data, logic in matchers. */
export interface ArchiveExtractorMockState extends MockState {
  readonly extractions: readonly ExtractionRecord[];
}

/** Mock type with state access. */
export type MockArchiveExtractor = ArchiveExtractor & MockWithState<ArchiveExtractorMockState>;

/** Factory options. */
export interface MockArchiveExtractorOptions {
  /** Pre-configured results by normalized path. */
  results?: Record<string, ExtractionResult>;
  /** Default result for unconfigured paths. Default: success (no error) */
  defaultResult?: ExtractionResult;
}

// =============================================================================
// Factory Implementation
// =============================================================================

/**
 * Create a behavioral mock ArchiveExtractor for testing.
 *
 * @example Basic usage - succeeds for all extractions
 * const extractor = createArchiveExtractorMock();
 * await extractor.extract("/tmp/app.tar.gz", "/opt/app");
 * expect(extractor).toHaveExtracted("/tmp/app.tar.gz", "/opt/app");
 *
 * @example Error case - all extractions fail
 * const extractor = createArchiveExtractorMock({
 *   defaultResult: { error: { message: "Corrupt", code: "INVALID_ARCHIVE" } },
 * });
 * await expect(extractor.extract("/bad.zip", "/dest")).rejects.toThrow();
 * expect(extractor).toHaveNoExtractions();
 *
 * @example Per-path configuration
 * const extractor = createArchiveExtractorMock({
 *   results: {
 *     "/bad.zip": { error: { message: "Invalid", code: "INVALID_ARCHIVE" } },
 *   },
 * });
 * await extractor.extract("/good.tar.gz", "/dest1"); // succeeds
 * await expect(extractor.extract("/bad.zip", "/dest2")).rejects.toThrow();
 * expect(extractor).toHaveExtracted("/good.tar.gz", "/dest1");
 */
export function createArchiveExtractorMock(
  options?: MockArchiveExtractorOptions
): MockArchiveExtractor {
  // Internal mutable state
  const extractions: ExtractionRecord[] = [];

  // Normalize results keys using Path for cross-platform consistency
  const results = new Map<string, ExtractionResult>();
  if (options?.results) {
    for (const [path, result] of Object.entries(options.results)) {
      const normalizedPath = new Path(path).toString();
      results.set(normalizedPath, result);
    }
  }

  const defaultResult: ExtractionResult = options?.defaultResult ?? {};

  // Helper to record an extraction
  function recordExtraction(archivePath: string, destDir: string): void {
    extractions.push({
      archivePath,
      destDir,
      timestamp: Date.now(),
    });
  }

  // State object implementing MockState
  const state: ArchiveExtractorMockState = {
    get extractions(): readonly ExtractionRecord[] {
      return extractions;
    },
    snapshot(): Snapshot {
      return {
        __brand: "Snapshot" as const,
        value: this.toString(),
      };
    },
    toString(): string {
      const count = extractions.length;
      const paths = extractions.map((e) => `${e.archivePath} -> ${e.destDir}`).join(", ");
      return `${count} extraction(s): ${paths || "(none)"}`;
    },
  };

  // Create the mock object
  const mock: MockArchiveExtractor = {
    $: state,

    async extract(archivePath: string, destDir: Path): Promise<void> {
      // Normalize the archive path for lookup
      const normalizedArchivePath = new Path(archivePath).toString();
      const normalizedDestDir = destDir.toString();

      // Get configured result (or default)
      const result = results.get(normalizedArchivePath) ?? defaultResult;

      // If error is configured, throw without recording
      if (result.error) {
        throw new ArchiveError(result.error.message, result.error.code);
      }

      // Record successful extraction
      recordExtraction(normalizedArchivePath, normalizedDestDir);
    },
  };

  return mock;
}

// =============================================================================
// Custom Matchers
// =============================================================================

/** Custom matchers for MockArchiveExtractor assertions. */
interface ArchiveExtractorMatchers {
  /** Assert that a specific archive was extracted to a destination. */
  toHaveExtracted(archivePath: string, destDir: string): void;
  /** Assert that no extractions were performed. */
  toHaveNoExtractions(): void;
}

// Module augmentation for vitest
declare module "vitest" {
  interface Assertion<T> extends ArchiveExtractorMatchers {}
}

/** Matcher implementations. */
export const archiveExtractorMatchers: MatcherImplementationsFor<
  MockArchiveExtractor,
  ArchiveExtractorMatchers
> = {
  toHaveExtracted(received, archivePath, destDir) {
    const extractions = received.$.extractions;

    // Normalize expected paths using Path for cross-platform consistency
    const normalizedArchivePath = new Path(archivePath).toString();
    const normalizedDestDir = new Path(destDir).toString();

    const pass = extractions.some(
      (e) => e.archivePath === normalizedArchivePath && e.destDir === normalizedDestDir
    );

    return {
      pass,
      message: (): string => {
        const recorded =
          extractions.map((e) => `${e.archivePath} -> ${e.destDir}`).join(", ") || "(none)";
        return pass
          ? `Expected not to have extracted ${archivePath} to ${destDir}, but did. Extractions: ${recorded}`
          : `Expected to have extracted ${archivePath} to ${destDir}, but didn't. Extractions: ${recorded}`;
      },
    } satisfies MatcherResult;
  },

  toHaveNoExtractions(received) {
    const count = received.$.extractions.length;
    const pass = count === 0;

    return {
      pass,
      message: (): string => {
        const recorded = received.$.extractions
          .map((e) => `${e.archivePath} -> ${e.destDir}`)
          .join(", ");
        return pass
          ? `Expected to have extractions, but had none`
          : `Expected no extractions, but had ${count}: ${recorded}`;
      },
    } satisfies MatcherResult;
  },
};

// Auto-register matchers when this module is imported
expect.extend(archiveExtractorMatchers);
