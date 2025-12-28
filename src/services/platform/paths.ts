/**
 * Platform-specific path utilities for the application.
 *
 * NOTE: Build-mode-dependent path functions have been moved to PathProvider.
 * Use DefaultPathProvider (or inject PathProvider) for paths like:
 * - dataRootDir
 * - projectsDir
 * - vscodeDir, vscodeExtensionsDir, vscodeUserDataDir
 * - vscodeSetupMarkerPath
 * - electronDataDir
 * - getProjectWorkspacesDir()
 *
 * This file contains only pure utility functions with no build-mode dependencies.
 */

import { createHash } from "crypto";
import path, { basename } from "path";

// ============================================================================
// Path Normalization
// ============================================================================

/**
 * Options for path normalization.
 */
export interface NormalizePathOptions {
  /** Convert backslashes to forward slashes (for cross-platform consistency). Default: false */
  forwardSlashes?: boolean;
  /** Remove trailing path separator. Default: true */
  stripTrailing?: boolean;
}

/**
 * Normalize a path with configurable options.
 *
 * @param p - The path to normalize
 * @param options - Normalization options
 * @returns Normalized path
 *
 * @example
 * ```typescript
 * normalizePath("/foo/bar/")          // "/foo/bar"
 * normalizePath("C:\\foo\\bar\\", { forwardSlashes: true }) // "C:/foo/bar"
 * normalizePath("/foo/bar/", { stripTrailing: false })      // "/foo/bar/"
 * ```
 */
export function normalizePath(p: string, options?: NormalizePathOptions): string {
  const { forwardSlashes = false, stripTrailing = true } = options ?? {};

  let result = path.normalize(p);

  if (forwardSlashes) {
    result = result.replace(/\\/g, "/");
    // Collapse any remaining double forward slashes (edge case after conversion)
    result = result.replace(/\/+/g, "/");
  }

  if (
    stripTrailing &&
    result.length > 1 &&
    (result.endsWith(path.sep) || (forwardSlashes && result.endsWith("/")))
  ) {
    result = result.slice(0, -1);
  }

  return result;
}

// ============================================================================
// Project/Workspace Naming
// ============================================================================

/**
 * Generate a directory name for a project based on its path.
 * Format: `<folder-name>-<8-char-sha256-hash>`
 *
 * @param projectPath Absolute path to the project
 * @returns Deterministic directory name
 */
export function projectDirName(projectPath: string): string {
  const folderName = basename(projectPath);
  const hash = createHash("sha256").update(projectPath).digest("hex").substring(0, 8);
  return `${folderName}-${hash}`;
}

/**
 * Sanitize a workspace name for filesystem use.
 * Replaces `/` with `%` to allow branch names like `feature/my-feature`.
 *
 * @param name Workspace or branch name
 * @returns Filesystem-safe name
 */
export function sanitizeWorkspaceName(name: string): string {
  return name.replace(/\//g, "%");
}

/**
 * Encode a file path for use in URLs.
 * Percent-encodes special characters while preserving path structure.
 *
 * @param path File path to encode
 * @returns URL-safe path
 */
export function encodePathForUrl(filePath: string): string {
  // Split by both path separators, encode each segment, rejoin with forward slashes
  return filePath
    .split(/[/\\]/)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}
