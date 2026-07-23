/**
 * Type conversion utilities for workspace types.
 *
 * Three Workspace shapes exist, and this module is the boundary between them:
 * - Internal (`boundaries/platform/git-types`): `{ name, path: Path, branch, metadata }` —
 *   a `Path` instance, so it is backend-local and cannot cross a tunnel.
 * - Discovered (`intents/contract`): the same fields with a branded `WorkspacePath` string.
 *   This is what a `discover` / `list-workspaces` hook contributes.
 * - IPC (`intents/contract`): adds `projectId` and the optional IDE `url`.
 *
 * `toDiscoveredWorkspace` is the single place a `Path` becomes contract data.
 */

import type { Workspace as InternalWorkspace } from "../boundaries/platform/git-types";
import type {
  DiscoveredWorkspace,
  Workspace as IpcWorkspace,
  ProjectId,
} from "../intents/contract";
import { discoveredWorkspaceSchema } from "../intents/contract";

/**
 * Convert an internal workspace to its plain-data contract form.
 *
 * Parses rather than asserts: this is where a `Path` instance leaves the backend, so the
 * brands are minted by validation instead of by a cast.
 */
export function toDiscoveredWorkspace(internal: InternalWorkspace): DiscoveredWorkspace {
  return discoveredWorkspaceSchema.parse({
    name: internal.name,
    path: internal.path.toString(),
    branch: internal.branch,
    metadata: internal.metadata,
  });
}

/** Convert an array of internal workspaces to their plain-data contract form. */
export function toDiscoveredWorkspaces(
  internals: readonly InternalWorkspace[]
): DiscoveredWorkspace[] {
  return internals.map(toDiscoveredWorkspace);
}

/**
 * Convert a discovered Workspace to an IPC Workspace for sending to the renderer.
 *
 * @param discovered - Discovered workspace (already plain data)
 * @param projectId - Project ID to include in IPC workspace
 */
function toIpcWorkspace(discovered: DiscoveredWorkspace, projectId: ProjectId): IpcWorkspace {
  return {
    projectId,
    name: discovered.name,
    path: discovered.path,
    branch: discovered.branch,
    metadata: discovered.metadata,
  };
}

/**
 * Convert an array of discovered Workspaces to IPC Workspaces.
 *
 * @param discovered - Array of discovered workspaces
 * @param projectId - Project ID to include in all IPC workspaces
 * @returns Array of IPC workspaces
 */
export function toIpcWorkspaces(
  discovered: readonly DiscoveredWorkspace[],
  projectId: ProjectId
): IpcWorkspace[] {
  return discovered.map((w) => toIpcWorkspace(w, projectId));
}
