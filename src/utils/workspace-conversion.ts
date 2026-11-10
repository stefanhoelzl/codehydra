/**
 * Type conversion utilities for workspace types.
 *
 * Three Workspace shapes exist, and this module is the boundary between them:
 * - Registered ({@link RegisteredWorkspace}): `{ name, path: Path, metadata }` plus the
 *   type's description — a `Path` instance, so it is backend-local and cannot cross a tunnel.
 * - Discovered (`intents/contract`): the same fields with a branded `WorkspacePath` string.
 *   This is what a `discover` / `list-workspaces` hook contributes.
 * - IPC (`intents/contract`): adds the workspace's `ref`, `projectId` and the optional IDE `url`.
 *
 * `toDiscoveredWorkspace` is the single place a `Path` becomes contract data.
 */

import type {
  DiscoveredWorkspace,
  Workspace as IpcWorkspace,
  ProjectId,
  ProjectRef,
  WorkspaceDescription,
} from "../intents/contract";
import { discoveredWorkspaceSchema } from "../intents/contract";
import type { Path } from "./path/path";
import { makeWorkspaceRef } from "./ref";

/**
 * A workspace as its project type reports it to the core registry: its name,
 * its directory, its metadata (what its file holds) and how the type describes
 * it (`subtitle`, `subtitleIcon`, `details` — see `workspaceDescriptionShape`).
 */
export interface RegisteredWorkspace extends WorkspaceDescription {
  readonly name: string;
  readonly path: Path;
  readonly metadata: Readonly<Record<string, string>>;
}

/** The description fields of `from`, each only when present. */
export function descriptionOf(from: WorkspaceDescription): WorkspaceDescription {
  return {
    ...(from.subtitle !== undefined && { subtitle: from.subtitle }),
    ...(from.subtitleIcon !== undefined && { subtitleIcon: from.subtitleIcon }),
    ...(from.details !== undefined && { details: from.details }),
  };
}

/**
 * Convert a registered workspace to its plain-data contract form.
 *
 * Parses rather than asserts: this is where a `Path` instance leaves the backend, so the
 * brands are minted by validation instead of by a cast.
 */
export function toDiscoveredWorkspace(internal: RegisteredWorkspace): DiscoveredWorkspace {
  return discoveredWorkspaceSchema.parse({
    name: internal.name,
    path: internal.path.toString(),
    ...descriptionOf(internal),
    metadata: internal.metadata,
  });
}

/** Convert an array of registered workspaces to their plain-data contract form. */
export function toDiscoveredWorkspaces(
  internals: readonly RegisteredWorkspace[]
): DiscoveredWorkspace[] {
  return internals.map(toDiscoveredWorkspace);
}

/**
 * Convert a discovered Workspace to an IPC Workspace for sending to the renderer.
 *
 * @param discovered - Discovered workspace (already plain data)
 * @param projectId - Project ID to include in IPC workspace
 * @param projectRef - Ref of the project, which the workspace's ref extends
 */
export function toIpcWorkspace(
  discovered: DiscoveredWorkspace,
  projectId: ProjectId,
  projectRef: ProjectRef
): IpcWorkspace {
  return {
    ref: makeWorkspaceRef(projectRef, discovered.name),
    projectId,
    name: discovered.name,
    path: discovered.path,
    ...descriptionOf(discovered),
    metadata: discovered.metadata,
  };
}

/**
 * Convert an array of discovered Workspaces to IPC Workspaces.
 *
 * @param discovered - Array of discovered workspaces
 * @param projectId - Project ID to include in all IPC workspaces
 * @param projectRef - Ref of the project, which every workspace's ref extends
 * @returns Array of IPC workspaces
 */
export function toIpcWorkspaces(
  discovered: readonly DiscoveredWorkspace[],
  projectId: ProjectId,
  projectRef: ProjectRef
): IpcWorkspace[] {
  return discovered.map((w) => toIpcWorkspace(w, projectId, projectRef));
}
