/**
 * Types for binary resolution operations.
 */

import type { Path } from "../platform/path";

/**
 * Binary types that can be resolved.
 */
export type ResolvableBinaryType = "code-server" | "opencode" | "claude";

/**
 * Source of a resolved binary.
 */
export type BinarySource = "system" | "downloaded" | "not-found";

/**
 * Result of binary resolution.
 */
export interface BinaryResolution {
  /** Whether the binary is available */
  readonly available: boolean;
  /** Source of the binary (system, downloaded, or not-found) */
  readonly source: BinarySource;
  /** Path to the binary (only if available) */
  readonly path?: Path;
  /** Version of the binary (only if available and known) */
  readonly version?: string;
}

/**
 * Resolution options for a binary.
 */
export interface ResolutionOptions {
  /** If set, use this exact version (skip system check) */
  readonly pinnedVersion?: string;
}
