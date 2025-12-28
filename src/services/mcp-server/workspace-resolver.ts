/**
 * Workspace resolver for MCP server.
 *
 * Resolves workspace paths from MCP headers to project/workspace identifiers.
 */

import * as path from "node:path";
import type { McpResolvedWorkspace } from "./types";
import { generateProjectId, extractWorkspaceName } from "../../shared/api/id-utils";

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
): McpResolvedWorkspace | null {
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
  const workspaceName = extractWorkspaceName(normalizedPath);

  return {
    projectId,
    workspaceName,
    workspacePath: normalizedPath,
  };
}
