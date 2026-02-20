/**
 * Shared utilities for CodeHydra workspace names.
 */
import type { WorkspaceName } from "./types";

/**
 * Extract the workspace name from a workspace path.
 * The workspace name is the basename of the path.
 *
 * Handles both forward slashes and backslashes for cross-platform compatibility.
 *
 * @param workspacePath Absolute path to the workspace directory
 * @returns The workspace name (basename of the path)
 *
 * @example
 * ```typescript
 * extractWorkspaceName("/home/user/projects/.worktrees/feature-1") // "feature-1"
 * extractWorkspaceName("C:\\Users\\projects\\.worktrees\\feature-1") // "feature-1"
 * ```
 */
export function extractWorkspaceName(workspacePath: string): WorkspaceName {
  // Handle both forward and backward slashes
  const normalized = workspacePath.replace(/\\/g, "/");
  // Remove trailing slash if present
  const trimmed = normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
  // Get basename (last segment)
  const lastSlash = trimmed.lastIndexOf("/");
  const basename = lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed;
  return basename as WorkspaceName;
}
