/**
 * Shared ID generation utilities for CodeHydra.
 *
 * This module provides deterministic ID generation for projects.
 * It's shared between main process and services to avoid duplication.
 */
import * as crypto from "node:crypto";
import * as path from "node:path";
import type { ProjectId, WorkspaceName } from "./types";

/**
 * Generate a deterministic ProjectId from an absolute path.
 *
 * The ID format is: `<safe-name>-<8-char-hex-hash>`
 * - safe-name: basename with special characters replaced by dashes
 * - hash: first 8 characters of SHA-256 hash of normalized path
 *
 * @param absolutePath Absolute path to the project directory
 * @returns A deterministic ProjectId
 *
 * @example
 * ```typescript
 * generateProjectId("/home/user/projects/my-app") // "my-app-12345678"
 * generateProjectId("/home/user/My Cool App")     // "My-Cool-App-abcdef12"
 * ```
 */
export function generateProjectId(absolutePath: string): ProjectId {
  // Normalize the path (handles double slashes, dot segments)
  // Also remove trailing slashes for consistent hashing
  let normalizedPath = path.normalize(absolutePath);
  if (normalizedPath.length > 1 && normalizedPath.endsWith(path.sep)) {
    normalizedPath = normalizedPath.slice(0, -1);
  }

  // Get basename
  const basename = path.basename(normalizedPath);

  // Create safe name:
  // 1. Replace non-alphanumeric characters with dashes
  // 2. Collapse consecutive dashes
  // 3. Remove leading/trailing dashes
  // 4. Use "root" as fallback for empty result
  const safeName =
    basename
      .replace(/[^a-zA-Z0-9]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "root";

  // Generate hash from normalized path
  const hash = crypto.createHash("sha256").update(normalizedPath).digest("hex").slice(0, 8);

  return `${safeName}-${hash}` as ProjectId;
}

/**
 * Extract the workspace name from a workspace path.
 * The workspace name is the basename of the path.
 *
 * @param workspacePath Absolute path to the workspace directory
 * @returns The workspace name (basename of the path)
 *
 * @example
 * ```typescript
 * extractWorkspaceName("/home/user/projects/.worktrees/feature-1") // "feature-1"
 * ```
 */
export function extractWorkspaceName(workspacePath: string): WorkspaceName {
  return path.basename(workspacePath) as WorkspaceName;
}
