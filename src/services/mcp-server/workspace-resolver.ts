/**
 * Workspace resolver for MCP server.
 *
 * Resolves workspace paths from MCP headers to project/workspace identifiers.
 * Uses Path class for cross-platform path handling.
 */

import type { McpResolvedWorkspace } from "./types";
import { generateProjectId, extractWorkspaceName } from "../../shared/api/id-utils";
import { Path } from "../platform/path";

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
 * Uses Path class for proper cross-platform normalization.
 * This ensures paths like "C:\foo" and "C:/foo" resolve to the same workspace.
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

  // Normalize the path using Path class for cross-platform consistency
  let normalizedPath: string;
  try {
    // Path constructor validates absolute paths and normalizes
    normalizedPath = new Path(workspacePath).toString();
  } catch {
    // Path constructor throws on relative or invalid paths
    return null;
  }

  // Find the project containing this workspace
  // AppState.findProjectForWorkspace also normalizes its input
  const project = appState.findProjectForWorkspace(normalizedPath);
  if (!project) {
    return null;
  }

  // Verify the workspace exists in the project
  // Workspaces in project are already normalized strings
  const workspace = project.workspaces.find((w) => w.path === normalizedPath);
  if (!workspace) {
    return null;
  }

  // Generate project ID (uses same normalization)
  const projectId = generateProjectId(project.path);

  // Extract workspace name from path basename
  const workspaceName = extractWorkspaceName(normalizedPath);

  return {
    projectId,
    workspaceName,
    workspacePath: normalizedPath,
  };
}
