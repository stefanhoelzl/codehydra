/**
 * Types for KeepFilesService.
 *
 * KeepFilesService copies files matching patterns in .keepfiles from
 * project root to new workspaces.
 */

import type { Path } from "../platform/path";

/**
 * Interface for the KeepFiles service.
 */
export interface IKeepFilesService {
  /**
   * Copy files matching .keepfiles patterns from projectRoot to targetPath.
   *
   * @param projectRoot - Source directory containing .keepfiles
   * @param targetPath - Destination directory for copied files
   * @returns Result with counts and any errors encountered
   */
  copyToWorkspace(projectRoot: Path, targetPath: Path): Promise<CopyResult>;
}

/**
 * Result of a copyToWorkspace operation.
 */
export interface CopyResult {
  /** Whether .keepfiles config file exists in projectRoot */
  readonly configExists: boolean;
  /** Number of files/directories successfully copied */
  readonly copiedCount: number;
  /** Number of items skipped (symlinks, excluded by negation) */
  readonly skippedCount: number;
  /** Errors encountered during copying (doesn't stop other copies) */
  readonly errors: readonly CopyError[];
}

/**
 * Error encountered during a copy operation.
 */
export interface CopyError {
  /** Relative path that failed to copy */
  readonly path: string;
  /** Error message describing the failure */
  readonly message: string;
}
