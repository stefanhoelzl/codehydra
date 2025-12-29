/**
 * Type conversion utilities for workspace types.
 *
 * Two Workspace types exist in the codebase:
 * - Internal Workspace (git/types.ts): { name, path: Path, branch, metadata } - no projectId
 * - IPC Workspace (shared/api/types.ts): { projectId, name, path: string, branch, metadata } - has projectId
 *
 * These utilities bridge the gap by converting between internal Path-based types
 * and IPC string-based types at the boundary.
 */

import type { Workspace as InternalWorkspace } from "../../services/git/types";
import type { Workspace as IpcWorkspace, ProjectId, WorkspaceName } from "../../shared/api/types";

/**
 * Convert internal Workspace to IPC Workspace for sending to renderer.
 *
 * @param internal - Internal workspace with Path-based path
 * @param projectId - Project ID to include in IPC workspace
 * @returns IPC workspace with string-based path
 */
export function toIpcWorkspace(internal: InternalWorkspace, projectId: ProjectId): IpcWorkspace {
  return {
    projectId,
    name: internal.name as WorkspaceName,
    path: internal.path.toString(),
    branch: internal.branch,
    metadata: internal.metadata,
  };
}

/**
 * Convert an array of internal Workspaces to IPC Workspaces.
 *
 * @param internals - Array of internal workspaces
 * @param projectId - Project ID to include in all IPC workspaces
 * @returns Array of IPC workspaces
 */
export function toIpcWorkspaces(
  internals: readonly InternalWorkspace[],
  projectId: ProjectId
): IpcWorkspace[] {
  return internals.map((internal) => toIpcWorkspace(internal, projectId));
}
