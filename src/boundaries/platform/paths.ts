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
import { Path } from "../../utils/path/path";
import { extractRepoName, normalizeGitUrl } from "../../utils/url-utils";

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
 * Directory name for a project CodeHydra cloned from a URL (a managed project).
 * Format: `<repo-name>-<8-char-sha256-of-normalized-url>`
 *
 * Derived from the URL, never from where the clone sits, so it names the same
 * project wherever the clone moves. It names both the clone's own directory
 * (`remotes/<id>/<repo>`) and the project's record (`projects/<id>/config.json`).
 *
 * @param url Git URL, already expanded (`expandGitUrl`)
 */
export function managedProjectDirName(url: string): string {
  const safeName =
    extractRepoName(url)
      .replace(/[^a-zA-Z0-9]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "repo";
  const hash = createHash("sha256").update(normalizeGitUrl(url)).digest("hex").substring(0, 8);
  return `${safeName}-${hash}`;
}

/**
 * Where a managed project's clone lives: `<remotesDir>/<managedProjectDirName>/<repo-name>`.
 * The clone path is also the project's path.
 *
 * @param remotesDir Directory managed clones are kept in
 * @param url Git URL, already expanded (`expandGitUrl`)
 */
export function managedClonePath(remotesDir: Path | string, url: string): Path {
  return new Path(remotesDir, managedProjectDirName(url), extractRepoName(url));
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
 * Reverse the sanitization of a workspace name.
 * Replaces `%` with `/` to recover the original branch name.
 *
 * Safe because `%` is not in the workspace name character set — only sanitized names contain it.
 *
 * @param name Sanitized filesystem name
 * @returns Original workspace/branch name
 */
export function unsanitizeWorkspaceName(name: string): string {
  return name.replace(/%/g, "/");
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
