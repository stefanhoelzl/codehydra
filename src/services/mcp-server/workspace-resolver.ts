/**
 * Workspace resolver for MCP server.
 *
 * Resolves workspace paths from MCP headers to project/workspace identifiers.
 */

import * as path from "node:path";
import * as crypto from "node:crypto";
import type { ResolvedWorkspace } from "./types";
import type { ProjectId, WorkspaceName } from "../../shared/api/types";

/**
 * Interface for AppState workspace lookup.
 * Subset of AppState needed for workspace resolution.
 */
export interface WorkspaceLookup {
  /**
   * Find the project containing a workspace by its path.
   * @param workspacePath - Absolute path to the workspace
   * @returns Project object with path and workspaces, or undefined if not found
   */
  findProjectForWorkspace(
    workspacePath: string
  ): { path: string; workspaces: readonly { path: string }[] } | undefined;
}

/**
 * Generate a deterministic ProjectId from an absolute path.
 * Duplicated from id-utils to avoid circular dependencies.
 *
 * @param absolutePath Absolute path to the project directory
 * @returns A deterministic ProjectId
 */
function generateProjectId(absolutePath: string): ProjectId {
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
 * Resolve a workspace path to project and workspace identifiers.
 *
 * @param workspacePath - The workspace path from MCP header
 * @param appState - AppState or WorkspaceLookup for finding the project
 * @returns ResolvedWorkspace if found, null if not a managed workspace
 *
 * @example
 * ```typescript
 * const resolved = resolveWorkspace("/path/to/workspace", appState);
 * if (resolved) {
 *   // Use resolved.projectId, resolved.workspaceName, resolved.workspacePath
 * }
 * ```
 */
export function resolveWorkspace(
  workspacePath: string,
  appState: WorkspaceLookup
): ResolvedWorkspace | null {
  // Validate input is a non-empty string
  if (typeof workspacePath !== "string" || workspacePath.length === 0) {
    return null;
  }

  // Normalize the path
  let normalizedPath: string;
  try {
    normalizedPath = path.normalize(workspacePath);
  } catch {
    // path.normalize can throw on malformed paths
    return null;
  }

  // Must be an absolute path
  if (!path.isAbsolute(normalizedPath)) {
    return null;
  }

  // Find the project containing this workspace
  const project = appState.findProjectForWorkspace(normalizedPath);
  if (!project) {
    return null;
  }

  // Verify the workspace exists in the project
  const workspace = project.workspaces.find((w) => w.path === normalizedPath);
  if (!workspace) {
    return null;
  }

  // Generate project ID
  const projectId = generateProjectId(project.path);

  // Extract workspace name from path basename
  const workspaceName = path.basename(normalizedPath) as WorkspaceName;

  return {
    projectId,
    workspaceName,
    workspacePath: normalizedPath,
  };
}
