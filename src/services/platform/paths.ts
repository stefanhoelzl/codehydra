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
 *
 * NOTE: Path normalization is now handled by the Path class (./path.ts).
 * Use `new Path(p).toString()` for normalized paths.
 */

import { createHash } from "crypto";
import { basename } from "path";

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
